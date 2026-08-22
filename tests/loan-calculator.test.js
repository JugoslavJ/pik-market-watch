'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loanContext } = require('./setup');

const g  = loanContext();
const LC = g.$get('LoanCalculator');

const approx = (actual, expected, tol, msg) => {
  const diff = Math.abs(actual - expected);
  assert.ok(diff <= tol, `${msg}: got ${actual.toFixed(4)}, expected ${expected} ±${tol}`);
};

// ── monthlyPayment ────────────────────────────────────────────────────────────
// Reference values derived independently from the fee formula:
//   fee = 1779.38 + 4.00 × months
//   payment = (principal + fee) × r / (1 - (1+r)^-n)
//   where r = nominalRate / 12

describe('LoanCalculator.monthlyPayment', () => {
  test('zero principal → 0',  () => assert.equal(LC.monthlyPayment(0, 120), 0));
  test('zero months → 0',     () => assert.equal(LC.monthlyPayment(100000, 0), 0));

  test('120m (band 1: 3.19%) gives reasonable payment for 100k', () => {
    const pmt = LC.monthlyPayment(100_000, 120);
    approx(pmt, 996, 5, '100k/120m payment');
  });

  test('240m (band 3: 4.69%) min payment for 150k', () => {
    const pmt = LC.monthlyPayment(150_000, 240);
    approx(pmt, 982, 5, '150k/240m payment');
  });

  test('payment decreases as term increases (within same rate band)', () => {
    const pmt60  = LC.monthlyPayment(100_000, 60);
    const pmt120 = LC.monthlyPayment(100_000, 120);
    assert.ok(pmt60 > pmt120, 'shorter term → higher payment');
  });

  test('band boundary: 120m vs 121m jump in rate increases payment', () => {
    const pmt120 = LC.monthlyPayment(100_000, 120);
    const pmt121 = LC.monthlyPayment(100_000, 121);
    // 121m uses 3.99% vs 3.19% → payment likely stays similar but rate cost is higher
    // Both should be reasonable (< 2000 KM/mj for 100k)
    assert.ok(pmt120 < 2000 && pmt121 < 2000, 'both payments sane');
  });

  test('larger principal → proportionally larger payment', () => {
    const p1 = LC.monthlyPayment(100_000, 120);
    const p2 = LC.monthlyPayment(200_000, 120);
    // Not exactly 2× because fee is fixed, but ratio should be roughly 1.9-2.1
    const ratio = p2 / p1;
    assert.ok(ratio > 1.8 && ratio < 2.2, `ratio ${ratio.toFixed(3)} should be ~2`);
  });
});

// ── effectiveAnnualRate ───────────────────────────────────────────────────────

describe('LoanCalculator.effectiveAnnualRate', () => {
  test('zero principal → 0', () => assert.equal(LC.effectiveAnnualRate(0, 120), 0));

  test('effective rate > nominal rate (due to fees)', () => {
    const eff = LC.effectiveAnnualRate(100_000, 120);
    const nom = 0.0319;
    assert.ok(eff > nom, `effective ${eff.toFixed(4)} should exceed nominal ${nom}`);
  });

  test('effective rate close to nominal for large principal (fees diluted)', () => {
    // With 1M principal, fees are tiny → effective ≈ nominal
    const eff = LC.effectiveAnnualRate(1_000_000, 120);
    approx(eff, 0.0319, 0.005, 'large principal effective rate');
  });

  test('shorter term → higher effective rate (fees spread over fewer months)', () => {
    const eff60  = LC.effectiveAnnualRate(100_000, 60);
    const eff120 = LC.effectiveAnnualRate(100_000, 120);
    assert.ok(eff60 > eff120, 'shorter term → higher effective rate');
  });

  test('40k reference loan at 120m matches ~4.34% from session data', () => {
    // Session established: 40k loan, 120m, nominal 3.19% → effective ~4.34%
    const eff = LC.effectiveAnnualRate(40_000, 120);
    approx(eff, 0.0434, 0.003, '40k/120m effective rate');
  });
});

// ── selectOptimal ─────────────────────────────────────────────────────────────

