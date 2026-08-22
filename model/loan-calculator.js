// OLX.ba Price per m² — Model: loan fee structure and payment calculations
//
// Fees confirmed from bank data for a 40 000 KM reference loan:
//   fee(months) = 1 779.38 + 4.00 × months
//   (1 779.38 KM fixed origination; 4.00 KM/month insurance + admin)
//
// The fee is an absolute KM amount independent of principal.
// Larger loans attract proportionally lower effective rates.
//
// Nominal rate bands:
//   6–120 months  : 3.19%
//   121–180 months: 3.99%
//   181–240 months: 4.69%

const LoanCalculator = (() => {
  const FEE_FIXED     = 1779.38;
  const FEE_PER_MONTH = 4.00;

  const NOMINAL_BANDS = [
    { lo:   6, hi: 120, nom: 0.0319 },
    { lo: 121, hi: 180, nom: 0.0399 },
    { lo: 181, hi: 240, nom: 0.0469 },
  ];

  function bandForTerm(months) {
    for (const b of NOMINAL_BANDS) {
      if (months >= b.lo && months <= b.hi) return b;
    }
    return months < 6 ? NOMINAL_BANDS[0] : NOMINAL_BANDS[NOMINAL_BANDS.length - 1];
  }

  function absoluteFee(months) {
    return FEE_FIXED + FEE_PER_MONTH * months;
  }

  /**
   * Monthly payment for principal over months.
   * Bank prices the loan on (principal + absolute fee) at the nominal rate.
   */
  function monthlyPayment(principal, months) {
    if (principal <= 0 || months <= 0) return 0;
    const band     = bandForTerm(months);
    const fee      = absoluteFee(months);
    const r        = band.nom / 12;
    const inflated = principal + fee;
    if (r === 0) return inflated / months;
    return inflated * r / (1 - Math.pow(1 + r, -months));
  }

  /**
   * True effective annual rate for a given principal and term.
   * Back-solves the monthly effective rate via Newton-Raphson, then annualises.
   */
  function effectiveAnnualRate(principal, months) {
    if (principal <= 0 || months <= 0) return 0;
    const pmt = monthlyPayment(principal, months);
    let r = pmt / principal / months;
    for (let i = 0; i < 300; i++) {
      if (r <= -1) r = 1e-8;
      const pow   = Math.pow(1 + r, months);
      const denom = pow - 1;
      if (Math.abs(denom) < 1e-15) break;
      const f  = principal * r * pow / denom - pmt;
      const df = principal * pow * (denom - months * r) / (denom * denom);
      const step = f / (df || 1e-15);
      r -= step;
      if (Math.abs(step) < 1e-13) break;
    }
    return Math.pow(1 + r, 12) - 1;
  }

  /**
   * Build a full loan result object for a given principal and term.
   */
  function loanResult(principal, downPayment, term, fitsBudget) {
    return {
      term,
      principal,
      downPayment,
      payment:       monthlyPayment(principal, term),
      effectiveRate: effectiveAnnualRate(principal, term),
      nominalRate:   bandForTerm(term).nom,
      fitsBudget,
    };
  }

  /**
   * Budget-optimal loan: for each rate band find the shortest term that fits the
   * budget (binary search), then pick the band with the lowest total repaid.
   *
   * Within a flat rate band total repaid (payment × term) is strictly increasing
   * with term length, so the shortest fitting term in each band is always optimal
   * for that band. We only need to compare one candidate per band — O(log n)
   * instead of scanning all 235 terms.
   */
  function selectOptimal(principal, downPayment, maxMonthlyPayment) {
    let best = null;

    for (const band of NOMINAL_BANDS) {
      // Binary search for the shortest term in this band where payment ≤ budget
      let lo = band.lo, hi = band.hi, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (monthlyPayment(principal, mid) <= maxMonthlyPayment) {
          found = mid;
          hi = mid - 1;   // try shorter
        } else {
          lo = mid + 1;   // need longer
        }
      }
      if (found < 0) continue;  // entire band over budget

      const totalRepaid = monthlyPayment(principal, found) * found;
      if (!best || totalRepaid < best.totalRepaid) {
        best = { ...loanResult(principal, downPayment, found, true), totalRepaid };
      }
    }

    // Nothing fits — return 240-month flagged over-budget
    return best || { ...loanResult(principal, downPayment, 240, false), totalRepaid: Infinity };
  }

  /**
   * Minimum down payment so that the 240-month loan achieves a target ROI.
   * roiTargetPct=0 → rent just covers the payment (break-even).
   * roiTargetPct=3 → net annual = 3% of purchase price.
   *
   * @param {number} price
   * @param {number} potRent      — estimated monthly rent (KM)
   * @param {number} roiTargetPct — target annual ROI % (default 0)
   * @returns {{ downPayment, downPct, feasible }}
   */
  function minDownPaymentForROI(price, potRent, roiTargetPct = 0) {
    if (!price || !potRent || potRent <= 0) {
      return { downPayment: price, downPct: 100, feasible: false };
    }
    const n    = 240;
    const r    = bandForTerm(n).nom / 12;
    const fee  = absoluteFee(n);
    const annuityFactor = r / (1 - Math.pow(1 + r, -n));

    // Required payment so (potRent - payment) * 12 / price = roiTargetPct / 100
    const requiredPayment = potRent - price * roiTargetPct / 1200;
    if (requiredPayment <= 0) {
      return { downPayment: price, downPct: 100, feasible: false };
    }

    const maxPrincipal = requiredPayment / annuityFactor - fee;

    if (maxPrincipal >= price) {
      return { downPayment: 0, downPct: 0, feasible: true };
    }
    if (maxPrincipal <= 0) {
      return { downPayment: price, downPct: 100, feasible: false };
    }
    const downPayment = Math.ceil(price - maxPrincipal);
    return {
      downPayment,
      downPct:  (downPayment / price) * 100,
      feasible: true,
    };
  }

  /**
   * Total nominal profit over a loan term, accounting for rent growth.
   * = sum_{k=0}^{n-1} [potRent*(1+g/12)^k] - payment*n
   *
   * @param {number} potRent       — current monthly rent (KM)
   * @param {number} payment       — fixed monthly loan payment (KM)
   * @param {number} termMonths    — loan term in months
   * @param {number} rentGrowthRate — annual rent growth fraction (e.g. 0.03)
   */
  function totalNominalProfit(potRent, payment, termMonths, rentGrowthRate) {
    if (!potRent || !payment || !termMonths) return null;
    const gm = rentGrowthRate / 12;
    const totalRent = Math.abs(gm) < 1e-10
      ? potRent * termMonths
      : potRent * (Math.pow(1 + gm, termMonths) - 1) / gm;
    return totalRent - payment * termMonths;
  }

  /**
   * Rent-optimal loan: always 240 months for minimum monthly payment.
   * No budget check — caller decides if potRent covers the payment.
   */
  function selectRentOptimal(principal, downPayment) {
    return loanResult(principal, downPayment, 240, null);
  }

  /**
   * Fixed-term loan: compute for a specific term without budget checks.
   */
  function selectFixed(principal, downPayment, term) {
    return loanResult(principal, downPayment, term, null);
  }

  /**
   * Inflation-aware projection metrics for a rent investment.
   *
   * Rent grows at `rentGrowthRate` per year (nominal).
   * Loan payment stays fixed in nominal KM.
   * The real burden of later payments shrinks at `inflationRate`.
   *
   * Returns:
   *   breakEvenYears  — fractional year when monthly rent first covers the payment
   *                     (0 if already profitable, Infinity if rent never catches up)
   *   roiY10          — nominal ROI (%) in year 10 as rent has grown
   *   realRoiAtEnd    — ROI (%) at loan end with inflation-discounted payment
   *
   * @param {number} price
   * @param {number} payment         — fixed monthly loan payment (KM)
   * @param {number} potRent         — estimated current monthly rent (KM)
   * @param {number} termMonths      — loan term in months
   * @param {number} rentGrowthRate  — annual rent growth (fraction, e.g. 0.03)
   * @param {number} inflationRate   — annual inflation (fraction, e.g. 0.03)
   */
  function inflationMetrics(price, payment, potRent, termMonths, rentGrowthRate, inflationRate) {
    if (!price || !payment || !potRent || potRent <= 0) {
      return { breakEvenYears: null, roiY10: null, realRoiAtEnd: null };
    }
    const g = rentGrowthRate;
    const inf = inflationRate;

    // Break-even: potRent * (1+g)^Y = payment  →  Y = ln(payment/potRent) / ln(1+g)
    let breakEvenYears;
    if (potRent >= payment) {
      breakEvenYears = 0;
    } else if (g > 0.0001) {
      breakEvenYears = Math.log(payment / potRent) / Math.log(1 + g);
    } else {
      breakEvenYears = Infinity; // no growth → never breaks even
    }

    // Year-10 nominal ROI: rent has grown, payment is still fixed
    const rentY10 = potRent * Math.pow(1 + g, 10);
    const roiY10  = (rentY10 - payment) * 12 / price * 100;

    // End-of-loan real ROI: rent grown + payment inflation-discounted
    const termYears        = termMonths / 12;
    const rentAtEnd        = potRent * Math.pow(1 + g, termYears);
    const realPaymentAtEnd = payment  / Math.pow(1 + inf, termYears);
    const realRoiAtEnd     = (rentAtEnd - realPaymentAtEnd) * 12 / price * 100;

    return { breakEvenYears, roiY10, realRoiAtEnd };
  }

  return { monthlyPayment, effectiveAnnualRate, selectOptimal, selectRentOptimal, selectFixed, minDownPaymentForROI, inflationMetrics, totalNominalProfit };
})();
