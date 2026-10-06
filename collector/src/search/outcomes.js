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

function pageFailureState(error) {
  if (error?.kind === "decode") return "blocked";
  if (["schema", "parser"].includes(error?.kind)) return "malformed";
  if ([401, 403, 429].includes(Number(error?.status))) return "blocked";
  return "error";
}

module.exports = { pageFailureState, pagesInWave };
