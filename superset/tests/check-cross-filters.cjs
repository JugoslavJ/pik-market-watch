/* Browser acceptance: real chart clicks requery siblings and clear restores data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { chromium } = require(require.resolve('playwright', {
  paths: [path.join(root, 'data/superset-validation'), root],
}));
const origin = process.env.SUPERSET_TEST_URL || 'http://127.0.0.1:3000';

// Read the displayed ECharts bar rectangle, then click it through Playwright.
// This does not invoke a component callback or inject Redux filter state.
function barPoint(element) {
  for (const node of element.querySelectorAll('*')) {
    const key = Object.keys(node).find(k => k.startsWith('__reactFiber$'));
    if (!key) continue;
    for (let fiber = node[key]; fiber; fiber = fiber.return) {
      const instance = fiber.memoizedProps?.refs?.echartRef?.current?.getEchartInstance?.();
      if (!instance) continue;
      const bounds = instance.getDom().getBoundingClientRect();
      for (const series of instance.getModel().getSeries()) {
        const data = series.getData();
        for (let index = 0; index < data.count(); index++) {
          const rect = data.getItemLayout(index);
          if (!rect || !Number.isFinite(rect.x) || !rect.width || !rect.height) continue;
          const raw = data.getRawDataItem(index);
          const values = Array.isArray(raw) ? raw : raw?.value || [];
          return { x: bounds.x + rect.x + rect.width / 2,
            y: bounds.y + rect.y + rect.height / 2, series: series.name,
            room: fiber.memoizedProps.labelMap?.[series.name]?.at(-1)
              || series.name.split(',').at(-1).trim(),
            minimum: values.find(value => typeof value === 'number') };
        }
      }
    }
  }
  return null;
}

function legacyMapForm(request) {
  const body = request.postData();
  let raw;
  const type = request.headers()['content-type'] || '';
  if (body && type.includes('multipart/form-data')) {
    const boundary = type.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    const part = body.split('--' + (boundary?.[1] || boundary?.[2]))
      .find(value => value.includes('name="form_data"'));
    raw = part?.split(/\r*\n\r*\n/).slice(1).join('\n').trim();
  } else if (body) {
    raw = request.postDataJSON()?.form_data;
  }
  raw ||= new URL(request.url()).searchParams.get('form_data');
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function main() {
  const secret = process.env.SUPERSET_ADMIN_PASSWORD || fs.readFileSync(path.join(root, '.env'), 'utf8')
    .match(/^SUPERSET_ADMIN_PASSWORD=(.*)$/m)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  assert.ok(secret, 'Configure SUPERSET_ADMIN_PASSWORD');
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.SUPERSET_TEST_BROWSER || (fs.existsSync(edge) ? edge : undefined),
    args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.route('**/superset/log/**', route => route.fulfill({ status: 200, body: '{}' }));
    page = await context.newPage();
    page.setDefaultTimeout(90000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/login/', { waitUntil: 'domcontentloaded' });
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(secret);
    await Promise.all([page.waitForURL(u => !u.pathname.includes('/login'), { waitUntil: 'domcontentloaded' }),
      page.locator('button[type="submit"], input[type="submit"]').click()]);

    const requests = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/v1/dashboard_data/data') {
        for (const data of request.postDataJSON().contexts) {
          requests.push({ id: data.form_data?.slice_id,
            map: data.form_data?.viz_type === 'deck_scatter',
            filters: data.queries?.[0]?.filters || [] });
        }
      } else if (new URL(request.url()).pathname === '/api/v1/chart/data') {
        const data = request.postDataJSON();
        requests.push({ id: data.form_data?.slice_id,
          map: data.form_data?.viz_type === 'deck_scatter',
          filters: data.queries?.[0]?.filters || [] });
      } else if (new URL(request.url()).pathname === '/superset/explore_json/') {
        const form = legacyMapForm(request);
        if (form) {
          requests.push({ id: form.slice_id, map: true,
            filters: [...(form.extra_filters || []), ...(form.extra_form_data?.filters || [])],
            adhoc: form.adhoc_filters || [] });
        }
      }
    });
    await page.goto(origin + '/superset/dashboard/olx-overview-superset/', { waitUntil: 'domcontentloaded' });
    const holder = title => page.locator('.dashboard-component-chart-holder')
      .filter({ has: page.getByText('OLX.ba Market Overview / ' + title, { exact: true }) });
    const card = holder('Active listings');
    await card.locator('.header-line').waitFor({ state: 'visible' });
    const baseline = await card.locator('.header-line').innerText();
    console.log('Loaded market overview; baseline inventory: ' + baseline);
    const ratio = holder('Annualized asking rent / sale ratio');
    await ratio.scrollIntoViewIfNeeded();
    await ratio.locator('.header-line').waitFor({ state: 'visible' });
    const ratioBaseline = await ratio.locator('.header-line').innerText();
    const bars = holder('Active sale listings by rooms');
    await bars.scrollIntoViewIfNeeded();
    await bars.locator('canvas').first().waitFor({ state: 'visible' });
    await page.waitForFunction(barPoint, await bars.elementHandle());
    const point = await bars.evaluate(barPoint);
    console.log('Clicking room bar: ' + point.series);
    requests.length = 0;
    // Hold the real request long enough to inspect the in-progress state.
    await page.route('**/api/v1/dashboard_data/data', async route => {
      await new Promise(resolve => setTimeout(resolve, 700));
      await route.continue();
    });
    const originalNode = await card.locator('.header-line').elementHandle();
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(150);
    assert.equal(await originalNode.evaluate(node => node.isConnected), true,
      'A filter refresh unmounted the previous chart');
    assert.equal(await card.locator('.header-line').innerText(), baseline,
      'Previous data disappeared before the filtered result arrived');
    assert.equal(await card.locator('.chart-container [role="status"], .chart-container .loading').count(), 0,
      'A loading spinner replaced previously rendered chart content');
    await page.unroute('**/api/v1/dashboard_data/data');
    await page.waitForFunction(baseline => {
      const card = [...document.querySelectorAll('.dashboard-component-chart-holder')]
        .find(el => el.innerText.includes('OLX.ba Market Overview / Active listings'));
      return card?.querySelector('.header-line')?.textContent !== baseline;
    }, baseline);
    await holder('Listing map — click a pin to open the ad').scrollIntoViewIfNeeded();
    await page.waitForTimeout(3000);
    assert.ok(requests.filter(r => r.filters.some(f => f.col === 'rooms')).length >= 2,
      'A room click did not requery multiple sibling charts');
    const filtered = await card.locator('.header-line').innerText();
    const count = Number(filtered.replaceAll(',', ''));
    assert.ok(count > 0 && count < Number(baseline.replaceAll(',', '')),
      'Room selection did not reduce the inventory count');
    assert.ok(requests.some(r => r.filters.some(f => f.col === 'rooms' && f.val?.includes(point.room))),
      'The bar emitted a metric label rather than its actual room value');
    const mapFiltered = requests.some(r => r.map && (
      r.filters.some(f => f.col === 'rooms' && f.val?.includes(point.room)) ||
      (r.adhoc || []).some(f => f.subject === 'rooms' && f.comparator?.includes(point.room))));
    assert.ok(mapFiltered, 'The listing map did not receive the selected room filter: '
      + JSON.stringify(requests.filter(r => r.map)));
    assert.ok(count >= point.minimum, 'Filtered inventory is smaller than the selected sale bar');
    await ratio.scrollIntoViewIfNeeded();
    await page.waitForFunction(baseline => {
      const card = [...document.querySelectorAll('.dashboard-component-chart-holder')]
        .find(el => el.innerText.includes('OLX.ba Market Overview / Annualized asking rent / sale ratio'));
      const value = card?.querySelector('.header-line')?.textContent;
      return value && value !== baseline;
    }, ratioBaseline);
    assert.doesNotMatch(await page.locator('body').innerText(), /Data error|Minified React error|EvalError/);
    await bars.scrollIntoViewIfNeeded();
    const clearPoint = await bars.evaluate(barPoint);
    await page.mouse.click(clearPoint.x, clearPoint.y);
    await page.waitForFunction(baseline => {
      const card = [...document.querySelectorAll('.dashboard-component-chart-holder')]
        .find(el => el.innerText.includes('OLX.ba Market Overview / Active listings'));
      return card?.querySelector('.header-line')?.textContent === baseline;
    }, baseline);

    // Aggregate tables are another supported emitter on companion dashboards.
    await page.goto(origin + '/superset/dashboard/segments-rankings/', { waitUntil: 'domcontentloaded' });
    const roomTable = page.locator('.dashboard-component-chart-holder')
      .filter({ has: page.getByText('Active listings by rooms', { exact: true }) });
    await roomTable.locator('tbody td.dt-is-filter').first().waitFor();
    requests.length = 0;
    await roomTable.locator('tbody td.dt-is-filter').first().click();
    await page.waitForTimeout(3000);
    assert.ok(requests.filter(r => r.filters.some(f => f.col === 'rooms')).length >= 2,
      'Table selection did not filter compatible companion charts');

    // Raw cells look clickable upstream too. They previously emitted a mask
    // with an empty dashboard scope, leaving every sibling unchanged.
    await page.goto(origin + '/superset/dashboard/market-explorer/', { waitUntil: 'domcontentloaded' });
    const marketHolder = title => page.locator('.dashboard-component-chart-holder')
      .filter({ has: page.getByText(title, { exact: true }) });
    const marketCount = marketHolder('Active listing count').locator('.header-line');
    await marketCount.waitFor({ state: 'visible' });
    const rawBaseline = await marketCount.innerText();
    const rawTable = marketHolder('Matching listings');
    await rawTable.scrollIntoViewIfNeeded();
    await rawTable.locator('tbody td.dt-is-filter').first().waitFor();
    const roomCell = rawTable.locator('tbody tr').first().locator('td').nth(4);
    const rawRoom = (await roomCell.innerText()).trim();
    requests.length = 0;
    await roomCell.click();
    await page.waitForFunction(baseline => {
      const card = [...document.querySelectorAll('.dashboard-component-chart-holder')]
        .find(el => el.innerText.includes('Active listing count'));
      const value = card?.querySelector('.header-line')?.textContent;
      return value && value !== baseline;
    }, rawBaseline);
    const rawFiltered = await marketCount.innerText();
    assert.ok(Number(rawFiltered.replaceAll(',', '')) > 0
      && Number(rawFiltered.replaceAll(',', '')) < Number(rawBaseline.replaceAll(',', '')),
    'Raw room selection did not reduce the sibling KPI');
    assert.ok(requests.filter(r => r.filters.some(f => f.col === 'rooms' && f.val?.includes(rawRoom))).length >= 3,
      'Raw room selection did not reach the pie charts, summary table, and KPI');
    await roomCell.click();
    await page.waitForFunction(baseline => {
      const card = [...document.querySelectorAll('.dashboard-component-chart-holder')]
        .find(el => el.innerText.includes('Active listing count'));
      return card?.querySelector('.header-line')?.textContent === baseline;
    }, rawBaseline);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ sourceBar: 'passed', baseline, filtered,
      mapReceivesSelection: 'passed', clearRestoresCount: 'passed', companionTable: 'passed',
      formerlyGlobalKpi: 'passed', rawTable: 'passed', rawBaseline, rawFiltered,
      rawClearRestoresCount: 'passed' }));
  } catch (error) {
    if (page) {
      const artifacts = path.join(root, 'data/superset-validation');
      fs.mkdirSync(artifacts, { recursive: true });
      await page.screenshot({ path: path.join(artifacts, 'cross-filter-failure.png') }).catch(() => {});
      console.log((await page.locator('body').innerText().catch(() => '')).slice(0, 1800));
    }
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  // Playwright request call logs can contain authentication headers/cookies.
  console.error(error.message.split('\nCall log:')[0]);
  process.exitCode = 1;
});
