'use strict';
// TEMPORARY diagnostic probe: inspects one search card + one ad detail page
// to discover where location/geodata lives in olx.ba's markup.
// Run:  docker compose build scraper && docker compose run --rm scraper node src/probe.js

const { chromium } = require('playwright');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

(async () => {
  const searchUrl = process.argv[2] ||
    'https://www.olx.ba/pretraga?category_id=24&canton=11&cities=79';

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: USER_AGENT,
  });

  // ── 1. Search page: dump the first listing card ────────────────────────────
  const page = await ctx.newPage();
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('.content-wrap', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const cards = await page.evaluate(() => {
    return [...document.querySelectorAll('.content-wrap')].slice(0, 3).map(el => {
      const a = el.closest('a') || el.querySelector('a');
      return {
        url: a ? a.href : null,
        text: el.innerText.replace(/\s+/g, ' | ').slice(0, 300),
        html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 2500),
      };
    });
  });
  for (const [i, c] of cards.entries()) {
    console.log(`════ CARD ${i} URL ════ ${c.url}`);
    console.log(`════ CARD ${i} TEXT ════ ${c.text}`);
    console.log(`════ CARD ${i} HTML ════ ${c.html}\n`);
  }

  const adUrl = cards.find(c => c.url && c.url.includes('/artikal/'))?.url || null;
  console.log('\n════ AD URL FOR DETAIL PROBE ════ ' + adUrl);

  // ── 2. Ad detail page: hunt for geodata ───────────────────────────────────
  if (adUrl) {
    const p2 = await ctx.newPage();
    await p2.goto(adUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await p2.waitForTimeout(3000);

    const info = await p2.evaluate(() => {
      const html = document.documentElement.outerHTML;
      const text = document.body ? document.body.innerText : '';
      const lower = text.toLowerCase();
      const out = {};

      const idx = lower.indexOf('lokacij');
      out.locationInnerText = idx >= 0
        ? text.slice(Math.max(0, idx - 80), idx + 250).replace(/\s+/g, ' ')
        : '(no "lokacij" text found)';

      // Raw HTML structure right after the "Lokacija nekretnine" heading
      const hIdx = html.indexOf('Lokacija nekretnine');
      out.locationHtmlContext = hIdx >= 0
        ? html.slice(hIdx - 300, hIdx + 2200).replace(/\s+/g, ' ')
        : null;

      // Characteristic rows (Grad/Kanton/Mjesto usually live here)
      out.characteristicRows = [...document.querySelectorAll('li, .characteristics div')]
        .map(li => (li.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(t => t && t.length < 80 &&
          (/grad|kanton|mjesto|dr┼╛ava|op┼ítina|naselje|lokacija/i.test(t)))
        .slice(0, 25);

      // JSON state contexts around every "lat" occurrence
      const spots = [];
      for (const needle of ['"lat"', 'lat:', 'latitude']) {
        let pos = html.indexOf(needle);
        while (pos !== -1 && spots.length < 8) {
          spots.push(html.slice(pos - 120, pos + 260).replace(/\s+/g, ' '));
          pos = html.indexOf(needle, pos + needle.length);
          if (spots.some(s => s.includes(html.slice(pos - 40, pos)))) break;
        }
      }
      out.latContexts = [...new Set(spots)].slice(0, 6);

      return out;
    });

    console.log('\n════ LOCATION INNERTEXT ════\n' + info.locationInnerText);
    console.log('\n════ LOCATION HTML CONTEXT ════\n' + (info.locationHtmlContext || '(none)').slice(0, 2400));
    console.log('\n════ CHARACTERISTIC ROWS ════\n' + JSON.stringify(info.characteristicRows, null, 1));
    console.log('\n════ LAT CONTEXTS ════\n' + JSON.stringify(info.latContexts, null, 1));
  }

  await browser.close();
})().catch(err => { console.error('probe failed:', err); process.exit(1); });
