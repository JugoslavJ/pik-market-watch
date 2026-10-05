/* Installed before Superset's fetch client. Keep each plugin's normal response
 * contract while sharing summary queries and batching a dashboard render wave.
 */
(() => {
  if (window.__olxDashboardRequests) return;
  const fetchOriginal = window.fetch.bind(window);
  const pending = new Map();
  const completed = new Map();
  let queue = [];
  let timer;
  const stats = (window.__olxDashboardRequests = {
    batches: 0,
    queries: 0,
    shared: 0,
    replayed: 0,
  });
  const stable = (value) =>
    JSON.stringify(value, (_, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    );
  const response = (item) =>
    new Response(item.body, {
      status: item.status,
      headers: { "Content-Type": "application/json" },
    });

  function subscribe(promise, signal) {
    return new Promise((resolve, reject) => {
      const abort = () =>
        reject(new DOMException("The request was aborted", "AbortError"));
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      promise.then(
        (item) => {
          signal?.removeEventListener("abort", abort);
          if (!signal?.aborted) resolve(response(item));
        },
        (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }

  function remember(key, item, ttl) {
    if (!(ttl > 0)) return;
    if (completed.size >= 100) completed.delete(completed.keys().next().value);
    completed.set(key, { item, expires: Date.now() + ttl * 1000 });
  }

  function legacyMap(url, target, options) {
    let form;
    try {
      const raw =
        options.body?.get?.("form_data") ||
        target.searchParams.get("form_data") ||
        (typeof options.body === "string" &&
          new URLSearchParams(options.body).get("form_data"));
      form = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return fetchOriginal(url, options);
    }
    if (!form?.dashboardId || !String(form.viz_type).startsWith("deck_"))
      return fetchOriginal(url, options);
    const force = form.force || target.searchParams.get("force") === "true";
    if (force) completed.clear();
    // Exact map form and URL: layer, viewport, RLS and filter settings must not
    // be shared across different requests. Data stays in this document only.
    const key = "map:" + target.href + ":" + stable(form);
    const old = completed.get(key);
    let promise;
    if (!force && old && old.expires > Date.now()) {
      stats.replayed++;
      promise = Promise.resolve(old.item);
    } else if (pending.has(key)) {
      stats.shared++;
      promise = pending.get(key);
    } else {
      promise = fetchOriginal(url, { ...options, signal: undefined }).then(
        async (result) => {
          const item = { status: result.status, body: await result.text() };
          if (result.ok) {
            const payload = JSON.parse(item.body);
            if (!payload.error && payload.status !== "failed")
              remember(
                key,
                item,
                Math.min(
                  Number(form.cache_timeout),
                  Number(payload.cache_timeout ?? form.cache_timeout),
                ),
              );
          }
          return item;
        },
      );
      pending.set(key, promise);
      promise.then(
        () => pending.delete(key),
        () => pending.delete(key),
      );
    }
    return subscribe(promise, options.signal);
  }

  async function flush() {
    const wave = queue;
    queue = [];
    timer = undefined;
    stats.batches++;
    stats.queries += wave.length;
    try {
      const first = wave[0];
      const url = new URL(first.url, location.href);
      url.pathname = url.pathname.replace(
        "/chart/data",
        "/dashboard_data/data",
      );
      url.search = "";
      const result = await fetchOriginal(url.href, {
        ...first.options,
        signal: undefined,
        body: JSON.stringify({ contexts: wave.map((item) => item.context) }),
        headers: {
          ...Object.fromEntries(new Headers(first.options.headers)),
          "X-Dashboard-Stream": "1",
        },
      });
      // Allow the normal API to keep working with a server that has not yet
      // installed the extension (rolling deployment or a reverted image).
      if (result.status === 404) {
        await Promise.all(
          wave.map(async (item) => {
            const original = await fetchOriginal(item.url, {
              ...item.options,
              signal: undefined,
              body: JSON.stringify(item.context),
            });
            item.resolve({
              status: original.status,
              body: await original.text(),
            });
          }),
        );
        return;
      }
      if (!result.ok)
        throw new Error("Dashboard data request failed: " + result.status);
      if (
        result.headers.get("Content-Type")?.includes("application/x-ndjson")
      ) {
        const reader = result.body.getReader();
        const decoder = new TextDecoder();
        const received = new Set();
        let buffer = "";
        function line(raw) {
          if (!raw.trim()) return;
          const { index, result: item } = JSON.parse(raw);
          if (!Number.isInteger(index) || !wave[index] || received.has(index))
            throw new Error("Invalid dashboard stream item");
          received.add(index);
          wave[index].resolve(item);
        }
        for (;;) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            line(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
          }
          if (done) break;
        }
        line(buffer);
        if (received.size !== wave.length)
          throw new Error("Incomplete dashboard stream");
        return;
      }
      const payload = await result.json();
      if (payload.result?.length !== wave.length)
        throw new Error("Invalid dashboard batch response");
      wave.forEach((item, index) => item.resolve(payload.result[index]));
    } catch (error) {
      wave.forEach((item) => item.reject(error));
    }
  }

  window.fetch = function (url, options = {}) {
    const target =
      typeof url === "string" || url instanceof URL
        ? new URL(url, location.href)
        : null;
    if (
      target?.origin === location.origin &&
      target.pathname === "/superset/explore_json/"
    )
      return legacyMap(url, target, options);
    if (
      !target ||
      target.origin !== location.origin ||
      options.method !== "POST" ||
      !target.pathname.endsWith("/api/v1/chart/data") ||
      typeof options.body !== "string"
    ) {
      return fetchOriginal(url, options);
    }
    let context;
    try {
      context = JSON.parse(options.body);
    } catch {
      return fetchOriginal(url, options);
    }
    if (
      !context.form_data?.dashboardId ||
      context.result_format !== "json" ||
      context.result_type !== "full"
    )
      return fetchOriginal(url, options);
    const shared = context.form_data.dashboard_shared_metrics;
    if (
      shared?.length &&
      context.queries.length === 1 &&
      context.form_data.viz_type === "big_number_total"
    ) {
      context.queries[0].metrics = shared;
      context.queries[0].orderby = [];
      context.form_data.metric = shared[0];
    }
    const keyForm = { ...context.form_data };
    delete keyForm.slice_id;
    delete keyForm.chart_id;
    if (context.force) completed.clear();
    if (shared?.length) {
      for (const name of [
        "y_axis_format",
        "y_axis_title",
        "subtitle",
        "subtitle_font_size",
        "subheader",
        "subheader_font_size",
        "header_font_size",
        "show_metric_name",
      ])
        delete keyForm[name];
    }
    const key = stable({ ...context, form_data: keyForm });
    const old = completed.get(key);
    let promise;
    if (!context.force && old && old.expires > Date.now()) {
      stats.replayed++;
      promise = Promise.resolve(old.item);
    } else if (pending.has(key)) {
      stats.shared++;
      promise = pending.get(key);
    } else {
      promise = new Promise((resolve, reject) =>
        queue.push({ url, options, context, resolve, reject }),
      );
      pending.set(key, promise);
      if (timer === undefined) timer = setTimeout(flush, 10);
      promise.then(
        (item) => {
          pending.delete(key);
          if (item.status !== 200) return;
          const results = JSON.parse(item.body).result;
          const ttl = Math.min(
            ...(results || []).map((result) => result.cache_timeout),
          );
          if (
            !results?.length ||
            !ttl ||
            ttl <= 0 ||
            results.some((result) => result.error)
          )
            return;
          // Bound memory and follow the server's freshness policy. Operational
          // datasets use -1 and always fetch fresh results, even on filter clear.
          remember(key, item, ttl);
        },
        () => pending.delete(key),
      );
    }
    return subscribe(promise, options.signal);
  };
})();
