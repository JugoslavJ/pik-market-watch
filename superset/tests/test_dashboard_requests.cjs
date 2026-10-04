const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const script = fs.readFileSync(path.join(__dirname, '../dashboard_requests.js'), 'utf8');
const metrics = ['active', 'rent'].map(label => ({ label, expressionType: 'SQL', sqlExpression: `MAX("${label}")` }));

function context(id, extra = {}) {
  return { datasource: { id: 10, type: 'table' }, force: false, result_format: 'json', result_type: 'full',
    queries: [{ columns: [], metrics: [metrics[id === 1 ? 0 : 1]], filters: [], orderby: [] }],
    form_data: { slice_id: id, chart_id: id, dashboardId: 2, viz_type: 'big_number_total',
      metric: metrics[id === 1 ? 0 : 1], dashboard_shared_metrics: metrics,
      subtitle: id === 1 ? '' : 'BAM', ...extra } };
}

function setup({ ttl = 600, failure = false, fallback = false } = {}) {
  const calls = [];
  const window = { fetch: async (url, options) => {
    calls.push({ url: String(url), payload: JSON.parse(options.body) });
    if (fallback && String(url).includes('/dashboard_data/')) return new Response('{}', { status: 404 });
    const result = { result: [{ cache_timeout: ttl, data: [{ active: 10, rent: 500 }] }] };
    if (String(url).includes('/dashboard_data/')) {
      return new Response(JSON.stringify({ result: calls.at(-1).payload.contexts.map(() => ({
        status: failure ? 400 : 200, body: JSON.stringify(failure ? { message: 'failed' } : result),
      })) }));
    }
    return new Response(JSON.stringify(result));
  } };
  vm.runInNewContext(script, { window, location: { href: 'https://example.test/superset/dashboard/2/', origin: 'https://example.test' },
    URL, URLSearchParams, Response, Headers, TextDecoder, DOMException, Date, setTimeout });
  const fetchChart = (body, options = {}) => window.fetch('https://example.test/api/v1/chart/data', {
    method: 'POST', body: JSON.stringify(body), ...options,
  });
  return { calls, window, fetchChart };
}

test('two summary cards execute one shared query and keep both metric values', async () => {
  const { calls, fetchChart, window } = setup();
  const responses = await Promise.all([fetchChart(context(1)), fetchChart(context(2))]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.contexts.length, 1);
  assert.equal(calls[0].payload.contexts[0].queries[0].metrics.length, 2);
  for (const response of responses) assert.deepEqual((await response.json()).result[0].data[0], { active: 10, rent: 500 });
  assert.equal(window.__olxDashboardRequests.shared, 1);
  await fetchChart(context(2));
  assert.equal(calls.length, 1, 'Repeated selection should reuse unexpired data');
});

test('different filters batch separately and force refresh invalidates replay', async () => {
  const { calls, fetchChart } = setup();
  const a = context(1);
  const b = context(2);
  b.queries[0].filters = [{ col: 'rooms', op: 'IN', val: ['2'] }];
  await Promise.all([fetchChart(a), fetchChart(b)]);
  assert.equal(calls[0].payload.contexts.length, 2);
  await fetchChart({ ...a, force: true });
  assert.equal(calls.length, 2);
  await fetchChart(b);
  assert.equal(calls.length, 3, 'Explicit refresh must clear older cached selections');
});

test('operational data and errors are never replayed', async () => {
  for (const settings of [{ ttl: -1 }, { failure: true }]) {
    const { calls, fetchChart } = setup(settings);
    await fetchChart(context(1));
    await fetchChart(context(1));
    assert.equal(calls.length, 2);
  }
});

test('aborting one card does not cancel the shared request for its sibling', async () => {
  const { fetchChart, calls } = setup();
  const controller = new AbortController();
  const aborted = fetchChart(context(1), { signal: controller.signal });
  const retained = fetchChart(context(2));
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  assert.equal((await retained).status, 200);
  assert.equal(calls.length, 1);
});

test('rolling deployments fall back to the standard API', async () => {
  const { calls, fetchChart } = setup({ fallback: true });
  assert.equal((await fetchChart(context(1))).status, 200);
  assert.equal(calls.length, 2);
});

test('legacy maps reuse exact filter results and explicit refresh clears them', async () => {
  let calls = 0;
  const window = { fetch: async () => {
    calls++;
    return new Response(JSON.stringify({ cache_timeout: 600, data: { features: [] } }));
  } };
  vm.runInNewContext(script, { window, location: { href: 'https://example.test/', origin: 'https://example.test' },
    URL, URLSearchParams, Response, Headers, TextDecoder, DOMException, Date, setTimeout });
  const form = { dashboardId: 2, viz_type: 'deck_scatter', cache_timeout: 600, filters: [] };
  const fetchMap = (value, force = false) => window.fetch('https://example.test/superset/explore_json/' + (force ? '?force=true' : ''),
    { method: 'POST', body: new URLSearchParams({ form_data: JSON.stringify(value) }) });
  await fetchMap(form);
  await fetchMap(form);
  assert.equal(calls, 1);
  await fetchMap({ ...form, filters: ['rooms:2'] });
  assert.equal(calls, 2);
  await fetchMap(form, true);
  await fetchMap(form);
  assert.equal(calls, 4);
});

test('streamed summaries resolve before a later slow chart', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const window = { fetch: async () => new Response(new ReadableStream({ async start(controller) {
    const result = { status: 200, body: JSON.stringify({ result: [{ cache_timeout: -1, data: [] }] }) };
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ index: 0, result }) + '\n'));
    await gate;
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ index: 1, result }) + '\n'));
    controller.close();
  } }), { headers: { 'Content-Type': 'application/x-ndjson' } }) };
  vm.runInNewContext(script, { window, location: { href: 'https://example.test/', origin: 'https://example.test' },
    URL, URLSearchParams, Response, Headers, TextDecoder, DOMException, Date, setTimeout });
  const fetchChart = body => window.fetch('https://example.test/api/v1/chart/data', { method: 'POST', body: JSON.stringify(body) });
  const second = context(2);
  second.queries[0].filters = ['other'];
  const fast = fetchChart(context(1));
  let finished = false;
  const slow = fetchChart(second).then(() => { finished = true; });
  await fast;
  assert.equal(finished, false, 'First result must arrive while the second is still running');
  release();
  await slow;
});
