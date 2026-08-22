'use strict';
// Unit tests for parseDetail()'s extended output: characteristics, publish
// date, seller type and view/favorite counters. Pure — no network, no database.
// Fixtures mirror the two channels the parser reads: Nuxt attr_code objects
// and rendered DOM text (verified against live olx.ba ad pages).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDetail } = require('../../src/parser');

// ── full apartment page: every known attr_code at once ───────────────────────

const APARTMENT_HTML = `
  <html><body>Stan, ne vikendica!
    Pregledi: 12.345
    Obnovljen: 21.08.2026 u 15:09
    Platinum PIK Shop
    Prosječno vrijeme odgovora 18 sati
    {id:1128,type:A,value:1636,attr_code:"okucnica-kvadratura",name:"Okućnica (kvadratura)"}
    {id:1101,type:A,value:72,attr_code:"kvadrata",name:"Kvadrata"}
    {id:1102,type:A,value:2,attr_code:"broj-soba",name:"Broj soba"}
    {id:1103,type:A,value:1,attr_code:"broj-kupatila",name:"Broj kupatila"}
    {id:1104,type:A,value:3,attr_code:"sprat",name:"Sprat"}
    {id:1105,type:A,value:6,attr_code:"ukupno-spratova",name:"Ukupno spratova"}
    {id:1106,type:C,value:"Centralno (gradsko)",attr_code:"grijanje",name:"Vrsta grijanja"}
    {id:1107,type:C,value:"Namješten",attr_code:"opremljenost",name:"Opremljenost"}
    {id:1108,type:C,value:"Novogradnja",attr_code:"stanje",name:"Stanje"}
    {id:1109,type:B,value:"Da",attr_code:"parking",name:"Parking"}
    {id:1110,type:B,value:"Da",attr_code:"garaza",name:"Garaža"}
    {id:1111,type:B,value:"Ne",attr_code:"lift",name:"Lift"}
    {id:1112,type:A,value:2019,attr_code:"godina-izgradnje",name:"Godina izgradnje"}
    {id:1113,type:C,value:"Jug",attr_code:"primarna-orjentacija",name:"Primarna orjentacija"}
  </body></html>`;

test('parseDetail: known characteristic codes map to typed fields', () => {
  const r = parseDetail(APARTMENT_HTML);
  assert.equal(r.roomsDetail, '2');
  assert.equal(r.bathrooms, 1);
  assert.equal(r.floorNum, 3);
  assert.equal(r.floorsTotal, 6);
  assert.equal(r.heating, 'Centralno (gradsko)');
  assert.equal(r.furnished, true);          // 'Namješten' → true
  assert.equal(r.condition, 'Novogradnja');
  assert.equal(r.parking, true);
  assert.equal(r.garage, true);
  assert.equal(r.elevator, false);          // 'Ne' → false
  assert.equal(r.yearBuilt, 2019);
  assert.equal(r.orientation, 'Jug');
  assert.equal(r.plotSqm, 1636);            // okucnica
  assert.equal(r.sqm, 72);
});

test('parseDetail: counters + renewal date from rendered DOM text', () => {
  const r = parseDetail(APARTMENT_HTML);
  assert.equal(r.views, 12345);             // "12.345" → thousands dots stripped
  assert.equal(r.favorites, null);          // nothing exposed on this fixture
  assert.deepEqual(r.publishedAt, new Date('2026-08-21T15:09:00Z'));
  assert.equal(r.sellerType, 'shop');       // PIK Shop badge wins over seller-card text
});

test('parseDetail: every raw pair lands in characteristics', () => {
  const r = parseDetail(APARTMENT_HTML);
  assert.equal(r.characteristics['kvadrata'], 72);
  assert.equal(r.characteristics['broj-soba'], 2);
  assert.equal(r.characteristics['grijanje'], 'Centralno (gradsko)');
});

// ── publish date precedence & formats ────────────────────────────────────────

test('parseDetail: Objavljen beats the later Obnovljen renewal stamp', () => {
  const html = `Objavljen: 01.03.2025 u 10:30 … Obnovljen: 21.08.2026 u 15:09`;
  assert.deepEqual(parseDetail(html).publishedAt, new Date('2025-03-01T10:30:00Z'));
});

test('parseDetail: date without time falls back to noon UTC', () => {
  assert.deepEqual(parseDetail('Obnovljen: 05.04.2024').publishedAt,
    new Date('2024-04-05T12:00:00Z'));
});

test('parseDetail: implausible dates are rejected', () => {
  assert.equal(parseDetail('Obnovljen: 99.99.1234 u 25:99').publishedAt, null);
});

// ── seller classification ────────────────────────────────────────────────────

test('parseDetail: private seller recognized from seller-card text', () => {
  assert.equal(parseDetail('Prosječno vrijeme odgovora 2 sata').sellerType, 'private');
});

test('parseDetail: neither badge nor seller card → null', () => {
  assert.equal(parseDetail('<html>empty</html>').sellerType, null);
});

// ── counter patterns & bounds ────────────────────────────────────────────────

test('parseDetail: JSON-state counters are picked up as fallbacks', () => {
  const r = parseDetail(`"favorites":17 … "views":8341`);
  assert.equal(r.views, 8341);
  assert.equal(r.favorites, 17);
});

test('parseDetail: absurd counter values are dropped, not stored', () => {
  assert.equal(parseDetail('Pregledi: 999999999999').views, null);
});

// ── opremljenost nuances & boolean forms ─────────────────────────────────────

test('parseDetail: polunamješten stays NULL (partially furnished)', () => {
  const html = '{id:1,type:C,value:"Polunamješten",attr_code:"opremljenost"}';
  assert.equal(parseDetail(html).furnished, null);
});

test('parseDetail: nenamješten maps to false', () => {
  const html = '{id:1,type:C,value:"Nenamješten",attr_code:"opremljenost"}';
  assert.equal(parseDetail(html).furnished, false);
});

test('parseDetail: boolean attrs accept Da/Ne/true/false/1/0', () => {
  const cases = [['Da', true], ['true', true], ['1', true],
                 ['Ne', false], ['false', false], ['0', false], ['maybe', null]];
  for (const [v, expected] of cases) {
    const html = `{id:1,type:B,value:"${v}",attr_code:"lift"}`;
    assert.equal(parseDetail(html).elevator, expected, `lift=${v}`);
  }
});

// ── unknown codes, repeats, out-of-range values ──────────────────────────────

test('parseDetail: unknown attr_code preserved in characteristics only', () => {
  const html = '{id:9,type:X,value:"Balkon 12m",attr_code:"neki-novi-kod"}';
  const r = parseDetail(html);
  assert.equal(r.characteristics['neki-novi-kod'], 'Balkon 12m');
});

test('parseDetail: first sighting of a repeated code wins', () => {
  const html = `{id:1,type:A,value:2,attr_code:"broj-kupatila"}
                {id:2,type:A,value:5,attr_code:"broj-kupatila"}`;
  const r = parseDetail(html);
  assert.equal(r.bathrooms, 2);
  assert.equal(r.characteristics['broj-kupatila'], 2);
});

test('parseDetail: out-of-range typed value still kept in characteristics', () => {
  const r = parseDetail('{id:1,type:A,value:-10,attr_code:"sprat"}');
  assert.equal(r.floorNum, null);           // below -5 sanity bound
  assert.equal(r.characteristics['sprat'], -10);
});

test('parseDetail: negative floor within bounds is kept (basement levels)', () => {
  assert.equal(parseDetail('{id:1,type:A,value:-1,attr_code:"sprat"}').floorNum, -1);
});