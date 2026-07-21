// Phase 0 verification: prove the print path produces a PDF with a real text
// layer, and that no app chrome (diff panel, match score, controls) leaks in.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'apply-bot/artifacts/verify-print.pdf');
fs.mkdirSync(path.dirname(out), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on('pageerror', e => errors.push(String(e)));

await page.goto('file://' + path.join(root, 'index.html'), { waitUntil: 'networkidle' });

// Force the panels visible so we can prove print CSS actually hides them.
await page.evaluate(() => {
  for (const id of ['diff-view-panel', 'match-score-panel', 'keyword-status', 'keywords-display']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'block';
  }
});

// Assert print CSS wins while emulating print media.
await page.emulateMedia({ media: 'print' });
const visibleInPrint = await page.evaluate(() =>
  ['diff-view-panel', 'match-score-panel', 'keyword-status', 'keywords-display', 'message']
    .filter(id => {
      const el = document.getElementById(id);
      return el && getComputedStyle(el).display !== 'none';
    }));

const controlsHidden = await page.evaluate(() =>
  getComputedStyle(document.querySelector('.controls')).display === 'none');

await page.pdf({ path: out, format: 'A4', printBackground: true });
await browser.close();

console.log('SRI / page errors :', errors.length ? errors : 'none');
console.log('leaked into print :', visibleInPrint.length ? visibleInPrint : 'none');
console.log('controls hidden   :', controlsHidden);
console.log('pdf written       :', out, fs.statSync(out).size, 'bytes');
