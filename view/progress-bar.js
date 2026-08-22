// OLX.ba Price per m² — View: Price per m² — scrape progress bar

class ProgressBar {
  setProgress(pct, text) {
    getElement('olx-progress-bar').style.width = pct + '%';
    getElement('olx-progress-text').textContent = text;
  }

  show() { getElement('olx-scraper-progress').classList.remove('hidden'); }
}
