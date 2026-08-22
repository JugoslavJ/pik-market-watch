// OLX.ba Price per m² — shared pure utilities (no DOM, no model dependencies)

function parseNumber(rawString) {
  if (!rawString) return null;
  let s = rawString.replace(/\s/g, '');
  const hasComma = s.includes(','), hasDot = s.includes('.');
  if (hasComma && hasDot) {
    if (s.lastIndexOf('.') > s.lastIndexOf(',')) s = s.replace(/,/g, '');
    else s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    s = s.replace(',', '.');
  } else if (hasDot && s.split('.').pop().length === 3) {
    s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatNumber(v) {
  return v != null ? v.toLocaleString('de-DE') : '\u2014';
}

function getElement(id) { return document.getElementById(id); }

function getPriceColourTier(ppm2, median) {
  if (ppm2 == null || median == null) return '';
  const r = ppm2 / median;
  if (r <= 0.80) return 'olx-ppm2-great';
  if (r <= 1.00) return 'olx-ppm2-good';
  if (r <= 1.20) return 'olx-ppm2-fair';
  return 'olx-ppm2-high';
}

function extractArticleId(url) {
  const m = url.match(/\/artikal\/(\d+)/i);
  return m ? m[1] : null;
}

function buildSearchCacheKey(href) {
  const u = new URL(href);
  u.searchParams.delete('page');
  u.searchParams.delete('olx_scrape');
  u.hash = '';
  return u.pathname + u.search;
}

function computeMedian(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Return values with IQR-fence outliers removed.
 * Also returns { clipped } count so callers can show how many were excluded.
 * k=1.5 is the standard Tukey fence; k=3 is "far outlier" only.
 */
function iqrClip(values, k = 1.5) {
  if (values.length < 4) return { values, clipped: 0 };
  const s  = [...values].sort((a, b) => a - b);
  const n  = s.length;
  const q1 = s[Math.floor(n * 0.25)];
  const q3 = s[Math.floor(n * 0.75)];
  const iqr = q3 - q1;
  const lo  = q1 - k * iqr;
  const hi  = q3 + k * iqr;
  const filtered = values.filter(v => v >= lo && v <= hi);
  return { values: filtered, clipped: values.length - filtered.length };
}

function formatRelativeTime(ms) {
  const mins  = Math.round(ms / 60_000);
  const hours = Math.round(ms / 3_600_000);
  const days  = Math.round(ms / 86_400_000);
  if (days  >= 1) return `${days}d`;
  if (hours >= 1) return `${hours}h`;
  return `${mins} min`;
}

const SerbianDeclension = {
  declinePage(n) {
    const r100 = n % 100, r10 = n % 10;
    if (r100 >= 11 && r100 <= 19) return `${formatNumber(n)} stranica`;
    if (r10 === 1)                  return `${formatNumber(n)} stranici`;
    if (r10 >= 2 && r10 <= 4)      return `${formatNumber(n)} stranice`;
    return `${formatNumber(n)} stranica`;
  },
  declareListing(n) {
    const r100 = n % 100, r10 = n % 10;
    if (r100 >= 11 && r100 <= 19) return `${formatNumber(n)} oglasa`;
    if (r10 === 1)                  return `${formatNumber(n)} oglas`;
    return `${formatNumber(n)} oglasa`;
  },
};

// ── Formatting helpers ────────────────────────────────────────────────────────

/**
 * Format a loan term in months as a human-readable string, e.g. "15g 6mj" or "20g".
 */
function fmtTerm(term) {
  const y = Math.floor(term / 12), m = term % 12;
  return m > 0 ? `${y}g ${m}mj` : `${y}g`;
}

/**
 * Return a CSS colour string for an ROI percentage value.
 * ≥ 5 % → green, ≥ 0 % → amber, < 0 % → red.
 */
function roiColour(roi) {
  if (roi >= 5) return '#10b981';
  if (roi >= 0) return '#f59e0b';
  return '#ef4444';
}

// ── Chart helpers ─────────────────────────────────────────────────────────────

/**
 * Generate approximately `n` "nice" round tick values between `lo` and `hi`.
 * Used by the histogram and room-bar chart axes.
 */
function niceTicks(lo, hi, n = 5) {
  const range = hi - lo || 1;
  const step  = Math.pow(10, Math.floor(Math.log10(range / n)));
  const nice  = [1, 2, 2.5, 5, 10].map(m => m * step)
                  .find(s => range / s <= n + 1) || step;
  const start = Math.ceil(lo / nice) * nice;
  const ticks = [];
  for (let t = start; t <= hi + 1e-9; t += nice) {
    ticks.push(Math.round(t * 1000) / 1000);
  }
  return ticks;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

/** Remove the "hidden" class from a panel element by its id. */
function showEl(id) { getElement(id)?.classList.remove('hidden'); }

/** Add the "hidden" class to a panel element by its id. */
function hideEl(id) { getElement(id)?.classList.add('hidden'); }

const Icons = {
  search(sz) {
    return `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
  },
  download: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="21" x2="12" y2="3"/></svg>`,
};
