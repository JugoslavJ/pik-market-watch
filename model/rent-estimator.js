// OLX.ba Price per m² — Model: k-nearest-neighbour rent estimator

/**
 * Normalise a room value to a canonical bucket key.
 * 0 → '0' (garsonjera), 1-3 → '1','2','3', 4+ → '4+'
 */
function normRooms(rooms) {
  if (rooms == null) return null;
  const n = parseInt(rooms, 10);
  if (isNaN(n)) return null;
  if (n >= 4) return '4+';
  return String(n);
}

/**
 * Estimate monthly rent for a property using k-nearest-neighbour matching.
 *
 * Pass 1: Exact room match + sqm known
 *   → Inverse-distance-weighted average of up to K nearest by |sqm delta|.
 * Pass 2: Exact room match, sqm unknown
 *   → Median of all listings in that room bucket.
 * Pass 3: No room match, sqm known
 *   → Average of all listings within ±20% sqm (cross-room fallback).
 * Pass 4: Nothing → { est: null }
 *
 * @param {string|number|null} rooms
 * @param {number|null}        sqm
 * @param {{ listings: Array<{rooms, sqm, price}> }} rentStats
 * @returns {{ est: number|null, method: string, neighbours: Array }}
 */
function estimateRent(rooms, sqm, rentStats) {
  const K                = 5;
  const SQM_FALLBACK_PCT = 0.20;

  if (!rentStats?.listings?.length) {
    return { est: null, method: 'nema podataka', neighbours: [] };
  }

  const nr = normRooms(rooms);

  // ── Pass 1 & 2: exact room match ─────────────────────────────────────
  if (nr !== null) {
    const bucket = rentStats.listings.filter(l => normRooms(l.rooms) === nr);

    if (bucket.length > 0) {
      const roomLabel = nr === '0' ? 'garsonjera' : `${nr}-sob`;

      if (sqm == null) {
        const prices = bucket.map(l => l.price).sort((a, b) => a - b);
        return {
          est:        computeMedian(prices),
          method:     `medijan ${roomLabel} (${bucket.length} oglasa)`,
          neighbours: [],
        };
      }

      const withDist = bucket
        .filter(l => l.sqm > 0)
        .map(l => ({ ...l, dist: Math.abs(l.sqm - sqm) }))
        .sort((a, b) => a.dist - b.dist);

      if (withDist.length > 0) {
        const neighbours = withDist.slice(0, K);
        const totalW     = neighbours.reduce((s, n) => s + 1 / (n.dist + 1), 0);
        const est        = Math.round(
          neighbours.reduce((s, n) => s + n.price / (n.dist + 1), 0) / totalW
        );
        const sqmMin = Math.min(...neighbours.map(n => n.sqm));
        const sqmMax = Math.max(...neighbours.map(n => n.sqm));
        const sqmRange = sqmMin === sqmMax ? `${sqmMin} m²` : `${sqmMin}–${sqmMax} m²`;
        return {
          est,
          method:     `${neighbours.length} sličnih ${roomLabel} (${sqmRange})`,
          neighbours,
        };
      }

      // Bucket exists but no sqm data on any listing
      const prices = bucket.map(l => l.price).sort((a, b) => a - b);
      return {
        est:        computeMedian(prices),
        method:     `medijan ${roomLabel} (bez m²)`,
        neighbours: [],
      };
    }
  }

  // ── Pass 3: cross-room sqm fallback ──────────────────────────────────
  if (sqm != null) {
    const lo         = sqm * (1 - SQM_FALLBACK_PCT);
    const hi         = sqm * (1 + SQM_FALLBACK_PCT);
    const sqmMatches = rentStats.listings.filter(l => l.sqm >= lo && l.sqm <= hi);

    if (sqmMatches.length > 0) {
      const est = Math.round(sqmMatches.reduce((s, l) => s + l.price, 0) / sqmMatches.length);
      return {
        est,
        method:     `sličan m² (${sqmMatches.length} oglasa, ±20%)`,
        neighbours: sqmMatches.slice(0, K),
      };
    }
  }

  return { est: null, method: 'nema podataka', neighbours: [] };
}
