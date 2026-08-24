'use strict';
/* serve.js — minimal static file server for the digitizer app.
 * Serves the repo root at http://localhost:8321/  (Ctrl+C to stop). */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PORT = process.env.PORT || 8321;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.css': 'text/css',
  '.geojson': 'application/geo+json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let fp = path.normalize(path.join(ROOT, urlPath));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`serving ${ROOT} at http://localhost:${PORT}/`));
