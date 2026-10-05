const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const {
  root,
  origin,
  loadChromium,
  readPassword,
  browserOptions,
} = require("../../tests/helpers/browser.cjs");
const chromium = loadChromium();
const slugs = process.env.SUPERSET_BENCH_DASHBOARDS?.split(",") || [
  "olx-home",
  "olx-overview",
  "olx-exits",
  "olx-health",
];

function visibleReady() {
  if (!window.__olxViewer || window.__olxViewer.fetching) return false;
  return [...document.querySelectorAll(".plot, .table-wrap")]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top < innerHeight && r.bottom > 0;
    })
    .every((el) =>
      el.classList.contains("plot")
        ? el.dataset.ready === "true"
        : !!el.querySelector("table"),
    );
}

async function main() {
  const secret = readPassword();
  const browser = await chromium.launch(browserOptions());
  const output = {
    at: new Date().toISOString(),
    origin,
    viewport: { width: 1440, height: 1000 },
    criterion:
      "Visible plots and tables ready; offscreen panels and external map tiles excluded.",
    opening: [],
    filtering: [],
  };
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/login/", { waitUntil: "domcontentloaded" });
    await page.locator("#username").fill("admin");
    await page.locator("#password").fill(secret);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.includes("/login"), {
        waitUntil: "domcontentloaded",
      }),
      page.locator('button[type="submit"], input[type="submit"]').click(),
    ]);
    for (const slug of slugs) {
      for (
        let round = 0;
        round < Number(process.env.SUPERSET_BENCH_ROUNDS || 4);
        round++
      ) {
        const started = performance.now();
        const response = await page.goto(
          origin +
            "/olx/dashboard/" +
            slug +
            "/" +
            (round === 0 ? "?force=true" : ""),
          { waitUntil: "domcontentloaded" },
        );
        assert.equal(response.status(), 200, "Viewer page should be available");
        const documentMs = Math.round(performance.now() - started);
        await page.waitForFunction(visibleReady);
        const visibleMs = Math.round(performance.now() - started);
        const state = await page.evaluate(() => window.__olxViewer);
        const panels = await page.locator("[data-panel]").count();
        const run = {
          slug,
          round,
          forced: round === 0,
          documentMs,
          visibleMs,
          panels,
          serverTiming: response.headers()["server-timing"],
          ...state,
        };
        output.opening.push(run);
        console.log(JSON.stringify(run));
      }
    }
    await page.goto(origin + "/olx/dashboard/olx-overview/", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(visibleReady);
    const card = page.locator('[data-panel="1"] .value');
    const initial = await card.innerText();
    await page.getByRole("button", { name: /^Filters/ }).click();
    for (let cycle = 0; cycle < 4; cycle++) {
      for (const rooms of ["2", "All"]) {
        let requests = 0;
        const count = (request) => {
          if (request.url().includes("/olx/api/dashboard/")) requests++;
        };
        page.on("request", count);
        const started = performance.now();
        await page.getByLabel("Rooms", { exact: true }).selectOption(rooms);
        await page.waitForFunction(
          ({ initial, rooms }) => {
            const value = document.querySelector(
              '[data-panel="1"] .value',
            )?.textContent;
            return (
              value &&
              (rooms === "All" ? value === initial : value !== initial) &&
              !window.__olxViewer?.fetching
            );
          },
          { initial, rooms },
        );
        await page.waitForFunction(visibleReady);
        const elapsedMs = Math.round(performance.now() - started);
        page.off("request", count);
        const run = { cycle, rooms, elapsedMs, requests };
        output.filtering.push(run);
        console.log(JSON.stringify(run));
      }
    }
    assert.equal(
      errors.length,
      0,
      "Viewer must have no JavaScript errors: " + errors.join("; "),
    );
    await page.screenshot({
      path: path.join(root, "data/superset-validation/viewer-overview.png"),
    });
    fs.writeFileSync(
      path.join(root, "data/superset-validation/viewer-benchmark.json"),
      JSON.stringify(output, null, 2),
    );
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error.message.split("\nCall log:")[0]);
  process.exitCode = 1;
});
