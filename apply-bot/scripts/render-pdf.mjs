// Render a PDF to PNG so the output can actually be looked at. pdftoppm isn't
// available here and headless Chromium downloads PDFs rather than displaying
// them, so this rasterises via pdf.js inside a page.
//
// Served over http rather than file:// — ES module imports from a file:// origin
// are blocked by CORS, and setContent() pages have an opaque origin.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.map': 'application/json' };
const root = path.resolve('.');
const server = http.createServer((req, res) => {
  const full = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!full.startsWith(root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); return res.end();
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

const [, , pdfPath, outPath = 'artifacts/render.png', scaleArg = '1.2'] = process.argv;
if (!pdfPath) { console.error('usage: node scripts/render-pdf.mjs <pdf> [out.png] [scale]'); process.exit(1); }

const tmp = path.resolve('artifacts/_render.html');
fs.mkdirSync(path.dirname(tmp), { recursive: true });
fs.writeFileSync(tmp, `<!DOCTYPE html><body style="margin:0;background:#555"><div id="out"></div>
<script type="module">
import * as pdfjs from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs';
const raw = atob(${JSON.stringify(fs.readFileSync(pdfPath).toString('base64'))});
const data = new Uint8Array(raw.length);
for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
const pdf = await pdfjs.getDocument({ data }).promise;
const out = document.getElementById('out');
for (let i = 1; i <= pdf.numPages; i++) {
  const p = await pdf.getPage(i);
  const vp = p.getViewport({ scale: ${Number(scaleArg)} });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  c.style.cssText = 'display:block;margin:0 0 12px';
  out.appendChild(c);
  await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
}
window.__done = true;
</script></body>`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on('console', m => { if (m.type() === 'error') console.error('[page]', m.text()); });
await page.goto(`http://localhost:${PORT}/artifacts/_render.html`);
await page.waitForFunction(() => window.__done === true, { timeout: 60000 });
await page.locator('#out').screenshot({ path: outPath });
await browser.close();
server.close();
fs.rmSync(tmp, { force: true });
console.log('rendered', pdfPath, '→', outPath);
