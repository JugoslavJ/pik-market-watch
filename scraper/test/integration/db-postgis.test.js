"use strict";

// Neighborhood assignment uses PostGIS containment and distance.
const test = require("node:test");
const assert = require("node:assert/strict");
const { needsDb, reset, setupDb } = require("../helpers/db.js");

let db;

test.before(async () => {
  db = await setupDb();
});
test.after(async () => {
  if (db) await db.close();
});
test.beforeEach(async () => {
  await reset(db.pool);
});

needsDb(
  "PostGIS neighborhood assignment includes a unique boundary point",
  async () => {
    const { rows } = await db.pool.query(`
      WITH boundary_points AS (
        SELECT n.name, points.geom AS point
          FROM public.neighborhoods n
          CROSS JOIN LATERAL ST_DumpPoints(ST_Boundary(n.boundary)) points
         WHERE n.boundary IS NOT NULL
      ), unique_points AS (
        SELECT bp.name, bp.point
          FROM boundary_points bp
         WHERE (
           SELECT count(*)
             FROM public.neighborhoods candidate
            WHERE candidate.boundary IS NOT NULL
              AND ST_Covers(candidate.boundary, bp.point)
         ) = 1
         ORDER BY bp.name, ST_X(bp.point), ST_Y(bp.point)
         LIMIT 1
      )
      SELECT name,
             public.neighborhood_of(ST_Y(point), ST_X(point)) AS mapped
        FROM unique_points`);

    assert.equal(rows.length, 1, "fixture must expose a unique boundary point");
    assert.equal(rows[0].mapped, rows[0].name);
  },
);

needsDb(
  "PostGIS neighborhood fallback uses geography metres within five kilometres",
  async () => {
    // Project a handful of points outside polygon coverage. The candidate
    // query chooses one that is outside every polygon but has a unique nearest
    // boundary within 5 km, making the expected result deterministic.
    const { rows } = await db.pool.query(`
      WITH centers AS (
        SELECT name, ST_PointOnSurface(boundary)::geography AS center
          FROM public.neighborhoods
         WHERE boundary IS NOT NULL
      ), candidates AS (
        SELECT c.name AS source_name,
               ST_Project(c.center, distance_m, radians(azimuth)) AS point
          FROM centers c
          CROSS JOIN (VALUES (1000::double precision),
                             (2500::double precision),
                             (4500::double precision)) distances(distance_m)
          CROSS JOIN generate_series(0, 7) azimuths(azimuth)
      ), outside AS (
        SELECT c.point
          FROM candidates c
         WHERE NOT EXISTS (
           SELECT 1
             FROM public.neighborhoods n
            WHERE n.boundary IS NOT NULL
              AND ST_Covers(n.boundary, c.point::geometry)
         )
         ORDER BY c.source_name, c.point::text
         LIMIT 1
      ), nearest AS (
        SELECT o.point,
               n.name,
               ST_Distance(n.boundary::geography, o.point) AS distance_m
          FROM outside o
          CROSS JOIN LATERAL (
            SELECT n.name, n.boundary, n.priority
              FROM public.neighborhoods n
             WHERE n.boundary IS NOT NULL
             ORDER BY ST_Distance(n.boundary::geography, o.point),
                      n.priority, n.name
             LIMIT 1
          ) n
         WHERE ST_DWithin(n.boundary::geography, o.point, 5000)
         ORDER BY distance_m, n.name
         LIMIT 1
      )
      SELECT name AS expected,
             public.neighborhood_of(
               ST_Y(point::geometry), ST_X(point::geometry)
             ) AS mapped,
             distance_m
        FROM nearest`);

    assert.equal(
      rows.length,
      1,
      "fixture must expose an outside point within 5 km",
    );
    assert.ok(Number(rows[0].distance_m) > 0);
    assert.ok(Number(rows[0].distance_m) <= 5000);
    assert.equal(rows[0].mapped, rows[0].expected);
  },
);
