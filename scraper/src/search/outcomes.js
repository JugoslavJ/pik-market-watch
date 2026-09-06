"use strict";

function pagesInWave(start, lastPage, cfg) {
  const pages = [];
  for (
    let page = start;
    page < start + cfg.concurrency && page <= cfg.maxPages && page <= lastPage;
    page++
  ) {
    pages.push(page);
  }
  return pages;
}

function detailJobOutcome(error) {
  const status = Number(error?.status);
  if (["network", "rate_limited"].includes(error?.kind)) {
    return "retryable_failure";
  }
  if (status === 404) return "not_found";
  if (
    !Number.isFinite(status) ||
    [408, 425, 429, 500, 502, 503, 504].includes(status)
  ) {
    return "retryable_failure";
  }
  return "terminal_failure";
}

function pageFailureState(error) {
  const status = Number(error?.status);
  if (error?.kind === "decode") return "blocked";
  if (["schema", "parser"].includes(error?.kind)) return "malformed";
  if ([401, 403, 429].includes(status)) return "blocked";
  if (/blocked|challeng|non-JSON/i.test(String(error?.message || error))) {
    return "blocked";
  }
  if (
    /payload shape|lacks data|parser/i.test(String(error?.message || error))
  ) {
    return "malformed";
  }
  return "error";
}

module.exports = { detailJobOutcome, pageFailureState, pagesInWave };
