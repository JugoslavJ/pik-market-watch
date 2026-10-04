/* Measure browser dashboard loads, request fan-out, and retained chart content. */
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '../..');
const { chromium } = require(require.resolve('playwright', {
  paths: [path.join(root, 'data/superset-validation'), root],
}));
const origin = process.env.SUPERSET_TEST_URL || 'http://127.0.0.1:3000';
const output = process.argv[2] || 'data/superset-validation/dashboard-baseline.json';
const boards = process.env.SUPERSET_BENCH_DASHBOARDS?.split(',') ||
  ['olx-home-superset', 'olx-overview-superset', 'olx-exits-superset', 'olx-health-superset'];

function chartState() {
  const holders = [...document.querySelectorAll('.dashboard-component-chart-holder')];
  const visible = holders.filter(el => {
    const box = el.getBoundingClientRect();
    return box.bottom > 0 && box.top < innerHeight && box.width > 0;
  });
  const loading = el => el.querySelector('[role="status"], .loading, [data-test="loading"]');
  return { total: holders.length, visible: visible.length,
    ready: visible.filter(el => !loading(el) && el.querySelector('.header-line, canvas, tbody, svg')).length,
    errors: holders.filter(el => /Data error|Unexpected error/.test(el.textContent)).length };
}

async function main() {
  const secret = process.env.SUPERSET_ADMIN_PASSWORD || fs.readFileSync(path.join(root, '.env'), 'utf8')
    .match(/^SUPERSET_ADMIN_PASSWORD=(.*)$/m)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.SUPERSET_TEST_BROWSER || (fs.existsSync(edge) ? edge : undefined),
    args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    await page.goto(origin + '/login/', { waitUntil: 'domcontentloaded' });
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(secret);
    await Promise.all([page.waitForURL(u => !u.pathname.includes('/login'), { waitUntil: 'domcontentloaded' }),
      page.locator('button[type="submit"], input[type="submit"]').click()]);
    const runs = [];
    for (const slug of boards) {
      for (let round = 0; round < Number(process.env.SUPERSET_BENCH_ROUNDS || 3); round++) {
        const requests = [];
        let pending = 0;
        let lastData = 0;
        const start = performance.now();
        const isData = req => /\/api\/v1\/(?:chart|dashboard_data)\/data(?:\?|$)|\/superset\/explore_json\//.test(req.url());
        const onRequest = req => {
          if (!isData(req)) return;
          pending++;
          const body = req.headers()['content-type']?.includes('application/json') ? req.postDataJSON() : null;
          requests.push({ path: new URL(req.url()).pathname, startMs: performance.now() - start,
            chart: body?.form_data?.slice_id, datasource: body?.datasource?.id, query: body?.queries,
            batch: body?.contexts ? body.contexts.map(ctx => ({ chart: ctx.form_data?.slice_id,
              datasource: ctx.datasource?.id, queries: ctx.queries, form: ctx.form_data })) : undefined });
        };
        const onFinished = req => {
          if (!isData(req)) return;
          pending--;
          lastData = performance.now() - start;
        };
        page.on('request', onRequest);
        page.on('requestfinished', onFinished);
        page.on('requestfailed', onFinished);
        await page.goto(origin + '/superset/dashboard/' + slug + '/', { waitUntil: 'domcontentloaded' });
        const documentMs = performance.now() - start;
        await page.waitForFunction(() => {
          const cards = [...document.querySelectorAll('.dashboard-component-chart-holder')]
            .filter(el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
          return cards.length > 0 && cards.every(el => el.querySelector('.header-line, canvas, tbody'));
        }, null, { timeout: 45000 }).catch(async error => {
          fs.writeFileSync(path.resolve(root, 'data/superset-validation/dashboard-debug-requests.json'),
            JSON.stringify(requests, null, 2));
          console.log(JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText()).slice(0, 2500) }));
          throw error;
        });
        const visibleMs = performance.now() - start;
        // Include all initial requests; Superset fetches some charts outside the viewport.
        while (pending || performance.now() - start - lastData < 500) await page.waitForTimeout(50);
        const state = await page.evaluate(chartState);
        page.off('request', onRequest);
        page.off('requestfinished', onFinished);
        page.off('requestfailed', onFinished);
        const run = { slug, round, documentMs: Math.round(documentMs),
          visibleMs: Math.round(visibleMs), dataMs: Math.round(lastData),
          dataLatencyMs: requests.length ? Math.round(lastData - Math.min(...requests.map(r => r.startMs))) : 0,
          requestCount: requests.length, state,
          sharing: await page.evaluate(() => window.__olxDashboardRequests), requests };
        runs.push(run);
        console.log(JSON.stringify({ ...run, requests: undefined }));
      }
    }
    fs.mkdirSync(path.dirname(path.resolve(root, output)), { recursive: true });
    fs.writeFileSync(path.resolve(root, output), JSON.stringify({ at: new Date().toISOString(), runs }, null, 2));
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  console.error(error.message.split('\nCall log:')[0]);
  process.exitCode = 1;
});
