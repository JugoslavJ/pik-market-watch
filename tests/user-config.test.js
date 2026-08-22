'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { userConfigContext } = require('./setup');

// Fresh context + fresh storage for every call.
// Must be async because UserConfig.load() returns a Promise.
async function fresh() {
  const g = userConfigContext();
  g.localStorage.clear();
  const cfg = await g.$eval('new UserConfig().load()');
  return { g, cfg };
}

// ── Defaults ──────────────────────────────────────────────────────────────────

describe('UserConfig: defaults', () => {
  test('monthlyIncome default 2500',   async () => assert.equal((await fresh()).cfg.monthlyIncome,  2500));
  test('maxPaymentPct default 50',     async () => assert.equal((await fresh()).cfg.maxPaymentPct,    50));
  test('downPaymentPct default 20',    async () => assert.equal((await fresh()).cfg.downPaymentPct,   20));
  test('preferredTerm default "auto"', async () => assert.equal((await fresh()).cfg.preferredTerm, 'auto'));
  test('ownedProperties default []',   async () => assert.equal((await fresh()).cfg.ownedProperties.length, 0));
});

// ── Persistence ───────────────────────────────────────────────────────────────

describe('UserConfig: persistence', () => {
  test('saved income survives reload', async () => {
    const { g } = await fresh();
    const cfg1 = await g.$eval('new UserConfig().load()');
    cfg1.monthlyIncome = 3500;
    const cfg2 = await g.$eval('new UserConfig().load()');
    assert.equal(cfg2.monthlyIncome, 3500);
  });

  test('saved maxPaymentPct survives reload', async () => {
    const { g } = await fresh();
    const cfg1 = await g.$eval('new UserConfig().load()');
    cfg1.maxPaymentPct = 40;
    const cfg2 = await g.$eval('new UserConfig().load()');
    assert.equal(cfg2.maxPaymentPct, 40);
  });

  test('saved downPaymentPct survives reload', async () => {
    const { g } = await fresh();
    const cfg1 = await g.$eval('new UserConfig().load()');
    cfg1.downPaymentPct = 15;
    const cfg2 = await g.$eval('new UserConfig().load()');
    assert.equal(cfg2.downPaymentPct, 15);
  });

  test('saved preferredTerm survives reload', async () => {
    const { g } = await fresh();
    const cfg1 = await g.$eval('new UserConfig().load()');
    cfg1.preferredTerm = '120';
    const cfg2 = await g.$eval('new UserConfig().load()');
    assert.equal(cfg2.preferredTerm, '120');
  });

  test('corrupt stored value falls back to defaults', async () => {
    const { g } = await fresh();
    // Write corrupt JSON directly so load() cannot parse it
    g.localStorage.setItem('olx_user_config', 'NOT_JSON{{');
    const cfg = await g.$eval('new UserConfig().load()');
    assert.equal(cfg.monthlyIncome, 2500);
  });
});

// ── Property management ───────────────────────────────────────────────────────

describe('UserConfig: ownedProperties', () => {
  test('addProperty returns an id', async () => {
    const { cfg } = await fresh();
    const id = cfg.addProperty({ label: 'Flat A', price: 100_000, rooms: '2', sqm: 60 });
    assert.ok(typeof id === 'string' && id.length > 0);
  });

  test('added property appears in ownedProperties', async () => {
    const { cfg } = await fresh();
    cfg.addProperty({ label: 'Flat A', price: 100_000 });
    assert.equal(cfg.ownedProperties.length, 1);
    assert.equal(cfg.ownedProperties[0].label, 'Flat A');
  });

  test('multiple properties accumulate', async () => {
    const { cfg } = await fresh();
    cfg.addProperty({ label: 'A' });
    cfg.addProperty({ label: 'B' });
    cfg.addProperty({ label: 'C' });
    assert.equal(cfg.ownedProperties.length, 3);
  });

  test('updateProperty modifies a field', async () => {
    const { cfg } = await fresh();
    const id = cfg.addProperty({ label: 'Old' });
    cfg.updateProperty(id, { label: 'New' });
    assert.equal(cfg.ownedProperties[0].label, 'New');
  });

  test('updateProperty on unknown id is a no-op', async () => {
    const { cfg } = await fresh();
    cfg.addProperty({ label: 'A' });
    cfg.updateProperty('nonexistent-id', { label: 'Ghost' });
    assert.equal(cfg.ownedProperties[0].label, 'A');
  });

  test('removeProperty deletes by id', async () => {
    const { cfg } = await fresh();
    cfg.addProperty({ label: 'A' });
    const id = cfg.addProperty({ label: 'B' });
    cfg.addProperty({ label: 'C' });
    cfg.removeProperty(id);
    assert.equal(cfg.ownedProperties.length, 2);
    assert.ok(!cfg.ownedProperties.some(p => p.label === 'B'));
  });

  test('properties persist after reload', async () => {
    const { g } = await fresh();
    const cfg1 = await g.$eval('new UserConfig().load()');
    cfg1.addProperty({ label: 'Garsonjera', price: 80_000 });
    const cfg2 = await g.$eval('new UserConfig().load()');
    assert.equal(cfg2.ownedProperties.length, 1);
    assert.equal(cfg2.ownedProperties[0].label, 'Garsonjera');
  });
});

// ── selectLoan ────────────────────────────────────────────────────────────────

