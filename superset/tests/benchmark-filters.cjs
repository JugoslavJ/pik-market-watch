/* Real room-bar interactions. The baseline flag disables only request sharing,
 * keeping the same data, SQL, resources, chart layout and browser viewport.
 */
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '../..');
const { chromium } = require(require.resolve('playwright', { paths: [path.join(root, 'data/superset-validation'), root] }));
const origin = process.env.SUPERSET_TEST_URL || 'http://127.0.0.1:3000';
const baselineMode = process.argv.includes('--baseline');

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
          if (rect && Number.isFinite(rect.x) && rect.width && rect.height)
            return { x: bounds.x + rect.x + rect.width / 2, y: bounds.y + rect.y + rect.height / 2 };
        }
      }
    }
  }
  return null;
}

function updatingCharts() {
  const states = [...document.querySelectorAll('.chart-container')].map(node => {
    const key = Object.keys(node).find(k => k.startsWith('__reactFiber$'));
    for (let fiber = node[key]; fiber; fiber = fiber.return) {
      if (fiber.memoizedProps && 'chartStatus' in fiber.memoizedProps)
        return { id: fiber.memoizedProps.chartId, status: fiber.memoizedProps.chartStatus };
    }
    return null;
  }).filter(Boolean);
  return states.filter(s => s.status === 'loading').length;
}

async function main() {
  const secret = process.env.SUPERSET_ADMIN_PASSWORD || fs.readFileSync(path.join(root, '.env'), 'utf8')
    .match(/^SUPERSET_ADMIN_PASSWORD=(.*)$/m)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(edge) ? edge : undefined,
    args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.route('**/superset/log/**', route => route.fulfill({ status: 200, body: '{}' }));
    if (baselineMode) await context.addInitScript(() => { window.__olxDashboardRequests = { disabled: true }; });
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    await page.goto(origin + '/login/', { waitUntil: 'domcontentloaded' });
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(secret);
    await Promise.all([page.waitForURL(u => !u.pathname.includes('/login'), { waitUntil: 'domcontentloaded' }),
      page.locator('button[type="submit"], input[type="submit"]').click()]);
    await page.goto(origin + '/superset/dashboard/olx-overview-superset/', { waitUntil: 'domcontentloaded' });
    const holder = title => page.locator('.dashboard-component-chart-holder')
      .filter({ has: page.getByText('OLX.ba Market Overview / ' + title, { exact: true }) });
    const card = holder('Active listings').locator('.header-line');
    await card.waitFor({ state: 'visible' });
    const initial = await card.innerText();
    const bars = holder('Active sale listings by rooms');
    await bars.scrollIntoViewIfNeeded();
    await page.waitForFunction(barPoint, await bars.elementHandle());
    // Settle initial data independently of the interaction timings.
    while (await page.evaluate(updatingCharts)) await page.waitForTimeout(50);
    const runs = [];
    let requests = 0;
    page.on('request', req => {
      if (/\/api\/v1\/(chart|dashboard_data)\/data(?:\?|$)|\/superset\/explore_json\//.test(req.url())) requests++;
    });
    for (let cycle = 0; cycle < 4; cycle++) {
      for (const action of ['select', 'clear']) {
        requests = 0;
        const before = await card.innerText();
        const point = await bars.evaluate(barPoint);
        const started = performance.now();
        await page.mouse.click(point.x, point.y);
        await page.waitForFunction(({ initial, action }) => {
          const holder = [...document.querySelectorAll('.dashboard-component-chart-holder')]
            .find(el => el.textContent.includes('OLX.ba Market Overview / Active listings'));
          const value = holder?.querySelector('.header-line')?.textContent;
          return value && (action === 'select' ? value !== initial : value === initial);
        }, { initial, action });
        const cardMs = Math.round(performance.now() - started);
        while (await page.evaluate(updatingCharts)) await page.waitForTimeout(10);
        const allChartsMs = Math.round(performance.now() - started);
        const run = { cycle, action, cardMs, allChartsMs, requests,
          before, after: await card.innerText() };
        runs.push(run);
        console.log(JSON.stringify(run));
      }
    }
    const report = { mode: baselineMode ? 'individual' : 'shared', runs,
      sharing: await page.evaluate(() => window.__olxDashboardRequests) };
    fs.writeFileSync(path.join(root, 'data/superset-validation/filter-' + report.mode + '.json'), JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message.split('\nCall log:')[0]); process.exitCode = 1; });
