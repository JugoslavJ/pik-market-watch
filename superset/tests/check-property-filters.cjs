const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const { chromium } = require(require.resolve('playwright', { paths: [path.join(root, 'data/superset-validation')] }));
const origin = process.env.SUPERSET_TEST_URL || 'http://127.0.0.1:3000';

async function main() {
  const password = process.env.SUPERSET_ADMIN_PASSWORD || fs.readFileSync(path.join(root, '.env'), 'utf8')
    .match(/^SUPERSET_ADMIN_PASSWORD=(.*)$/m)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.SUPERSET_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const login = await (await page.request.get(origin + '/login/')).text();
    const csrf = login.match(/name="csrf_token"[^>]*value="([^"]+)"/)?.[1];
    assert.ok(csrf);
    const authenticated = await page.request.post(origin + '/login/', {
      form: { username: 'admin', password, csrf_token: csrf }, maxRedirects: 0 });
    assert.equal(authenticated.status(), 302);
    assert.ok(!authenticated.headers().location.includes('/login'));
    for (const uid of ['olx-home', 'olx-overview', 'olx-exits', 'olx-health']) {
      const response = await page.goto(origin + '/olx/dashboard/' + uid + '/');
      assert.equal(response.status(), 200);
      assert.equal(new URL(page.url()).pathname, '/olx/dashboard/' + uid + '/');
      await page.waitForFunction(() => !!window.__olxViewer);
      const toggle = page.getByRole('button', { name: /^Filters/ });
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#dashboard-filters').isVisible(), false);
      await toggle.click();
      for (const label of ['Lift available', 'Heating', 'Apartment / property condition', 'Pets allowed', 'Balcony', 'Bills included',
        'Asking price (BAM) minimum', 'Asking price (BAM) maximum']) {
        assert.equal(await page.getByLabel(label, { exact: true }).count(), 1, uid + ': ' + label);
      }
      const lift = page.getByLabel('Lift available', { exact: true });
      assert.ok((await lift.locator('option').allTextContents()).includes('Unknown'));
      const next = page.waitForResponse(response => response.url().includes('/olx/api/dashboard/' + uid));
      await lift.selectOption('Yes');
      const packet = await (await next).json();
      assert.deepEqual(packet.selection.__property_elevator, ['Yes']);
      await page.waitForFunction(() => !window.__olxViewer.fetching);
      assert.equal(await page.getByRole('alert').count(), 0);
      await page.keyboard.press('Escape');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await page.reload();
      await page.waitForFunction(() => !!window.__olxViewer);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.deepEqual(await page.evaluate(() => window.__olxViewer.selection.__property_elevator), ['Yes']);
      await toggle.click();
      await page.getByLabel('Find a filter').fill('heating');
      assert.equal(await page.getByLabel('Heating', { exact: true }).isVisible(), true);
      assert.equal(await page.getByLabel('Lift available', { exact: true }).count(), 0);
      await page.getByLabel('Find a filter').fill('');
      await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
      await page.waitForFunction(() => !window.__olxViewer.fetching && window.__olxViewer.selection.__property_elevator[0] === 'All');
      if (uid === 'olx-overview') {
        await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('#dashboard-filters').scrollTop = 0; });
        await page.screenshot({ path: path.join(root, 'data/superset-validation/property-panel-desktop.png') });
      }
      console.log(uid + ': collapsed panel, property controls, selection, URL reload, search and reset passed');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Collapse filters', exact: true }).click();
    await page.getByRole('button', { name: /^Filters/ }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(root, 'data/superset-validation/property-panel-phone.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#dashboard-filters').isVisible(), false);
    const invalid = await page.request.get(origin + '/olx/api/dashboard/olx-overview?s=' + encodeURIComponent(
      JSON.stringify({ __property_price_bam_min: ['200'], __property_price_bam_max: ['100'] })));
    assert.equal(invalid.status(), 400);
    const boards = await (await page.request.get(origin + '/api/v1/dashboard/?q=(page_size:100)')).json();
    let native = 0;
    for (const board of boards.result) {
      const saved = await (await page.request.get(origin + '/api/v1/dashboard/' + board.id)).json();
      const metadata = JSON.parse(saved.result.json_metadata);
      assert.equal(metadata.filter_bar_orientation, 'VERTICAL');
      const columns = metadata.native_filter_configuration.flatMap(f => f.targets.map(t => t.column?.name));
      for (const column of ['__property_elevator', '__property_heating', '__property_condition']) assert.ok(columns.includes(column));
      assert.ok(columns.some(column => column === 'price_bam' || column === '__property_price_bam'));
      native++;
    }
    assert.equal(native, 10);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(origin + '/superset/dashboard/' + boards.result[0].id + '/', { waitUntil: 'domcontentloaded' });
    const panel = page.locator('.collapse-icon').locator('..');
    await panel.waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.featureFlags.FILTERBAR_CLOSED_BY_DEFAULT), true);
    assert.ok((await panel.boundingBox()).width < 100, 'Native Superset filters must start collapsed');
    assert.deepEqual(errors, []);
    console.log('All ten native dashboard filter definitions, native collapsed default, phone drawer and range rejection passed');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message.split('\nCall log:')[0]); process.exitCode = 1; });
