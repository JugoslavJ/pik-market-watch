"use strict";
const test = require("node:test");
const { mock } = test;
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter, once } = require("node:events");
const { createRuntime } = require("../../src/runtime");

const searches = [
  { name: "A", searchKey: "a" },
  { name: "B", searchKey: "b" },
];
const config = {
  searches,
  runOnce: false,
  intervalMinutes: 10,
  minRunGapMinutes: 30,
  rateLimitCooldownMs: 1,
  healthPort: 0,
  healthBind: "127.0.0.1",
  healthFailureThreshold: 2,
  abandonedRunAfterMinutes: 60,
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
test.beforeEach(() => mock.timers.enable({ apis: ["setInterval"] }));
test.afterEach(() => mock.timers.reset());
function fixture({
  cfg = {},
  outcomes = {},
  recent = [],
  busy = false,
  overrides = {},
} = {}) {
  const calls = [],
    process = new EventEmitter();
  let server;
  const db = {
    waitUntilReady: async () => {},
    recoverAbandonedRuns: async () => 0,
    tryAcquireCycleLease: async () =>
      busy ? null : { release: async () => calls.push("release") },
    hasRecentFinishedRun: async (_minutes, key) => recent.includes(key),
    closeUnseenListings: async (keys) => {
      calls.push(["close", keys]);
      return 0;
    },
    runMaintenanceCycle: async () => {
      calls.push("maintenance");
      return { ok: true };
    },
    close: async () => calls.push("db-close"),
    ...overrides,
  };
  const runtime = createRuntime(
    { ...config, ...cfg },
    {
      Db: class {
        constructor() {
          return db;
        }
      },
      process,
      log: () => {},
      http: {
        createServer(handler) {
          server = http.createServer(handler);
          return server;
        },
      },
      collectSearch: async (_db, search, _cfg, _log, deps) => {
        calls.push(["collect", search.searchKey, deps.rateBudget]);
        const result = outcomes[search.searchKey];
        if (result instanceof Error) throw result;
        return typeof result === "function" ? result() : { cards: result ?? 1 };
      },
    },
  );
  return {
    runtime,
    db,
    calls,
    process,
    tick: () => mock.timers.tick(config.intervalMinutes * 60000),
    server: () => server,
  };
}

test("failed searches continue the cycle, preserve membership on empty partial results, and run maintenance", async () => {
  const f = fixture({ outcomes: { a: new Error("blocked"), b: 0 } });
  const result = await f.runtime.runAll(f.db);
  assert.equal(result.failedRuns, 1);
  assert.equal(result.okRuns, 1);
  assert.equal(f.calls.filter((x) => x[0] === "collect").length, 2);
  assert.equal(
    f.calls.some((x) => x[0] === "close"),
    false,
  );
  assert.ok(f.calls.includes("maintenance"));
  assert.equal(f.calls.at(-1), "release");
});

test("authoritative empty searches close disabled memberships; nonempty partial cycles retain configured search keys", async () => {
  for (const outcomes of [
    { a: 0, b: 0 },
    { a: 1, b: new Error("blocked") },
  ]) {
    const f = fixture({ outcomes });
    await f.runtime.runAll(f.db);
    assert.deepEqual(
      f.calls.find((x) => x[0] === "close"),
      ["close", ["a", "b"]],
    );
  }
});

test("skipped cycles preserve failure streak and still maintain archives", async () => {
  const f = fixture({ recent: ["a", "b"] });
  f.runtime.state.consecutiveFailures = 1;
  const result = await f.runtime.runAll(f.db);
  assert.equal(result.skipped, 2);
  assert.equal(f.runtime.state.consecutiveFailures, 1);
  assert.deepEqual(f.calls, ["maintenance", "release"]);
});

test("one-shot ignores recent-run gaps and searches share the upstream rate budget", async () => {
  const f = fixture({ cfg: { runOnce: true }, recent: ["a", "b"] });
  await f.runtime.runAll(f.db);
  const collected = f.calls.filter((x) => x[0] === "collect");
  assert.equal(collected.length, 2);
  assert.equal(collected[0][2], collected[1][2]);
});

test("all failed cycles increment health failures; a successful search resets them", async () => {
  const outcomes = { a: new Error("blocked"), b: new Error("blocked") };
  const f = fixture({ outcomes });
  await f.runtime.runAll(f.db);
  await f.runtime.runAll(f.db);
  assert.equal(f.runtime.state.consecutiveFailures, 2);
  outcomes.b = 1;
  await f.runtime.runAll(f.db);
  assert.equal(f.runtime.state.consecutiveFailures, 0);
});

test("lease contention skips scheduled collection but fails an explicit one-shot", async () => {
  for (const runOnce of [false, true]) {
    const f = fixture({ busy: true, cfg: { runOnce } });
    const result = await f.runtime.runAll(f.db);
    assert.equal(result.failedRuns, runOnce ? 1 : 0);
    assert.equal(result.skipped, runOnce ? 0 : 2);
    assert.deepEqual(f.calls, []);
  }
});

test("maintenance failure releases the cycle lease, including with no searches", async () => {
  for (const configured of [[], searches]) {
    const f = fixture({
      cfg: { searches: configured },
      overrides: {
        runMaintenanceCycle: async () => {
          throw new Error("database lost");
        },
      },
    });
    await assert.rejects(f.runtime.runAll(f.db), /database lost/);
    assert.equal(f.calls.at(-1), "release");
  }
});

test("overlapping scheduler ticks cannot start a second cycle and shutdown waits for active work", async () => {
  let resolve;
  const f = fixture();
  const controller = await f.runtime.main();
  f.calls.length = 0;
  const gate = new Promise((done) => {
    resolve = done;
  });
  f.db.runMaintenanceCycle = async () => gate;
  f.tick();
  await flush();
  f.tick();
  assert.equal(f.calls.filter((x) => x[0] === "collect").length, 2);
  const stopped = controller.shutdown("SIGTERM");
  await flush();
  assert.equal(f.calls.includes("db-close"), false);
  resolve({ ok: true });
  await stopped;
  assert.equal(f.calls.at(-1), "db-close");
  assert.equal(controller.healthServer.listening, false);
});

test("shutdown during the initial cycle never starts the scheduler", async () => {
  let resolve;
  const gate = new Promise((done) => {
    resolve = done;
  });
  const f = fixture({ outcomes: { a: () => gate } });
  const started = f.runtime.main();
  await flush();
  f.process.emit("SIGTERM");
  resolve({ cards: 1 });
  // main() only returns a controller once the interval is scheduled.
  assert.equal(await started, undefined);
  await flush();
  assert.ok(f.calls.includes("db-close"));
  assert.equal(f.server().listening, false);
});

test("one-shot closes real health keep-alive connections and sets failure exit status", async () => {
  let resolve;
  const gate = new Promise((done) => {
    resolve = done;
  });
  const f = fixture({
    cfg: { runOnce: true },
    outcomes: { a: () => gate, b: new Error("blocked") },
  });
  const started = f.runtime.main();
  await flush();
  const server = f.server();
  if (!server.listening) await once(server, "listening");
  const agent = new http.Agent({ keepAlive: true });
  try {
    const status = await new Promise((done, reject) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path: "/health",
            agent,
          },
          (response) => {
            response.resume();
            response.on("end", () => done(response.statusCode));
          },
        )
        .on("error", reject);
    });
    assert.equal(status, 200);
    resolve({ cards: 1 });
    await started;
    assert.equal(server.listening, false);
    assert.equal(f.process.exitCode, 1);
  } finally {
    agent.destroy();
  }
});
