'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { rentContext } = require('./setup');

const g = rentContext();

// ── normRooms ─────────────────────────────────────────────────────────────────

describe('normRooms', () => {
  test('null → null',          () => assert.equal(g.normRooms(null),  null));
  test('undefined → null',     () => assert.equal(g.normRooms(undefined), null));
  test('non-numeric → null',   () => assert.equal(g.normRooms('abc'), null));
  test('0 → "0" (garsonjera)', () => assert.equal(g.normRooms(0),    '0'));
  test('"0" → "0"',            () => assert.equal(g.normRooms('0'),   '0'));
  test('1 → "1"',              () => assert.equal(g.normRooms(1),     '1'));
  test('"2" → "2"',            () => assert.equal(g.normRooms('2'),   '2'));
  test('3 → "3"',              () => assert.equal(g.normRooms(3),     '3'));
  test('4 → "4+"',             () => assert.equal(g.normRooms(4),     '4+'));
  test('5 → "4+"',             () => assert.equal(g.normRooms(5),     '4+'));
  test('10 → "4+"',            () => assert.equal(g.normRooms(10),    '4+'));
});

// ── estimateRent — no data ────────────────────────────────────────────────────

describe('estimateRent: no data', () => {
  test('null rentStats → null estimate', () => {
    const r = g.estimateRent('2', 60, null);
    assert.equal(r.est, null);
    assert.equal(r.method, 'nema podataka');
  });

  test('empty listings → null estimate', () => {
    const r = g.estimateRent('2', 60, { listings: [] });
    assert.equal(r.est, null);
  });
});

// ── estimateRent — Pass 1: k-NN with sqm ─────────────────────────────────────

describe('estimateRent: kNN with exact room match + sqm', () => {
  const listings = [
    { rooms: '2', sqm: 55, price: 600 },
    { rooms: '2', sqm: 60, price: 650 },
    { rooms: '2', sqm: 65, price: 700 },
    { rooms: '2', sqm: 70, price: 750 },
    { rooms: '2', sqm: 80, price: 800 },
  ];
  const rentStats = { listings };

  test('nearest neighbour picked for exact sqm match', () => {
    const r = g.estimateRent('2', 60, rentStats);
    assert.equal(r.est != null, true);
    // 60m² matches listings[1] exactly → est should be close to 650
    assert.ok(r.est >= 600 && r.est <= 700, `est ${r.est} should be near 650`);
  });

  test('returns up to K=5 neighbours', () => {
    const r = g.estimateRent('2', 63, rentStats);
    assert.ok(r.neighbours.length <= 5);
    assert.ok(r.neighbours.length > 0);
  });

  test('neighbours sorted nearest-first', () => {
    const r = g.estimateRent('2', 60, rentStats);
    const dists = r.neighbours.map(n => Math.abs(n.sqm - 60));
    for (let i = 1; i < dists.length; i++) {
      assert.ok(dists[i] >= dists[i-1], 'neighbours not sorted by distance');
    }
  });

  test('inverse-distance-weighting: exact match dominates', () => {
    // sqm=55 is in the list — should be very close to that price (600)
    const r = g.estimateRent('2', 55, rentStats);
    assert.ok(r.est >= 580 && r.est <= 650, `est ${r.est} should be ~600`);
  });

  test('method string mentions room type and sqm range', () => {
    const r = g.estimateRent('2', 60, rentStats);
    assert.ok(r.method.includes('2-sob'), 'method should mention room type');
    assert.ok(r.method.includes('m²'), 'method should mention sqm');
  });
});

// ── estimateRent — Pass 2: bucket median (no sqm) ────────────────────────────

describe('estimateRent: bucket median when sqm unknown', () => {
  const listings = [
    { rooms: '3', sqm: 70, price: 700 },
    { rooms: '3', sqm: 80, price: 800 },
    { rooms: '3', sqm: 90, price: 900 },
  ];

  test('returns median when sqm is null', () => {
    const r = g.estimateRent('3', null, { listings });
    assert.equal(r.est, 800); // median of [700,800,900]
    assert.equal(r.neighbours.length, 0);
    assert.ok(r.method.includes('medijan'));
  });

  test('garsonjera label in method for room 0', () => {
    const garsonStats = { listings: [{ rooms: '0', sqm: 30, price: 400 }, { rooms: '0', sqm: 35, price: 450 }] };
    const r = g.estimateRent('0', null, garsonStats);
    assert.ok(r.method.includes('garsonjera'));
  });
});

// ── estimateRent — Pass 3: cross-room sqm fallback ───────────────────────────

describe('estimateRent: cross-room sqm fallback', () => {
  const listings = [
    { rooms: '1', sqm: 45, price: 500 },
    { rooms: '2', sqm: 55, price: 600 },
  ];

  test('falls back to sqm ±20% when no room match', () => {
    // rooms='3' has no match, but sqm=50 is within ±20% of sqm=45 (38-54) and sqm=55 (44-66)
    const r = g.estimateRent('3', 50, { listings });
    assert.ok(r.est != null, 'should have estimate via sqm fallback');
    assert.ok(r.method.includes('sličan m²'));
  });

  test('no sqm match returns null', () => {
    // sqm=200 is far from both 45 and 55 — ±20% gives 160-240, no match
    const r = g.estimateRent('3', 200, { listings });
    assert.equal(r.est, null);
  });
});

// ── estimateRent — real-world scenario ───────────────────────────────────────

describe('estimateRent: real-world 3-room 76m² scenario', () => {
  // Simulate the 275k apartment case from sessions
  const listings = Array.from({ length: 20 }, (_, i) => ({
    rooms: '3',
    sqm: 65 + i * 2, // 65-103m²
    price: 600 + i * 30, // 600-1170
  }));
  const rentStats = { listings };

  test('76m² 3-room estimate is in plausible range', () => {
    const r = g.estimateRent('3', 76, rentStats);
    assert.ok(r.est != null);
    assert.ok(r.est >= 500 && r.est <= 1500, `est ${r.est} out of range`);
  });

  test('estimate increases with sqm', () => {
    const r60 = g.estimateRent('3', 65, rentStats);
    const r90 = g.estimateRent('3', 95, rentStats);
    assert.ok(r90.est > r60.est, 'larger apt should have higher rent estimate');
  });
});

// ── normRooms: garsonjera/unknown contract used by summary-stats after fix ────

describe('normRooms: garsonjera included in room breakdowns after summary-stats fix', () => {
  test('rooms=0 → "0" so garsonjera is bucketed', () => assert.equal(g.normRooms(0), '0'));
  test('rooms="0" → "0"',                         () => assert.equal(g.normRooms('0'), '0'));
  test('garsonjera normRooms === "0"',             () => assert.strictEqual(g.normRooms(0), '0'));
});
