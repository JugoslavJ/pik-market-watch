// OLX.ba Price per m² — View: Price per m² — injects KM/m² badges onto listing cards

class BadgeInjector {
  constructor() {
    this._pending  = false;
    this._observer = new MutationObserver(() => this._onMutation());
    this._median   = null;
  }

  start() {
    this._inject();
    this._observer.observe(document.body, { childList: true, subtree: true });
  }

  updateMedian(v) { this._median = v; }

  _inject() {
    const median = this._median ?? this._localMedian();
    for (const card of document.querySelectorAll('.content-wrap')) {
      if (card.querySelector('.olx-price-per-m2')) continue;
      const { ppm2, sqm, isRent } = CardParser.parseCard(card);
      if (isRent || !ppm2 || !sqm) continue;
      const wrap = card.querySelector('.details-wrap') ||
                   card.querySelector('.standard-tag:last-child')?.parentNode ||
                   card.querySelector('.price-wrap')?.nextElementSibling;
      if (!wrap) continue;
      const badge = document.createElement('div');
      badge.className   = `olx-price-per-m2 olx-ppm2-value ${getPriceColourTier(ppm2, median)}`.trim();
      badge.textContent = formatNumber(ppm2) + ' KM/m\u00B2';
      badge.style.marginLeft = '8px';
      wrap.appendChild(badge);
    }
  }

  _localMedian() {
    const vals = Array.from(document.querySelectorAll('.content-wrap'))
      .map(e => CardParser.parseCard(e).ppm2).filter(Boolean).sort((a, b) => a - b);
    return computeMedian(vals);
  }

  _onMutation() {
    if (this._pending) return;
    this._pending = true;
    requestAnimationFrame(() => { this._inject(); this._pending = false; });
  }
}
