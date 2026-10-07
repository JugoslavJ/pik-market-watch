const path = require("node:path");
const assert = require("node:assert/strict");
const {
  root,
  origin,
  loadChromium,
  readPassword,
  browserOptions,
} = require("../../tests/helpers/browser.cjs");
const chromium = loadChromium();

async function main() {
  const password = readPassword();
  const browser = await chromium.launch(browserOptions());
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    const errors = [],
      tiles = [],
      mapNetwork = [],
      consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error")
        consoleErrors.push(message.text().slice(0, 300));
    });
    page.on("requestfailed", (request) => {
      if (request.url().includes("basemaps"))
        mapNetwork.push({
          url: request.url(),
          error: request.failure()?.errorText,
        });
    });
    page.on("response", (response) => {
      if (response.url().includes("basemaps"))
        mapNetwork.push({ url: response.url(), status: response.status() });
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/basemaps.*\.pbf/.test(request.url())) tiles.push(request.url());
    });
    await page.addInitScript(() => {
      window.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        window.__csp.push(e.violatedDirective),
      );
    });
    for (const uid of ["olx-home", "olx-overview", "olx-exits", "olx-health"]) {
      const path = "/olx/dashboard/" + uid + "/?days=7";
      const anonymous = await context.request.get(origin + path, {
        maxRedirects: 0,
      });
      assert.equal(
        anonymous.status(),
        302,
        "Anonymous viewer pages must redirect instead of returning 500",
      );
      const login = new URL(anonymous.headers().location, origin);
      assert.equal(login.pathname, "/login/");
      assert.equal(login.searchParams.get("next"), path);
      const api = await context.request.get(
        origin + "/olx/api/dashboard/" + uid,
        { maxRedirects: 0 },
      );
      assert.equal(api.status(), 401);
      assert.equal(api.headers()["cache-control"], "no-store");
      assert.ok((await api.json()).loginUrl);
      assert.equal((await api.json()).rows, undefined);
    }
    await context.clearCookies();
    await page.goto(origin + "/", { waitUntil: "load" });
    assert.equal(new URL(page.url()).pathname, "/login/");
    assert.equal(
      new URL(page.url()).searchParams.get("next"),
      "/olx/dashboard/olx-overview/",
    );
    await page.locator("#username").fill("admin");
    await page.locator("#password").fill(password);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.includes("/login"), {
        waitUntil: "domcontentloaded",
      }),
      page.locator('button[type="submit"], input[type="submit"]').click(),
    ]);
    await page.goto(origin + "/olx/dashboard/olx-overview/", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(() => !!window.__olxViewer);
    assert.equal(
      await page
        .getByRole("button", { name: /^Filters/ })
        .getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(await page.locator("#dashboard-filters").isVisible(), false);
    assert.equal(
      await page.getByRole("link", { name: /Explore in Superset/ }).count(),
      0,
    );
    const initial = await page.locator('[data-panel="1"] .value').innerText();
    assert.equal(await page.locator("[data-panel]").count(), 20);
    console.log("Viewer loaded; checking chart click");
    await page.locator('[data-panel="8"]').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => window.__olxChartInstances?.has(8));
    const point = await page.evaluate(() => {
      const instance = window.__olxChartInstances.get(8),
        series = instance.getModel().getSeries()[0];
      const layout = series.getData().getItemLayout(0),
        bounds = instance.getDom().getBoundingClientRect();
      return {
        x: bounds.x + layout.x + layout.width / 2,
        y: bounds.y + layout.y + layout.height / 2,
      };
    });
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(
      (initial) =>
        document.querySelector('[data-panel="1"] .value')?.textContent !==
          initial && !window.__olxViewer.fetching,
      initial,
    );
    assert.ok(
      await page.locator(".selections").innerText(),
      "Chart click should create a selection",
    );
    await page.locator(".selections button").click();
    await page.waitForFunction(
      (initial) =>
        document.querySelector('[data-panel="1"] .value')?.textContent ===
          initial && !window.__olxViewer.fetching,
      initial,
    );
    console.log("Chart click and clear passed; checking retained content");
    await page.locator('[data-panel="1"]').scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      window.__retainedCard = document.querySelector('[data-panel="1"] .value');
      window.__retainedValue = window.__retainedCard.textContent;
      window.__retainedChart = window.__olxChartInstances.get(8);
      window.__retainedChartValues = JSON.stringify(
        window.__retainedChart.getOption().series.map((series) => series.data),
      );
    });
    const delayed = async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    };
    await page.route("**/olx/api/dashboard/**", delayed);
    await page.getByRole("button", { name: /^Filters/ }).click();
    await page.getByLabel("Rooms", { exact: true }).selectOption("3");
    await page.waitForTimeout(150);
    assert.ok(
      await page.evaluate(
        () =>
          window.__retainedCard.isConnected &&
          window.__retainedCard.textContent === window.__retainedValue,
      ),
      "Old KPI must stay visible during refresh",
    );
    assert.ok(
      await page.evaluate(
        () =>
          window.__retainedChart === window.__olxChartInstances.get(8) &&
          !window.__retainedChart.isDisposed() &&
          JSON.stringify(
            window.__retainedChart
              .getOption()
              .series.map((series) => series.data),
          ) === window.__retainedChartValues,
      ),
      "Existing chart instance and plotted values must remain during refresh",
    );
    assert.equal(
      await page.locator('.panel [role="status"], .panel .loading').count(),
      0,
    );
    await page.waitForFunction(() => !window.__olxViewer.fetching);
    await page.unroute("**/olx/api/dashboard/**", delayed);
    await page.getByLabel("Rooms", { exact: true }).selectOption("All");
    await page.waitForFunction(() => !window.__olxViewer.fetching);
    await page.locator('[data-panel="13"]').scrollIntoViewIfNeeded();
    console.log("Retained content passed; checking vector map");
    await page
      .waitForFunction(
        () =>
          document.querySelector('[data-panel="13"] .map')?.dataset.ready ===
          "true",
      )
      .catch(async (error) => {
        console.log(
          JSON.stringify({
            errors,
            consoleErrors,
            mapNetwork,
            csp: await page.evaluate(() => window.__csp),
            tiles: tiles.length,
            map: await page.locator('[data-panel="13"]').innerText(),
          }),
        );
        throw error;
      });
    assert.ok(tiles.length, "Map must fetch vector tiles");
    await page.locator('[data-panel="16"]').scrollIntoViewIfNeeded();
    await page.locator('[data-panel="16"] table').waitFor();
    assert.ok(
      await page.locator('[data-panel="16"] td a[href^="https://"]').count(),
    );
    await page.locator('[data-panel="16"] th button').first().click();
    const downloadPromise = page.waitForEvent("download");
    await page.locator('[data-panel="16"] button', { hasText: "CSV" }).click();
    assert.equal(
      (await downloadPromise).suggestedFilename(),
      "best-value-lowest-km-m-sales.csv",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__csp), []);
    await page.screenshot({
      path: path.join(root, "data/superset-validation/viewer-map.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "Collapse filters", exact: true })
      .click();
    await page.locator('[data-panel="1"]').scrollIntoViewIfNeeded();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "Phone layout must not overflow",
    );
    await context.clearCookies();
    const retained = await page.locator('[data-panel="1"] .value').innerText();
    await page.getByRole("button", { name: /^Filters/ }).click();
    await page.getByLabel("Rooms", { exact: true }).selectOption("4");
    await page.getByRole("alert").waitFor();
    assert.ok(
      (await page.getByRole("alert").innerText()).includes(
        "Please sign in again",
      ),
    );
    assert.equal(
      await page.locator('[data-panel="1"] .value').innerText(),
      retained,
    );
    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.locator("#username").waitFor();
    assert.equal(new URL(page.url()).pathname, "/login/");
    console.log(
      "Viewer acceptance passed: anonymous login redirects, expired session, chart cross-filter and clear, retained KPI/chart, vector map, links, table sorting, CSV, CSP and phone layout.",
    );
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error.message.split("\nCall log:")[0]);
  process.exitCode = 1;
});