describe('UserConfig: selectLoan', () => {
  test('returns a loan object with required fields', async () => {
    const { cfg } = await fresh();
    cfg.monthlyIncome  = 3000;
    cfg.maxPaymentPct  = 50;
    cfg.downPaymentPct = 20;
    const loan = cfg.selectLoan(150_000);
    for (const f of ['term', 'principal', 'downPayment', 'payment', 'effectiveRate', 'nominalRate', 'fitsBudget']) {
      assert.ok(f in loan, `missing field: ${f}`);
    }
  });

  test('principal = price × (1 - downPct)', async () => {
    const { cfg } = await fresh();
    cfg.downPaymentPct = 20;
    const loan = cfg.selectLoan(200_000);
    assert.equal(loan.principal,  160_000);
    assert.equal(loan.downPayment, 40_000);
  });

  test('payment within budget when income is generous', async () => {
    const { cfg } = await fresh();
    cfg.monthlyIncome  = 5000;
    cfg.maxPaymentPct  = 50;   // budget = 2500 KM/mj
    cfg.downPaymentPct = 20;
    const loan = cfg.selectLoan(150_000);
    assert.equal(loan.fitsBudget, true);
    assert.ok(loan.payment <= 2500);
  });

  test('fitsBudget false when income too low', async () => {
    const { cfg } = await fresh();
    cfg.monthlyIncome  = 500;
    cfg.maxPaymentPct  = 30;   // budget = 150 KM/mj — impossible
    cfg.downPaymentPct = 10;
    const loan = cfg.selectLoan(300_000);
    assert.equal(loan.fitsBudget, false);
  });

  test('extra owned income widens budget', async () => {
    const { cfg } = await fresh();
    cfg.monthlyIncome  = 2000;
    cfg.maxPaymentPct  = 50;   // base budget = 1000
    cfg.downPaymentPct = 20;
    const price         = 100_000;
    const loanNoExtra   = cfg.selectLoan(price, 0);
    const loanWithExtra = cfg.selectLoan(price, 500); // 1500 budget
    assert.ok(loanWithExtra.term <= loanNoExtra.term || !loanNoExtra.fitsBudget);
  });

  test('fixed preferredTerm uses that term exactly', async () => {
    const { cfg } = await fresh();
    cfg.monthlyIncome  = 5000;
    cfg.maxPaymentPct  = 50;
    cfg.downPaymentPct = 20;
    cfg.preferredTerm  = '180';
    const loan = cfg.selectLoan(150_000);
    assert.equal(loan.term, 180);
  });

  test('fixed term fitsBudget reflects whether payment fits', async () => {
    const { cfg } = await fresh();
    cfg.monthlyIncome  = 5000;
    cfg.maxPaymentPct  = 50;   // 2500 KM/mj budget
    cfg.downPaymentPct = 20;
    cfg.preferredTerm  = '240';
    const loan = cfg.selectLoan(150_000);
    assert.equal(loan.fitsBudget, loan.payment <= 2500);
  });
});

// ── selectLoanRent ────────────────────────────────────────────────────────────

describe('UserConfig: selectLoanRent', () => {
  test('always 240 months', async () => {
    const { cfg } = await fresh();
    cfg.downPaymentPct = 20;
    assert.equal(cfg.selectLoanRent(200_000).term, 240);
  });

  test('fitsBudget is null (no salary check)', async () => {
    const { cfg } = await fresh();
    cfg.monthlyIncome  = 500;  // impossibly low — irrelevant
    cfg.downPaymentPct = 20;
    assert.equal(cfg.selectLoanRent(300_000).fitsBudget, null);
  });

  test('gives lower payment than selectLoan for same price with tight budget', async () => {
    const { cfg } = await fresh();
    cfg.monthlyIncome  = 2000;
    cfg.maxPaymentPct  = 50;
    cfg.downPaymentPct = 20;
    const price    = 150_000;
    const optimal  = cfg.selectLoan(price);
    const rentOpt  = cfg.selectLoanRent(price);
    assert.ok(rentOpt.payment <= optimal.payment + 0.01);
  });

  test('275k apartment: known payment ~1432 KM/mj', async () => {
    const { cfg } = await fresh();
    cfg.downPaymentPct = 20;
    // price=275k → down=55k → principal=220k
    const loan = cfg.selectLoanRent(275_000);
    assert.ok(loan.payment > 1400 && loan.payment < 1470,
      `expected ~1432, got ${loan.payment.toFixed(0)}`);
  });
});

// ── ROI scenario (integration) ────────────────────────────────────────────────

describe('UserConfig: ROI scenario', () => {
  test('275k at 1540 rent: short-term payment exceeds rent → negative ROI', async () => {
    const { cfg } = await fresh();
    cfg.monthlyIncome  = 6000;
    cfg.maxPaymentPct  = 50;
    cfg.downPaymentPct = 20;
    const price   = 275_000;
    const potRent = 1540;
    const loan    = cfg.selectLoan(price, 0);
    const roi     = ((potRent - loan.payment) * 12) / price;
    assert.ok(roi < 0, `ROI should be negative: got ${(roi * 100).toFixed(2)}%`);
  });

  test('cheap apartment covered by rent → ROI formula returns finite number', async () => {
    const { cfg } = await fresh();
    cfg.monthlyIncome  = 4000;
    cfg.maxPaymentPct  = 50;
    cfg.downPaymentPct = 30;
    const price   = 80_000;
    const potRent = 700;
    const loan    = cfg.selectLoanRent(price);
    const roi     = ((potRent - loan.payment) * 12) / price;
    assert.ok(isFinite(roi), 'ROI should be finite');
  });
});
