'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { utilsContext } = require('./setup');

const g = utilsContext();
// const-declared names need $get(); function-declared ones are on g directly
const SerbianDeclension = g.$get('SerbianDeclension');
const Icons             = g.$get('Icons');

// ── parseNumber ───────────────────────────────────────────────────────────────

describe('parseNumber', () => {
  test('plain integer',                   () => assert.equal(g.parseNumber('12345'),    12345));
  test('null → null',                     () => assert.equal(g.parseNumber(null),       null));
  test('empty string → null',             () => assert.equal(g.parseNumber(''),         null));
  test('dot-thousands 125.000 → 125000',  () => assert.equal(g.parseNumber('125.000'), 125000));
  test('comma-decimal 1.248,50 → 1248.5', () => assert.equal(g.parseNumber('1.248,50'),1248.5));
  test('comma decimal 3,5 → 3.5',         () => assert.equal(g.parseNumber('3,5'),      3.5));
  test('spaces stripped',                 () => assert.equal(g.parseNumber('125 000'),  125000));
  test('2-digit fraction → decimal',      () => assert.equal(g.parseNumber('1.25'),     1.25));
  test('non-numeric → null',              () => assert.equal(g.parseNumber('abc'),      null));
  test('negative',                        () => assert.equal(g.parseNumber('-50'),      -50));
  test('1.000 (3-digit fraction) → 1000', () => assert.equal(g.parseNumber('1.000'),   1000));
});

// ── computeMedian ─────────────────────────────────────────────────────────────

describe('computeMedian', () => {
  test('empty → null',               () => assert.equal(g.computeMedian([]),                         null));
  test('single element',             () => assert.equal(g.computeMedian([7]),                        7));
  test('odd length picks middle',    () => assert.equal(g.computeMedian([1, 3, 5]),                  3));
  test('even length averages pair',  () => assert.equal(g.computeMedian([1, 3, 5, 7]),               4));
  test('rounds half-up',             () => assert.equal(g.computeMedian([1, 2]),                     2));
  test('unsorted input',             () => assert.equal(g.computeMedian([9, 1, 5, 3, 7]),            5));
  test('all identical',              () => assert.equal(g.computeMedian([500, 500, 500]),            500));
  test('real-world ppm2',            () => assert.equal(g.computeMedian([3800,3900,4000,4100,4200]), 4000));
  test('two elements',               () => assert.equal(g.computeMedian([2000, 3000]),               2500));
});

// ── getPriceColourTier ────────────────────────────────────────────────────────

describe('getPriceColourTier', () => {
  test('null ppm2 → ""',  () => assert.equal(g.getPriceColourTier(null, 4000), ''));
  test('null median → ""',() => assert.equal(g.getPriceColourTier(4000, null), ''));
  test('80% → great',     () => assert.equal(g.getPriceColourTier(3200, 4000), 'olx-ppm2-great'));
  test('79% → great',     () => assert.equal(g.getPriceColourTier(3160, 4000), 'olx-ppm2-great'));
  test('81% → good',      () => assert.equal(g.getPriceColourTier(3240, 4000), 'olx-ppm2-good'));
  test('100% → good',     () => assert.equal(g.getPriceColourTier(4000, 4000), 'olx-ppm2-good'));
  test('101% → fair',     () => assert.equal(g.getPriceColourTier(4040, 4000), 'olx-ppm2-fair'));
  test('120% → fair',     () => assert.equal(g.getPriceColourTier(4800, 4000), 'olx-ppm2-fair'));
  test('121% → high',     () => assert.equal(g.getPriceColourTier(4840, 4000), 'olx-ppm2-high'));
});

// ── extractArticleId ──────────────────────────────────────────────────────────

describe('extractArticleId', () => {
  test('standard URL',    () => assert.equal(g.extractArticleId('https://www.olx.ba/artikal/123456/stan.html'), '123456'));
  test('trailing slash',  () => assert.equal(g.extractArticleId('https://www.olx.ba/artikal/777/'),             '777'));
  test('query params',    () => assert.equal(g.extractArticleId('https://www.olx.ba/artikal/99?ref=x'),         '99'));
  test('no match → null', () => assert.equal(g.extractArticleId('https://www.olx.ba/nekretnine/'),              null));
  test('case insensitive',() => assert.equal(g.extractArticleId('https://www.olx.ba/Artikal/888/'),             '888'));
});

// ── buildSearchCacheKey ───────────────────────────────────────────────────────

