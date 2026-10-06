"use strict";

const USER_AGENT =
  process.env.SCRAPE_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const makeLogger =
  (tag) =>
  (...args) =>
    console.log(new Date().toISOString(), `[${tag}]`, ...args);

// Only consecutive fully failed cycles make the scraper unhealthy.
function healthStatus(state, threshold) {
  return state.consecutiveFailures >= threshold ? 503 : 200;
}

function healthPayload(state) {
  return {
    ...state,
    searches: state.searches.map(({ name }) => ({ name })),
  };
}

module.exports = {
  USER_AGENT,
  sleep,
  makeLogger,
  healthStatus,
  healthPayload,
};
