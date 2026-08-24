'use strict';
// Small helpers shared by the scraping entry points.

// Browser-like UA: Cloudflare scores bare runtime UAs ("node") harshly, and
// this exact string is what millions of real Chrome sessions send.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Port of computeMedian() from the original extension (rounded to whole
// numbers; null for an empty set — callers treat that as "no priced data").
function computeMedian(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// Timestamped console logger shared by the entry points: `<iso> [tag] msg…`.
const makeLogger = tag => (...args) =>
  console.log(new Date().toISOString(), `[${tag}]`, ...args);

module.exports = { USER_AGENT, sleep, computeMedian, makeLogger };
