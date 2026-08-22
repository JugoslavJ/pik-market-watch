// OLX.ba Price per m² — View: panel shell (HTML scaffold + tab wiring)

const PANEL_POS_KEY = 'olx_panel_pos';

class PanelShell {
  constructor(db) {
    this._db = db;
    // All view/controller init happens in build() so UserConfig.load() can be awaited
  }

  async build() {
    // #8 — async load from browser.storage.local (extension-scoped, safe after site-data clear)
    this._config    = await new UserConfig().load();

    this._progress  = new ProgressBar();
    this._summary   = new SummaryStats();
    this._table     = new ResultTable(this._db);
    this._charts    = new ChartsTab(this._db, buildSearchCacheKey(location.href));
    this._configTab = new ConfigTab(this._config, () => this._controller.onConfigChange());
    this._savedTab  = new SavedTab(this._db, buildSearchCacheKey(location.href), location.href);

    this._controller = new ScraperController(this._db, this._config, {
      progress:  this._progress,
      summary:   this._summary,
      table:     this._table,
      charts:    this._charts,
      configTab: this._configTab,
    });

    const panel = document.createElement('div');
    panel.id    = 'olx-scraper-panel';
    panel.innerHTML = this._html();

    document.body.appendChild(panel);
    this._restorePosition(panel);
    this._attachDrag(panel);
    this._attachClose(panel);
    this._attachTabs(panel);

    this._table.attachSortListener();
    this._table.attachRoomFilterListener();
    this._table.setConfig(this._config);

    getElement('olx-scrape-btn').onclick  = () => this._controller.startScrape();
    getElement('olx-export-btn').onclick  = () => CSVExporter.exportToFile(this._controller.results);
    getElement('olx-save-btn').onclick    = () => this._savedTab.promptAndSave();

    await this._controller.loadCache();
  }

  // ── HTML ──────────────────────────────────────────────────────────────

  _html() {
    return `
      <div id="olx-scraper-header">
        <span id="olx-scraper-title">${Icons.search(16)} OLX Scraper</span>
        <button id="olx-scraper-close">&#x2715;</button>
      </div>

      <div id="olx-tab-bar">
        <button class="olx-tab olx-tab-active" data-tab="oglasi">Oglasi</button>
        <button class="olx-tab" data-tab="charts">Grafovi</button>
        <button class="olx-tab" id="olx-tab-saved" data-tab="saved">&#128278; Sa&#269;uvano</button>
        <button class="olx-tab" data-tab="config">&#9881;&#65039; Pode&#353;avanja</button>
      </div>

      <div id="olx-oglasi-pane" class="olx-tab-pane olx-tab-pane-active">
        <div id="olx-top-bar">
          <div id="olx-scraper-controls">
            <button id="olx-scrape-btn">${Icons.search(13)} Skeniraj</button>
            <button id="olx-save-btn" title="Sa&#269;uvaj ovu pretragu za automatsko pra&#263;enje">&#128276; Sa&#269;uvaj</button>
            <button id="olx-export-btn" disabled>${Icons.download} CSV</button>
          </div>
          <div id="olx-cache-banner" class="hidden"></div>
          <span id="olx-scraper-info-inline">Za ROI prikaz skenirajte i "Iznajmljivanje".</span>
        </div>
        <div id="olx-scraper-progress" class="hidden">
          <div id="olx-progress-bar-wrap"><div id="olx-progress-bar"></div></div>
          <div id="olx-progress-text">&#268;ekanje&#8230;</div>
        </div>
        <div id="olx-meta-bar" class="hidden">
          <div id="olx-results-summary"></div>
          <div id="olx-ppm2-legend">
            <span><span class="olx-legend-dot olx-ppm2-great"></span>&#8804;&#160;80%</span>
            <span><span class="olx-legend-dot olx-ppm2-good"></span>80&#8211;99%</span>
            <span><span class="olx-legend-dot olx-ppm2-fair"></span>100&#8211;120%</span>
            <span><span class="olx-legend-dot olx-ppm2-high"></span>&gt;&#160;120%</span>
            <span class="olx-legend-sep"></span>
            <span><span class="olx-badge olx-badge-new" style="font-size:10px">Novo</span></span>
            <span><span class="olx-badge olx-badge-drop" style="font-size:10px">&#8595;&#160;5%</span></span>
            <span class="olx-legend-sep"></span>
            <span style="font-size:10px;color:#9ca3af;" title="Trend cijene od prvog oglašavanja">
              <span style="color:#ef4444;">&#8593;</span>rast
              <span style="color:#10b981;margin-left:4px;">&#8595;</span>pad
              <span style="color:#9ca3af;margin-left:4px;">&#8594;</span>stabilno
            </span>
          </div>
          <div id="olx-room-filter"></div>
        </div>
        <div id="olx-results-table-wrap" class="hidden">
          <table id="olx-results-table">
            <thead><tr>
              <th data-k="title" data-label="Naziv">Naziv</th>
              <th data-k="sqm"   data-label="m&#178;">m&#178;</th>
              <th data-k="rooms" data-label="Sobe">Sobe</th>
              <th data-k="price" data-label="Cijena">Cijena</th>
              <th data-k="ppm2"  data-label="KM/m&#178;">KM/m&#178;</th>
              <th data-k="roi"   data-label="Najam / ROI">Najam / ROI</th>
              <th data-k="days"  data-label="Dana">Dana</th>
              <th data-k="spark" data-label="Trend">Trend</th>
            </tr></thead>
            <tbody id="olx-results-tbody"></tbody>
          </table>
        </div>
      </div>

      <div id="olx-config-pane" class="olx-tab-pane"></div>
      <div id="olx-charts-pane" class="olx-tab-pane"></div>
      <div id="olx-saved-pane"  class="olx-tab-pane"></div>`;
  }

