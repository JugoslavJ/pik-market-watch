// OLX.ba Price per m² — entry point
// Runs on every olx.ba page. Either acts as a hidden scraper tab,
// or injects the trigger button and mounts the panel on demand.

if (new URL(location.href).searchParams.get('olx_scrape') === 'true') {
  // ── Hidden scraper tab: collect cards and report back ─────────────────
  let sent = false, debounce = null;

  function send() {
    if (sent) return;
    sent = true;
    obs.disconnect();
    browser.runtime.sendMessage({ type: 'CARDS_READY', cards: CardParser.collectAllCards() }).catch(() => {});
  }
  function schedule() { clearTimeout(debounce); debounce = setTimeout(send, 1000); }

  const obs = new MutationObserver(schedule);
  obs.observe(document.body, { childList: true, subtree: true });
  schedule();
  setTimeout(() => { if (!sent) send(); }, 25_000);

} else {
  // ── Normal tab: inject badge overlays and mount the trigger button ─────
  const db = new ListingsDatabase();
  db.open().catch(() => console.warn('[OLX ext] IndexedDB unavailable, running without cache.'));

  new BadgeInjector().start();

  function buildTrigger() {
    if (getElement('olx-scraper-trigger')) return;
    const btn     = document.createElement('button');
    btn.id        = 'olx-scraper-trigger';
    btn.title     = 'OLX Scraper';
    btn.innerHTML = Icons.search(16);
    btn.onclick   = () => {
      const existing = getElement('olx-scraper-panel');
      if (existing) existing.remove();
      else new PanelShell(db).build();
    };
    document.body.appendChild(btn);
  }

  if (document.body) buildTrigger();
  else document.addEventListener('DOMContentLoaded', buildTrigger);

  browser.runtime.onMessage.addListener(msg => {
    if (msg.type === 'TOGGLE_PANEL') {
      const existing = getElement('olx-scraper-panel');
      if (existing) existing.remove();
      else new PanelShell(db).build();
    }
    if (msg.type === 'REFRESH_BADGE') {
      // Future: update trigger badge count
    }
  });
}
