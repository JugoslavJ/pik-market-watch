'use strict';
// Unit tests for parser.js — pure, no network, no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDetail, extractArticleId } = require('../../src/parser');

// ── parseDetail: map pin + floor area from ad detail-page HTML ──────────────

const vikendicaHtml = `
  some page … location:{lat:44.812345,lon:17.198765} …
  {id:1128,type:A,value:1636,attr_code:"okucnica-kvadratura",name:"Okućnica (kvadratura)"}
  {id:1101,type:A,value:72,attr_code:"kvadrata",name:"Kvadrata"}`;

test('parseDetail: Nuxt pin literal + kvadrata', () => {
  const r = parseDetail(vikendicaHtml);
  assert.equal(r.latitude, 44.812345);
  assert.equal(r.longitude, 17.198765);
  assert.equal(r.sqm, 72);
});

test('parseDetail: quoted-template default is rejected (outside BiH)', () => {
  const html = `{"lat":"43.1235","lon":"42.5426"}
    location:{lat:44.770123,lon:17.190456}`;
  const r = parseDetail(html);
  assert.equal(r.latitude, 44.770123);
  assert.equal(r.longitude, 17.190456);
});

test('parseDetail: JSON-fallback pin pattern works', () => {
  const html = `"lat":"44.900123","lon":"17.300456"
    {id:901,type:A,value:88,attr_code:"kvadrata",name:"Kvadrata"}`;
  const r = parseDetail(html);
  assert.equal(r.latitude, 44.900123);
  assert.equal(r.longitude, 17.300456);
  assert.equal(r.sqm, 88);
});

test('parseDetail: pins outside the BiH bounding box are rejected', () => {
  const html = 'location:{lat:51.5074,lon:-0.1278}';   // London
  const r = parseDetail(html);
  assert.equal(r.latitude, null);
  assert.equal(r.longitude, null);
  assert.equal(r.sqm, null);
});

test('parseDetail: no data at all → all nulls', () => {
  const r = parseDetail('<html>nothing</html>');
  assert.equal(r.latitude, null);
  assert.equal(r.longitude, null);
  assert.equal(r.sqm, null);
  assert.equal(r.publishedAt, null);
  assert.equal(r.views, null);
  assert.deepEqual(r.characteristics, {});
});

test('parseDetail: kvadrata sanity bounds (5–500 m²)', () => {
  assert.equal(parseDetail('{id:1,type:A,value:1636,attr_code:"kvadrata"}').sqm, null); // plot-sized
  assert.equal(parseDetail('{id:2,type:A,value:3,attr_code:"kvadrata"}').sqm, null);    // too small
  assert.equal(parseDetail('{id:3,type:A,value:500,attr_code:"kvadrata"}').sqm, 500);   // edge ok
  assert.equal(parseDetail('{id:4,type:A,value:5,attr_code:"kvadrata"}').sqm, 5);       // edge ok
  assert.equal(parseDetail('{id:5,type:A,value:72.5,attr_code:"kvadrata"}').sqm, 72.5); // decimal ok
});

// ── extractArticleId ─────────────────────────────────────────────────────────

test('extractArticleId: standard /artikal/<id>/ URLs', () => {
  assert.equal(extractArticleId('https://olx.ba/artikal/74558628'), '74558628');
  assert.equal(extractArticleId('https://www.olx.ba/artikal/123456/'), '123456');
  assert.equal(extractArticleId('https://olx.ba/artikal/99?some=qs'), '99');
});

test('extractArticleId: non-matching URLs → null', () => {
  assert.equal(extractArticleId('https://olx.ba/pretraga?kat=16'), null);
  assert.equal(extractArticleId(''), null);
  assert.equal(extractArticleId(undefined), null);
});