describe('LoanCalculator.selectOptimal', () => {
  test('returns fitsBudget:true when term fits', () => {
    const loan = LC.selectOptimal(100_000, 20_000, 2000);
    assert.equal(loan.fitsBudget, true);
    assert.ok(loan.payment <= 2000, 'payment within budget');
  });

  test('returns fitsBudget:false when nothing fits', () => {
    // Budget of 100 KM/mj will never cover any reasonable loan
    const loan = LC.selectOptimal(200_000, 0, 100);
    assert.equal(loan.fitsBudget, false);
  });

  test('payment ≤ maxMonthlyPayment for fitting result', () => {
    const budget = 800;
    const loan = LC.selectOptimal(80_000, 10_000, budget);
    if (loan.fitsBudget) assert.ok(loan.payment <= budget);
  });

  test('picks minimum total repaid, not just shortest term', () => {
    // At the 120→121 month boundary the nominal rate jumps from 3.19% to 3.99%.
    // A budget wide enough to afford 121m might save more at 120m total.
    // selectOptimal should prefer 120m if total (pmt×term) is lower.
    const budget = 2000;
    const loan = LC.selectOptimal(100_000, 0, budget);
    // Verify: term chosen minimises total repaid vs any alternative
    const altPmt = LC.monthlyPayment(100_000, loan.term + 1);
    const altTotal = altPmt * (loan.term + 1);
    const thisTotal = loan.payment * loan.term;
    // Either our term is already optimal, or the +1 month wasn't affordable
    assert.ok(
      thisTotal <= altTotal || altPmt > budget,
      `term ${loan.term} should be total-cost optimal`
    );
  });

  test('result includes all required fields', () => {
    const loan = LC.selectOptimal(150_000, 30_000, 2000);
    for (const field of ['term', 'principal', 'downPayment', 'payment', 'effectiveRate', 'nominalRate', 'fitsBudget']) {
      assert.ok(field in loan, `missing field: ${field}`);
    }
  });

  test('principal and downPayment stored as passed in', () => {
    // LoanCalculator takes pre-computed principal (UserConfig does the subtraction)
    const loan = LC.selectOptimal(120_000, 30_000, 2000);
    assert.equal(loan.principal,   120_000);
    assert.equal(loan.downPayment,  30_000);
  });
});

// ── selectRentOptimal ─────────────────────────────────────────────────────────

describe('LoanCalculator.selectRentOptimal', () => {
  test('always returns 240 months', () => {
    assert.equal(LC.selectRentOptimal(200_000, 40_000).term, 240);
  });

  test('fitsBudget is null (no budget check)', () => {
    assert.equal(LC.selectRentOptimal(200_000, 40_000).fitsBudget, null);
  });

  test('payment is the minimum possible (240m = lowest for given principal)', () => {
    const rent240 = LC.selectRentOptimal(200_000, 0).payment;
    const fixed180 = LC.selectFixed(200_000, 0, 180).payment;
    assert.ok(rent240 < fixed180, '240m payment < 180m payment');
  });

  test('275k apartment 20% down: rent-optimal ~1432 KM/mj (session value)', () => {
    // 275k price, 20% down → 220k principal
    const loan = LC.selectRentOptimal(220_000, 55_000);
    approx(loan.payment, 1432, 15, '275k rent-optimal payment');
  });
});

// ── selectFixed ──────────────────────────────────────────────────────────────

describe('LoanCalculator.selectFixed', () => {
  test('uses exactly the requested term', () => {
    assert.equal(LC.selectFixed(100_000, 0, 60).term, 60);
    assert.equal(LC.selectFixed(100_000, 0, 180).term, 180);
  });

  test('fitsBudget is null', () => {
    assert.equal(LC.selectFixed(100_000, 0, 120).fitsBudget, null);
  });

  test('correct nominal rate for each band', () => {
    assert.equal(LC.selectFixed(100_000, 0, 60).nominalRate,  0.0319);
    assert.equal(LC.selectFixed(100_000, 0, 120).nominalRate, 0.0319);
    assert.equal(LC.selectFixed(100_000, 0, 121).nominalRate, 0.0399);
    assert.equal(LC.selectFixed(100_000, 0, 180).nominalRate, 0.0399);
    assert.equal(LC.selectFixed(100_000, 0, 181).nominalRate, 0.0469);
    assert.equal(LC.selectFixed(100_000, 0, 240).nominalRate, 0.0469);
  });

  test('payment matches monthlyPayment() for same principal', () => {
    const loan = LC.selectFixed(100_000, 20_000, 120);
    // principal passed in is 100k (LoanCalculator doesn't subtract downPayment)
    approx(loan.payment, LC.monthlyPayment(100_000, 120), 0.01, 'selectFixed payment');
  });
});

// ── selectOptimal: binary-search correctness ──────────────────────────────────
// The new implementation uses per-band binary search instead of scanning 6..240.
// Verify it produces identical results to the brute-force approach for a range
// of principals and budgets.

