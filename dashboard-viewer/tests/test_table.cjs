const test = require("node:test");
const assert = require("node:assert/strict");

test("table search matches text, numbers and hidden links without changing the source", async () => {
  const { tableRows } = await import("../src/table.js");
  const rows = Object.freeze([
    Object.freeze({
      title: "Apartment",
      price: 250000,
      url: "https://olx.ba/42",
    }),
    Object.freeze({ title: "House", price: null, url: "https://olx.ba/43" }),
  ]);
  assert.strictEqual(tableRows(rows, "", null), rows);
  assert.deepEqual(tableRows(rows, "APART", null), [rows[0]]);
  assert.deepEqual(tableRows(rows, "250", null), [rows[0]]);
  assert.deepEqual(tableRows(rows, "/43", null), [rows[1]]);
  assert.deepEqual(tableRows(rows, "absent", null), []);
});

test("table sorting preserves numeric and natural text order in both directions", async () => {
  const { tableRows } = await import("../src/table.js");
  const rows = Object.freeze([
    { title: "Listing 10", price: 200 },
    { title: "Listing 2", price: 10 },
    { title: "Listing 1", price: 80 },
  ]);
  assert.deepEqual(tableRows(rows, "", { column: "title", direction: 1 }), [
    rows[2],
    rows[1],
    rows[0],
  ]);
  assert.deepEqual(tableRows(rows, "", { column: "price", direction: -1 }), [
    rows[0],
    rows[2],
    rows[1],
  ]);
  assert.deepEqual(
    tableRows(rows, "LISTING", { column: "price", direction: 1 }),
    [rows[1], rows[2], rows[0]],
  );
});

test("table sorting handles missing and mixed values and keeps equal rows stable", async () => {
  const { tableRows } = await import("../src/table.js");
  const rows = Object.freeze([
    { value: "10" },
    { value: null },
    {},
    { value: 2 },
    { value: "2" },
    { value: "Četiri" },
    { value: "Alpha" },
  ]);
  for (const direction of [1, -1]) {
    const expected = [...rows].sort(
      (a, b) =>
        (typeof a.value === "number" && typeof b.value === "number"
          ? a.value - b.value
          : String(a.value ?? "").localeCompare(
              String(b.value ?? ""),
              undefined,
              {
                numeric: true,
              },
            )) * direction,
    );
    assert.deepEqual(
      tableRows(rows, "", { column: "value", direction }),
      expected,
    );
  }
  assert.deepEqual(tableRows([], "", { column: "value", direction: 1 }), []);
});
