'use strict';
// Small helpers shared by the scraping entry points.

// Browser-like UA: Cloudflare scores bare runtime UAs ("node") harshly. The
// default mimics a real Chrome session; override via SCRAPE_USER_AGENT once it
// ages into an obviously stale fingerprint.
const USER_AGENT = process.env.SCRAPE_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Rounded to whole numbers; null for an empty set — callers treat that as
// "no priced data".
function computeMedian(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// Timestamped console logger shared by the entry points: `<iso> [tag] msg…`.
const makeLogger = tag => (...args) =>
  console.log(new Date().toISOString(), `[${tag}]`, ...args);

// HTTP status for the /health endpoint: 503 only once WHOLE scrape cycles keep
// failing end-to-end (consecutiveFailures >= threshold). Transient single-cycle
// outages, partial successes and 'skipped' boot ticks never flip the container
// unhealthy — an always-green endpoint hides a dead scraper from Docker and
// any uptime probe.
function healthStatus(state, threshold) {
  return state.consecutiveFailures >= threshold ? 503 : 200;
}

module.exports = { USER_AGENT, sleep, computeMedian, makeLogger, healthStatus };