  // ── Tab wiring ────────────────────────────────────────────────────────

  _attachTabs(panel) {
    panel.querySelector('#olx-tab-bar').addEventListener('click', e => {
      const btn = e.target.closest('.olx-tab');
      if (!btn) return;
      const tabName = btn.dataset.tab;
      panel.querySelectorAll('.olx-tab').forEach(t => t.classList.toggle('olx-tab-active', t === btn));
      getElement('olx-oglasi-pane').classList.toggle('olx-tab-pane-active', tabName === 'oglasi');
      getElement('olx-charts-pane').classList.toggle('olx-tab-pane-active', tabName === 'charts');
      getElement('olx-config-pane').classList.toggle('olx-tab-pane-active', tabName === 'config');
      getElement('olx-saved-pane' ).classList.toggle('olx-tab-pane-active', tabName === 'saved');
      if (tabName === 'charts') this._charts.activate();
      if (tabName === 'config') this._configTab.render();
      if (tabName === 'saved')  this._savedTab.render();
    });
  }

  // ── Drag + position persistence ───────────────────────────────────────

  _restorePosition(panel) {
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || 'null');
      if (saved?.top)  panel.style.top  = saved.top;
      if (saved?.left) { panel.style.left = saved.left; panel.style.right = 'auto'; }
    } catch {}
  }

  _savePosition(panel) {
    try {
      localStorage.setItem(PANEL_POS_KEY, JSON.stringify({
        top:  panel.style.top,
        left: panel.style.left,
      }));
    } catch {}
  }

  _attachDrag(panel) {
    let dragging = false, ox = 0, oy = 0;
    panel.querySelector('#olx-scraper-header').addEventListener('mousedown', e => {
      if (e.target.closest('#olx-scraper-close')) return;
      dragging = true;
      ox = e.clientX - panel.offsetLeft;
      oy = e.clientY - panel.offsetTop;
      panel.style.transition = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      panel.style.left  = (e.clientX - ox) + 'px';
      panel.style.top   = (e.clientY - oy) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; this._savePosition(panel); }
    });
  }

  // ── Close ─────────────────────────────────────────────────────────────

  _attachClose(panel) {
    panel.querySelector('#olx-scraper-close').onclick = () => panel.remove();
  }
}
