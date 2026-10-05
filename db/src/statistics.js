"use strict";

// Rounded to whole numbers; null for an empty set — callers treat that as
// "no priced data".
function computeMedian(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

module.exports = { computeMedian };
