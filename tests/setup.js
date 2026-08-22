'use strict';
// Loads source files into a shared vm context that mirrors how the browser
// runs content scripts — every file sees globals defined by earlier files.

const vm   = require('node:vm');
const fs   = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// ── Minimal browser stubs ─────────────────────────────────────────────────────

function makeLocalStorage() {
  const store = {};
  return {
    getItem:    k      => store[k] ?? null,
    setItem:    (k, v) => { store[k] = String(v); },
    removeItem: k      => { delete store[k]; },
    clear:      ()     => { Object.keys(store).forEach(k => delete store[k]); },
    _store:     store,
  };
}

/**
 * Minimal `browser.storage.local` stub backed by the given localStorage
 * instance.  Values are JSON-serialised on write / deserialised on read,
 * matching the real WebExtension API.  The same backing store is shared with
 * `localStorage` so the migration path in UserConfig.load() is exercisable.
 * All writes are synchronous inside the returned Promise so persistence tests
 * don't need an extra microtask tick.
 */
function makeBrowserStorage(ls) {
  return {
    storage: {
      local: {
        get(key) {
          const raw = ls.getItem(key);
          let val;
          try { val = raw !== null ? JSON.parse(raw) : undefined; } catch { val = undefined; }
          return Promise.resolve({ [key]: val });
        },
        set(obj) {
          for (const [k, v] of Object.entries(obj)) {
            ls.setItem(k, JSON.stringify(v));
          }
          return Promise.resolve();
        },
      },
    },
  };
}

// ── Context factory ───────────────────────────────────────────────────────────

function makeContext(extra = {}) {
  const ctx = vm.createContext({
    URL, Math, Date, Promise, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: cb => setTimeout(cb, 0),
    localStorage: makeLocalStorage(),
    document: {
      getElementById:   () => null,
      querySelector:    () => null,
      querySelectorAll: () => [],
      createElement:    ()  => ({ style: {}, classList: _classList(), appendChild: () => {} }),
      body: { appendChild: () => {}, querySelectorAll: () => [] },
    },
    ...extra,
  });
  // Expose a helper so tests can reach `const` bindings that don't become
  // properties of the context object (vm limitation with const/let).
  ctx.$get = name => vm.runInContext(name, ctx);
  ctx.$eval = expr => vm.runInContext(expr, ctx);
  return ctx;
}

function _classList(set = new Set()) {
  return {
    add: (...cs) => cs.forEach(c => set.add(c)),
    remove: (...cs) => cs.forEach(c => set.delete(c)),
    toggle: (c, v) => v == null ? (set.has(c) ? set.delete(c) : set.add(c)) : (v ? set.add(c) : set.delete(c)),
    contains: c => set.has(c),
  };
}

// ── File loader ───────────────────────────────────────────────────────────────

function load(ctx, ...relPaths) {
  for (const rel of relPaths) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(src, ctx, { filename: rel });
  }
  return ctx;
}

// ── Pre-built contexts for each test module ───────────────────────────────────

const utilsContext = () =>
  load(makeContext(), 'shared/utils.js');

const loanContext = () =>
  load(makeContext(), 'model/loan-calculator.js');

const rentContext = () =>
  load(makeContext(), 'shared/utils.js', 'model/rent-estimator.js');

/**
 * UserConfig context — includes a `browser.storage.local` stub backed by the
 * same localStorage instance so that load()/save() round-trips work in tests.
 */
const userConfigContext = () => {
  const ls      = makeLocalStorage();
  const browser = makeBrowserStorage(ls);
  return load(
    makeContext({ localStorage: ls, browser }),
    'shared/utils.js', 'model/loan-calculator.js', 'model/user-config.js'
  );
};

const cardParserContext = () =>
  load(makeContext(), 'shared/utils.js', 'model/card-parser.js');

module.exports = {
  makeContext, load, makeLocalStorage,
  utilsContext, loanContext, rentContext, userConfigContext, cardParserContext,
};