describe('buildSearchCacheKey', () => {
  test('strips page',          () => assert.ok(!g.buildSearchCacheKey('https://www.olx.ba/n/?q=s&page=3').includes('page')));
  test('strips olx_scrape',    () => assert.ok(!g.buildSearchCacheKey('https://www.olx.ba/n/?olx_scrape=true').includes('olx_scrape')));
  test('strips hash',          () => assert.ok(!g.buildSearchCacheKey('https://www.olx.ba/n/#top').includes('#')));
  test('preserves other params', () => assert.ok(g.buildSearchCacheKey('https://www.olx.ba/n/?q=stan&page=2').includes('q=stan')));
  test('page 1 = page 5 same key', () => assert.equal(
    g.buildSearchCacheKey('https://www.olx.ba/n/?q=stan&page=1'),
    g.buildSearchCacheKey('https://www.olx.ba/n/?q=stan&page=5')
  ));
});

// ── formatRelativeTime ────────────────────────────────────────────────────────
// Note: rounds(ms / 60_000) → 30min = 0.5 hrs → rounds to 1h, so 30min threshold is ~0-44min

describe('formatRelativeTime', () => {
  test('0 ms → 0 min',   () => assert.equal(g.formatRelativeTime(0),                '0 min'));
  test('20 min',         () => assert.equal(g.formatRelativeTime(20 * 60_000),      '20 min'));
  test('1 hour',         () => assert.equal(g.formatRelativeTime(60 * 60_000),      '1h'));
  test('2 hours',        () => assert.equal(g.formatRelativeTime(2 * 3_600_000),    '2h'));
  test('1 day',          () => assert.equal(g.formatRelativeTime(24 * 3_600_000),   '1d'));
  test('3 days',         () => assert.equal(g.formatRelativeTime(3 * 86_400_000),   '3d'));
});

// ── escapeHtml ────────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  test('& → &amp;',         () => assert.equal(g.escapeHtml('a & b'),       'a &amp; b'));
  test('< and > escaped',   () => assert.equal(g.escapeHtml('<div>'),       '&lt;div&gt;'));
  test('" → &quot;',        () => assert.equal(g.escapeHtml('"hi"'),        '&quot;hi&quot;'));
  test('clean passthrough',  () => assert.equal(g.escapeHtml('hello'),      'hello'));
  test('number coerced',    () => assert.equal(g.escapeHtml(42),            '42'));
  test('XSS payload', () => assert.equal(
    g.escapeHtml('<script>alert("xss")</script>'),
    '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
  ));
});

// ── SerbianDeclension ─────────────────────────────────────────────────────────

describe('SerbianDeclension.declinePage', () => {
  test('1 → stranici',         () => assert.ok(SerbianDeclension.declinePage(1).includes('stranici')));
  test('2 → stranice',         () => assert.ok(SerbianDeclension.declinePage(2).includes('stranice')));
  test('5 → stranica',         () => assert.ok(SerbianDeclension.declinePage(5).includes('stranica')));
  test('11 → stranica (teen)', () => assert.ok(SerbianDeclension.declinePage(11).includes('stranica')));
  test('21 → stranici',        () => assert.ok(SerbianDeclension.declinePage(21).includes('stranici')));
});

describe('SerbianDeclension.declareListing', () => {
  test('1 → oglas',            () => assert.ok(SerbianDeclension.declareListing(1).endsWith('oglas')));
  test('5 → oglasa',           () => assert.ok(SerbianDeclension.declareListing(5).endsWith('oglasa')));
  test('11 → oglasa (teen)',   () => assert.ok(SerbianDeclension.declareListing(11).endsWith('oglasa')));
  test('21 → oglas',           () => assert.ok(SerbianDeclension.declareListing(21).endsWith('oglas')));
  test('1006 → oglasa',        () => assert.ok(SerbianDeclension.declareListing(1006).endsWith('oglasa')));
});

// ── Icons (smoke test — just verify SVG output) ───────────────────────────────

describe('Icons', () => {
  test('search returns svg string',  () => assert.ok(Icons.search(16).includes('<svg')));
  test('search includes correct size', () => assert.ok(Icons.search(16).includes('width="16"')));
  test('download is svg string',     () => assert.ok(Icons.download.includes('<svg')));
});

// ── normRooms: used in result-table after _normaliseRooms() removal ───────────
// Duplicate of rent-estimator normRooms tests, but verifies the contract
// relied upon by result-table room filtering after _normaliseRooms() was removed.

const { rentContext } = require('./setup');
const gRent = rentContext();

describe('normRooms (used by ResultTable after dedup)', () => {
  test('null → null (not "unknown")', () => assert.equal(gRent.normRooms(null), null));
  test('unknown string → null',       () => assert.equal(gRent.normRooms('xyz'), null));
  test('0 → "0" (garsonjera)',        () => assert.equal(gRent.normRooms(0), '0'));
  test('4 → "4+"',                    () => assert.equal(gRent.normRooms(4), '4+'));
  test('result-table uses ?? "unknown" for null', () => {
    // ResultTable does: normRooms(r.rooms) ?? 'unknown'
    assert.equal(gRent.normRooms(null) ?? 'unknown', 'unknown');
    assert.equal(gRent.normRooms(2)    ?? 'unknown', '2');
  });
});
