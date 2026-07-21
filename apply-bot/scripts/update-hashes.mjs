// resume.js's sha256 appears in TWO places in index.html — the <script integrity>
// attribute and the CSP script-src directive. Updating only one silently blocks
// the script (CSP wins, and it fails with no page error). Always run this after
// editing resume.js.
//
//   node apply-bot/scripts/update-hashes.mjs
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexPath = path.join(root, 'index.html');

const hash = createHash('sha256').update(fs.readFileSync(path.join(root, 'resume.js'))).digest('base64');
let html = fs.readFileSync(indexPath, 'utf8');

const before = html;
html = html
  .replace(/(script-src\s+')sha256-[A-Za-z0-9+/=]+(')/, `$1sha256-${hash}$2`)
  .replace(/(<script src="resume\.js" integrity=")sha256-[A-Za-z0-9+/=]+(")/, `$1sha256-${hash}$2`);

const sites = (html.match(new RegExp(hash.replace(/[+/=]/g, '\\$&'), 'g')) || []).length;
if (sites !== 2) {
  console.error(`Expected to write the hash in 2 places, wrote ${sites}. index.html structure changed — fix this script.`);
  process.exit(1);
}

if (html === before) {
  console.log(`resume.js sha256-${hash} — already current.`);
} else {
  fs.writeFileSync(indexPath, html);
  console.log(`Updated both hash sites to sha256-${hash}`);
}