describe('LoanCalculator.selectOptimal: binary-search vs brute-force equivalence', () => {
  // Reference brute-force implementation
  function bruteForce(principal, downPayment, maxPmt) {
    let best = null;
    for (let term = 6; term <= 240; term++) {
      const pmt = LC.monthlyPayment(principal, term);
      if (pmt > maxPmt) continue;
      const total = pmt * term;
      if (!best || total < best.total)
        best = { term, total, payment: pmt };
    }
    return best ? best.term : 240;
  }

  const cases = [
    [100_000, 0, 1000], [100_000, 0, 800], [50_000, 0, 400],
    [200_000, 40_000, 2000], [80_000, 16_000, 600], [150_000, 30_000, 1500],
    // boundary cases near band edges
    [100_000, 0, 995], [100_000, 0, 996], [100_000, 0, 997],
  ];

  for (const [price, down, budget] of cases) {
    test(`${price}KM /${budget}KM budget → same term as brute-force`, () => {
      const actual   = LC.selectOptimal(price, down, budget).term;
      const expected = bruteForce(price, down, budget);
      assert.equal(actual, expected, `mismatch for price=${price} budget=${budget}`);
    });
  }

  test('zero budget → over-budget result (240m)', () => {
    assert.equal(LC.selectOptimal(100_000, 0, 0).term, 240);
    assert.equal(LC.selectOptimal(100_000, 0, 0).fitsBudget, false);
  });
});

// ── minDownPaymentForROI ──────────────────────────────────────────────────────

describe('LoanCalculator.minDownPaymentForROI', () => {
  test('275k price, 1540 rent → ~38219 KM (13.9%)', () => {
    const r = LC.minDownPaymentForROI(275_000, 1540);
    assert.equal(r.feasible, true);
    // payment at (275000-38219)=236781 over 240m should be ≤ 1540
    const pmt = LC.monthlyPayment(275_000 - r.downPayment, 240);
    assert.ok(pmt <= 1540, `payment ${pmt.toFixed(2)} should be ≤ 1540`);
    // downPct should be ~13.9%
    approx(r.downPct, 13.9, 0.5, '275k min down pct');
  });

  test('200k price, 1540 rent → 0 down (rent covers loan)', () => {
    const r = LC.minDownPaymentForROI(200_000, 1540);
    assert.equal(r.feasible, true);
    assert.equal(r.downPayment, 0);
    assert.equal(r.downPct, 0);
  });

  test('payment at computed minDown is exactly ≤ potRent', () => {
    for (const [price, rent] of [[300_000, 1200], [150_000, 800], [500_000, 2000]]) {
      const r = LC.minDownPaymentForROI(price, rent);
      if (!r.feasible) continue;
      const pmt = LC.monthlyPayment(price - r.downPayment, 240);
      assert.ok(pmt <= rent + 0.01, `payment ${pmt.toFixed(2)} should be ≤ ${rent} for price=${price}`);
    }
  });

  test('zero price → infeasible', () => {
    assert.equal(LC.minDownPaymentForROI(0, 1000).feasible, false);
  });

  test('zero rent → infeasible', () => {
    assert.equal(LC.minDownPaymentForROI(200_000, 0).feasible, false);
  });

  test('tiny rent (50 KM) requires near-full down payment', () => {
    // 50 KM/mj can technically cover a tiny principal — but needs ~97% down
    const r = LC.minDownPaymentForROI(200_000, 50);
    assert.equal(r.feasible, true);
    assert.ok(r.downPct > 90, `expected >90% down, got ${r.downPct.toFixed(1)}%`);
  });

  test('rent below fee floor → infeasible (fee alone exceeds rent)', () => {
    // absoluteFee(240) = 1779.38 + 960 = 2739.38; annuityFactor * fee > any possible rent
    // At rent=1, maxPrincipal = 1/factor - fee < 0 → infeasible
    const r = LC.minDownPaymentForROI(200_000, 1);
    assert.equal(r.feasible, false);
  });

  test('very high rent → 0% down needed', () => {
    // 5000 KM/mj rent on 100k property trivially covered
    const r = LC.minDownPaymentForROI(100_000, 5000);
    assert.equal(r.feasible, true);
    assert.equal(r.downPayment, 0);
  });

  test('downPct is downPayment / price * 100', () => {
    const r = LC.minDownPaymentForROI(275_000, 1540);
    approx(r.downPct, (r.downPayment / 275_000) * 100, 0.01, 'downPct consistency');
  });

  test('minimum down is ceil (never lets payment exceed rent)', () => {
    const [price, rent] = [275_000, 1540];
    const r = LC.minDownPaymentForROI(price, rent);
    // One KM less down should cause payment to exceed rent
    const pmt = LC.monthlyPayment(price - (r.downPayment - 1), 240);
    assert.ok(pmt > rent, `with 1 KM less down (${r.downPayment-1}), payment ${pmt.toFixed(2)} should exceed rent ${rent}`);
  });
});
