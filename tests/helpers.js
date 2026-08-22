// OLX.ba tests — shared helpers, DOM stub, IndexedDB stub

'use strict';

const assert = require('node:assert/strict');
// makeLocalStorage lives in setup.js (which also uses it internally for the vm context)
const { makeLocalStorage } = require('./setup');


function makeEl(html) {
  // Parse the HTML string into a tree of fake elements.
  // We only need: querySelector, querySelectorAll, textContent, closest, href.
  const FakeEl = class {
    constructor(tag, attrs = {}, children = [], textNode = '') {
      this.tagName     = tag.toUpperCase();
      this.attrs       = attrs;
      this.children    = children;
      this._textNode   = textNode;
      this.className   = attrs.class || '';
      this.href        = attrs.href  || '';
      this.dataset     = {};
    }

    get textContent() {
      return this._textNode + this.children.map(c =>
        typeof c === 'string' ? c : c.textContent
      ).join('');
    }

    querySelector(sel) {
      return this._query(sel);
    }

    querySelectorAll(sel) {
      const results = [];
      this._queryAll(sel, results);
      return results;
    }

    closest(sel) {
      return this._matchesSel(sel) ? this : null;
    }

    // ── Internals ─────────────────────────────────────────────────────────

    _matchesSel(sel) {
      // Support: .className, tag, tag.className
      for (const part of sel.split(',')) {
        const s = part.trim();
        if (s.startsWith('.')) {
          if ((' ' + this.className + ' ').includes(' ' + s.slice(1) + ' ')) return true;
        } else if (s.includes('.')) {
          const [tag, cls] = s.split('.');
          if (this.tagName === tag.toUpperCase() &&
              (' ' + this.className + ' ').includes(' ' + cls + ' ')) return true;
        } else {
          if (this.tagName === s.toUpperCase()) return true;
        }
      }
      return false;
    }

    _query(sel) {
      for (const child of this.children) {
        if (typeof child === 'string') continue;
        if (child._matchesSel(sel)) return child;
        const found = child._query(sel);
        if (found) return found;
      }
      return null;
    }

    _queryAll(sel, out) {
      for (const child of this.children) {
        if (typeof child === 'string') continue;
        if (child._matchesSel(sel)) out.push(child);
        child._queryAll(sel, out);
      }
    }
  };

  // Simple builder helpers
  const el = (tag, attrs, ...children) => new FakeEl(tag, attrs, children);
  const txt = s => s;

  // Parse the literal HTML we need for tests using the builder
  return { FakeEl, el, txt };
}

// ── Minimal IndexedDB stub ────────────────────────────────────────────────────
// Synchronous in-memory implementation that fulfils the Promise-based API
// used by ListingsDatabase.

function makeIDB() {
  const stores = {};

  function makeStore(name) {
    if (!stores[name]) stores[name] = {};
    return {
      get(key) {
        return new Promise(res => res(stores[name][key] ?? null));
      },
      put(record, keyPath) {
        const key = record[keyPath];
        stores[name][key] = record;
        return Promise.resolve();
      },
      getAll() {
        return Promise.resolve(Object.values(stores[name]));
      },
    };
  }

  // Build a fake IDB transaction + objectStore
  function fakeDB(storeNames) {
    const db = {
      objectStoreNames: { contains: n => storeNames.includes(n) },
      transaction(storeName) {
        const store = makeStore(storeName);
        const reqWrap = (p, keyPath = 'key') => {
          const req = {};
          req.onsuccess = null;
          req.onerror   = null;
          p.then(v => { req.result = v; if (req.onsuccess) req.onsuccess({ target: req }); })
           .catch(e => { req.error = e; if (req.onerror) req.onerror(); });
          return req;
        };
        return {
          objectStore() {
            return {
              get:    key    => reqWrap(store.get(key)),
              put:    record => reqWrap(store.put(record, Object.keys(record)[0])),
              getAll: ()     => reqWrap(store.getAll()),
            };
          },
          oncomplete: null,
          onerror:    null,
          // auto-complete
          get _completePromise() { return Promise.resolve(); },
        };
      },
    };
    return db;
  }

  return { makeStore, fakeDB, stores };
}

// ── Test runner (wraps node:test for readable output) ─────────────────────────

const { test, describe } = require('node:test');

function approxEqual(a, b, tol = 0.01, msg = '') {
  const diff = Math.abs(a - b);
  assert.ok(diff <= tol, `${msg || ''}expected ${a} ≈ ${b} (diff=${diff.toFixed(6)}, tol=${tol})`);
}

module.exports = { assert, test, describe, approxEqual, makeLocalStorage, makeIDB, makeEl };
