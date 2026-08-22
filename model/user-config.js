// OLX.ba Price per m² — Model: user settings with loan selection

const USER_CONFIG_KEY = 'olx_user_config';

const USER_CONFIG_DEFAULTS = {
  monthlyIncome:   2500,
  maxPaymentPct:   50,
  downPaymentPct:  20,
  preferredTerm:   'auto',
  ownedProperties: [],
  rentGrowthRate:  3,   // % per year
  inflationRate:   3,   // % per year
  roiTarget:       0,   // % annual ROI target for min-down calculation
};

class UserConfig {
  constructor() { this._data = null; }

  /**
   * Load from browser.storage.local (extension-scoped, survives site-data clear).
   * Migrates automatically from the old localStorage key if present.
   * @returns {Promise<UserConfig>}
   */
  async load() {
    try {
      let stored = null;
      const result = await browser.storage.local.get(USER_CONFIG_KEY);
      stored = result[USER_CONFIG_KEY] ?? null;

      // One-time migration from localStorage (pre-v6.1)
      if (!stored) {
        try {
          const raw = localStorage.getItem(USER_CONFIG_KEY);
          if (raw) {
            stored = JSON.parse(raw);
            await browser.storage.local.set({ [USER_CONFIG_KEY]: stored });
            localStorage.removeItem(USER_CONFIG_KEY);
          }
        } catch {}
      }

      this._data = stored
        ? { ...USER_CONFIG_DEFAULTS, ...stored }
        : { ...USER_CONFIG_DEFAULTS };
    } catch {
      this._data = { ...USER_CONFIG_DEFAULTS };
    }
    return this;
  }

  save() {
    // Fire-and-forget: storage is async but callers don't need to await saves
    browser.storage.local.set({ [USER_CONFIG_KEY]: this._data }).catch(() => {});
    return this;
  }

  // ── Getters / setters ─────────────────────────────────────────────────

  get monthlyIncome()   { return this._data.monthlyIncome; }
  get maxPaymentPct()   { return this._data.maxPaymentPct; }
  get downPaymentPct()  { return this._data.downPaymentPct; }
  get preferredTerm()   { return this._data.preferredTerm; }
  get ownedProperties() { return this._data.ownedProperties; }
  get rentGrowthRate()  { return this._data.rentGrowthRate ?? 3; }
  get inflationRate()   { return this._data.inflationRate  ?? 3; }
  get roiTarget()       { return this._data.roiTarget      ?? 0; }

  set monthlyIncome(v)   { this._data.monthlyIncome  = Number(v) || 0;  this.save(); }
  set maxPaymentPct(v)   { this._data.maxPaymentPct  = Number(v) || 50; this.save(); }
  set downPaymentPct(v)  { this._data.downPaymentPct = Number(v) || 0;  this.save(); }
  set preferredTerm(v)   { this._data.preferredTerm  = v;               this.save(); }
  set rentGrowthRate(v)  { this._data.rentGrowthRate = Number(v) || 0;  this.save(); }
  set inflationRate(v)   { this._data.inflationRate  = Number(v) || 0;  this.save(); }
  set roiTarget(v)       { this._data.roiTarget      = Number(v) || 0;  this.save(); }

  // ── Owned property management ─────────────────────────────────────────

  addProperty(prop) {
    UserConfig._counter = (UserConfig._counter || 0) + 1;
    const id = 'p' + Date.now() + '_' + UserConfig._counter;
    this._data.ownedProperties.push({ id, ...prop });
    this.save();
    return id;
  }

  updateProperty(id, updates) {
    const idx = this._data.ownedProperties.findIndex(p => p.id === id);
    if (idx >= 0) { Object.assign(this._data.ownedProperties[idx], updates); this.save(); }
  }

  removeProperty(id) {
    this._data.ownedProperties = this._data.ownedProperties.filter(p => p.id !== id);
    this.save();
  }

  // ── Loan helpers (delegates to LoanCalculator) ────────────────────────

  _principal(purchasePrice) {
    const down = Math.round(purchasePrice * (this._data.downPaymentPct / 100));
    return { principal: purchasePrice - down, downPayment: down };
  }

  _budget(extraMonthlyIncome = 0) {
    return (this._data.monthlyIncome * this._data.maxPaymentPct / 100) + extraMonthlyIncome;
  }

  selectLoan(purchasePrice, extraMonthlyIncome = 0) {
    const { principal, downPayment } = this._principal(purchasePrice);
    if (this._data.preferredTerm !== 'auto') {
      const term = Number(this._data.preferredTerm);
      const loan = LoanCalculator.selectFixed(principal, downPayment, term);
      loan.fitsBudget = loan.payment <= this._budget(extraMonthlyIncome);
      return loan;
    }
    return LoanCalculator.selectOptimal(principal, downPayment, this._budget(extraMonthlyIncome));
  }

  selectLoanRent(purchasePrice) {
    const { principal, downPayment } = this._principal(purchasePrice);
    return LoanCalculator.selectRentOptimal(principal, downPayment);
  }

  minDownForROI(purchasePrice, potRent) {
    return LoanCalculator.minDownPaymentForROI(purchasePrice, potRent, this._data.roiTarget ?? 0);
  }
}
