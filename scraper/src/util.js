'use strict';
// Small helpers shared by the scraping entry points.

// Playwright's headless UA advertises "HeadlessChrome", which some bot
// filters reject outright; a plain, current Chrome UA does not.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { USER_AGENT, sleep };
