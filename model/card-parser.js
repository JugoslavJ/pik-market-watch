// OLX.ba Price per m² — Model: listing card DOM parser

class CardParser {
  static parseCard(el) {
    const title = el.querySelector('.main-heading')?.textContent.trim() || '';
    const url   = (el.closest('a') || el.querySelector('a'))?.href || '';
    const textContent = el.textContent || '';

    // Initial check based on keywords
    let isRent = /Iznajmljivanje/i.test(textContent) || /najam/i.test(textContent);

    // Garsonjera = studio apartment = 0 rooms
    const isStudio = /garsonjera/i.test(textContent);

    let sqm = null, rooms = isStudio ? '0' : null;
    for (const tag of el.querySelectorAll('.standard-tag')) {
      const text = tag.textContent;
      const val  = (tag.querySelector('div')?.textContent || '').trim();
      if (text.includes('\u33A1') || text.includes('m\u00B2')) {
        sqm = parseNumber(val);
      } else if (!isStudio) {
        // Don't overwrite rooms=0 for studios with an unrelated tag
        const pm = text.match(/\((\d+)\)/);
        if (pm) rooms = pm[1];
        else if (/^\d+\+?$/.test(val)) rooms = val;
      }
    }

    const priceEl = el.querySelector('.price-wrap .smaller');
    let price = null, priceText = 'Na upit';
    if (priceEl) {
      priceText = priceEl.textContent.trim();
      if (!/na upit/i.test(priceText)) {
        const m = priceText.match(/([\d.,\s]+)/);
        if (m) price = parseNumber(m[1]);
      }
    }

    // Sanity bounds: reject implausible parse results
    // sqm > 500 is almost certainly a plot/land area parsed from a label, not an apartment
    // ppm2 > 15000 is a data error (highest real Sarajevo prices ~7000 KM/m²)
    if (sqm !== null && (sqm < 5 || sqm > 500)) sqm = null;

    // Catch miscategorized sales ads (prices under 3000 KM are almost certainly rent or troll ads)
    if (!isRent && price !== null && price < 3000) {
      isRent = true;
    }

    // Rent prices ruin the KM/m2 median algorithms, so we omit ppm2 for rent ads.
    let ppm2 = (!isRent && price && sqm > 0) ? Math.round(price / sqm) : null;
    if (ppm2 !== null && ppm2 > 15_000) ppm2 = null; // implausible parse

    return { title, url, sqm, rooms, price, priceText, ppm2, isRent };
  }

  static collectAllCards() {
    return Array.from(document.querySelectorAll('.content-wrap'))
      .map(CardParser.parseCard)
      .filter(d => d.title.length > 2);
  }
}
