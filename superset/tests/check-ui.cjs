/* Optional browser acceptance check. See superset/README.md for setup. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  artifacts,
  origin,
  loadChromium,
  readPassword,
  browserOptions,
} = require("../../tests/helpers/browser.cjs");
const chromium = loadChromium();

// Project a real feature through the rendered Deck viewport. This tests actual
// pointer interactions, including CSP enforcement inside the tooltip sandbox.
function mapPoint() {
  const canvas = document.querySelector('canvas[id^="deckgl"]');
  if (!canvas) return null;
  let element = canvas;
  let key;
  while (element && !key) {
    key = Object.keys(element).find((k) => k.startsWith("__reactFiber$"));
    if (!key) element = element.parentElement;
  }
  for (let fiber = element?.[key]; fiber; fiber = fiber.return) {
    const candidates = [fiber.stateNode?.deck, fiber.stateNode?._deck];
    for (let hook = fiber.memoizedState; hook; hook = hook.next) {
      candidates.push(
        hook.memoizedState?.current,
        hook.memoizedState?.current?.deck,
        hook.memoizedState?.current?._deck,
      );
    }
    const deck = candidates.find((d) => d?.getViewports);
    if (!deck?.getViewports) continue;
    const viewport = deck.getViewports()[0];
    const layer = deck.props.layers.find((l) =>
      l?.id?.startsWith("scatter-layer-"),
    );
    if (!viewport || !layer?.props.data?.length) return null;
    const bounds = canvas.getBoundingClientRect();
    for (const object of layer.props.data) {
      const [x, y] = viewport.project(object.position);
      if (x > 25 && y > 25 && x < bounds.width - 25 && y < bounds.height - 25) {
        return { x: bounds.x + x, y: bounds.y + y };
      }
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  const browser = await chromium.launch(browserOptions());
  let page;
  const errors = [];
  const violations = [];
  const failures = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: "dark",
    });
    // Isolate acceptance checks from login telemetry navigation races and from
    // external OLX navigation; the click still opens its real URL in a new tab.
    await context.route("**/superset/log/**", (route) =>
      route.fulfill({ status: 200, body: "{}" }),
    );
    await context.route(/^https:\/\/(www\.)?olx\.ba\//, (route) =>
      route.fulfill({ status: 200, body: "<p>Link checked</p>" }),
    );
    page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(90000);
    page.on("requestfailed", (request) =>
      failures.push({
        path: new URL(request.url()).pathname,
        error: request.failure()?.errorText,
      }),
    );
    page.on("pageerror", (error) => errors.push(error.message));
    await page.exposeFunction("recordCspViolation", (directive) =>
      violations.push(directive),
    );
    await page.addInitScript(() =>
      document.addEventListener("securitypolicyviolation", (event) =>
        window.recordCspViolation(event.violatedDirective),
      ),
    );
    const secret = readPassword();
    await page.goto(origin + "/login/", { waitUntil: "domcontentloaded" });
    await page.locator("#username").fill("admin");
    await page.locator("#password").fill(secret);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.includes("/login"), {
        waitUntil: "domcontentloaded",
      }),
      page.locator('button[type="submit"], input[type="submit"]').click(),
    ]);
    const login = await context.request.post(
      origin + "/api/v1/security/login",
      {
        data: {
          username: "admin",
          password: secret,
          provider: "db",
          refresh: false,
        },
      },
    );
    const token = (await login.json()).access_token;
    assert.ok(token, "API authentication failed");
    const charts = [];
    for (let index = 0; ; index++) {
      const response = await context.request.get(
        origin +
          "/api/v1/chart/?q=" +
          encodeURIComponent(`(page:${index},page_size:100)`),
        {
          headers: { Authorization: "Bearer " + token },
          maxRetries: 2,
        },
      );
      const listing = await response.json();
      assert.ok(listing.result, "Chart listing failed");
      charts.push(...listing.result);
      if (listing.result.length < 100) break;
    }
    const maps = charts.filter((c) => c.viz_type === "deck_scatter");
    console.log(`Checking ${maps.length} vector maps`);
    assert.equal(maps.length, 4, "Expected both source and companion pin maps");
    for (const chart of maps) {
      errors.length = violations.length = 0;
      let vectors = 0;
      let darkStyle = false;
      const onResponse = async (response) => {
        if (/basemaps\.cartocdn\.com/.test(response.url()) && response.ok()) {
          if (/\/\d+\/\d+\/\d+\.(mvt|pbf)/.test(response.url())) vectors++;
          if (response.url().includes("/dark-matter-gl-style/style.json"))
            darkStyle = true;
        }
      };
      page.on("response", onResponse);
      const response = await page.goto(
        origin + "/explore/?slice_id=" + chart.id + "&standalone=1",
        { waitUntil: "domcontentloaded" },
      );
      assert.match(
        response.headers()["content-security-policy"],
        /'unsafe-eval'/,
      );
      await page
        .waitForFunction(mapPoint, null, { timeout: 60000 })
        .catch(async (error) => {
          await page.screenshot({
            path: path.join(artifacts, "map-failure.png"),
          });
          console.log(
            JSON.stringify({
              url: page.url(),
              body: (await page.locator("body").innerText()).slice(0, 600),
              errors,
              violations,
              canvases: await page.locator("canvas").evaluateAll((els) =>
                els.map((e) => {
                  const chain = [];
                  const key = Object.keys(e).find((k) =>
                    k.startsWith("__reactFiber$"),
                  );
                  for (let f = e[key]; f && chain.length < 20; f = f.return) {
                    const hooks = [];
                    for (
                      let h = f.memoizedState;
                      h && hooks.length < 10;
                      h = h.next
                    )
                      hooks.push(Object.keys(h.memoizedState?.current || {}));
                    chain.push({
                      type:
                        f.type?.name || f.type?.render?.name || String(f.type),
                      nodeKeys: Object.keys(f.stateNode || {}),
                      hooks,
                    });
                  }
                  return { id: e.id, chain };
                }),
              ),
            }),
          );
          throw error;
        });
      const point = await page.evaluate(mapPoint);
      await page.mouse.move(point.x, point.y);
      await page.waitForTimeout(1500);
      assert.doesNotMatch(
        await page.locator("body").innerText(),
        /Data error|Minified React error|EvalError/,
      );
      if (chart.slice_name.includes(" / ")) {
        assert.match(
          await page.locator("body").innerText(),
          /title:/,
          "Hover did not show listing details",
        );
        const [popup] = await Promise.all([
          page.waitForEvent("popup"),
          page.mouse.click(point.x, point.y),
        ]);
        await popup.waitForURL(/^https:\/\/(www\.)?olx\.ba\//);
        await popup.close();
      }
      await page.waitForTimeout(4000);
      assert.ok(
        darkStyle && vectors > 0,
        "Dark vector style/tiles did not load",
      );
      assert.deepEqual(errors, [], "Map JavaScript errors");
      assert.deepEqual(violations, [], "Map CSP violations");
      await page.screenshot({
        path: path.join(artifacts, `dark-map-${chart.id}.png`),
      });
      console.log(
        JSON.stringify({
          chart: chart.slice_name,
          vectors,
          hover: "passed",
          click: chart.slice_name.includes(" / ") ? "passed" : "not configured",
        }),
      );
      page.off("response", onResponse);
    }

    errors.length = violations.length = 0;
    const holder = (board, title) =>
      page.locator(".dashboard-component-chart-holder").filter({
        has: page.getByText(board + " / " + title, { exact: true }),
      });
    // Percentage KPIs live on Home; categorical bars on Market Overview.
    const cards = [
      "Gross rental yield · asking",
      "New sales KM/m² · week over week",
    ];
    await page.goto(origin + "/superset/dashboard/olx-home-superset/", {
      waitUntil: "domcontentloaded",
    });
    for (const width of [1280, 1819]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const title of cards) {
        const card = holder("OLX.ba Home", title);
        await card.scrollIntoViewIfNeeded();
        await card
          .locator(".subtitle-line")
          .waitFor({ state: "visible", timeout: 60000 });
        await page.waitForTimeout(500);
        const size = await card.evaluate((el) => {
          const value = el.querySelector(".header-line");
          const unit = el.querySelector(".subtitle-line");
          return {
            value: parseFloat(getComputedStyle(value).fontSize),
            unit: parseFloat(getComputedStyle(unit).fontSize),
            unitText: unit.textContent,
            overflowing:
              el.querySelector(".superset-legacy-chart-big-number")
                .scrollHeight >
              el.querySelector(".superset-legacy-chart-big-number")
                .clientHeight +
                1,
          };
        });
        assert.ok(
          size.value >= 24 &&
            size.value <= 64 &&
            size.unit >= 10 &&
            size.unit <= 22 &&
            size.unit < size.value / 2,
          JSON.stringify(size),
        );
        assert.equal(size.unitText, "%");
        assert.equal(size.overflowing, false, "KPI content overflows its card");
        console.log(JSON.stringify({ card: title, width, ...size }));
      }
      await holder("OLX.ba Home", cards[0]).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(artifacts, `cards-${width}.png`),
      });
    }
    await page.goto(origin + "/superset/dashboard/olx-overview-superset/", {
      waitUntil: "domcontentloaded",
    });
    for (const width of [1280, 1819]) {
      await page.setViewportSize({ width, height: 1000 });
      const bars = holder(
        "OLX.ba Market Overview",
        "Median KM/m² by floor position · sales",
      );
      await bars.scrollIntoViewIfNeeded();
      await bars
        .locator("canvas")
        .waitFor({ state: "visible", timeout: 60000 });
      const box = await bars.boundingBox();
      assert.ok(box.height >= 400, "Categorical bars are compressed");
      await bars.screenshot({
        path: path.join(artifacts, `floor-bars-${width}.png`),
      });
    }
    assert.deepEqual(errors, [], "Dashboard JavaScript errors");
    assert.deepEqual(violations, [], "Dashboard CSP violations");
    console.log("Browser rendering and map interaction checks passed.");
  } catch (error) {
    if (page) {
      await page
        .screenshot({ path: path.join(artifacts, "browser-failure.png") })
        .catch(() => {});
      console.log(
        JSON.stringify({
          url: page.url(),
          body: (
            await page
              .locator("body")
              .innerText()
              .catch(() => "")
          ).slice(0, 1600),
          errors,
          violations,
          failures,
        }),
      );
    }
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  // Playwright request call logs include authentication headers and cookies.
  console.error(error.message.split("\nCall log:")[0]);
  process.exitCode = 1;
});
