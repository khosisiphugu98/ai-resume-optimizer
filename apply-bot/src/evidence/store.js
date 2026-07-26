/**
 * The evidence corpus — the candidate's own résumés, as uploaded.
 *
 * Everything the bot claims about the candidate's skills has to trace back to
 * something they actually wrote. The structured profile carries facts but no
 * prose: `experience[]` has year-granularity dates and no bullets, so a claim
 * like "used Looker Studio at Hyve" exists nowhere in it. That evidence lives in
 * the CV documents, which is why they get uploaded and kept here.
 *
 * Documents live in `profile/evidence/` — gitignored alongside the master
 * profile, because a CV is personal data and this is the same trust boundary.
 * Extracted text is cached next to each document so inference never re-parses a
 * PDF; the parse is the expensive part and the corpus is read on every tailor run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { extractPdfLines } from '../../scripts/extract-text.mjs';

// Overridable for the same reason APPLY_BOT_PROFILE is: without it, a test that
// adds a fixture CV writes into the real, un-recoverable evidence directory.
const EVIDENCE_DIR = process.env.APPLY_BOT_EVIDENCE || path.join(ROOT, 'profile/evidence');
const MANIFEST = () => path.join(EVIDENCE_DIR, 'manifest.json');

// Below this, a PDF has no usable text layer — it is a scan, or an image export.
// Accepting it silently would mean every skill in it reads as unevidenced, which
// looks exactly like "you don't have this skill" and is the worst failure here.
const MIN_TEXT_CHARS = 200;

const SUPPORTED = new Set(['.pdf', '.txt', '.md']);

const ensureDir = () => fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST(), 'utf8')); }
  catch { return { documents: [] }; }
}

function writeManifest(m) {
  ensureDir();
  fs.writeFileSync(MANIFEST(), JSON.stringify(m, null, 2) + '\n');
}

/** Uploaded documents, newest first. Text is not loaded — use `corpus()`. */
export function listDocuments() {
  return [...readManifest().documents].sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
}

// The extension is added back separately, so drop it here or the stored file ends
// up as "cv.pdf.pdf".
const slug = name => String(name).replace(/\.[^.]+$/, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/**
 * Add a document to the corpus.
 *
 * @param filename  the original name, kept for display and for citing evidence
 * @param buffer    the file's bytes
 * @throws when the type is unsupported or no text can be extracted
 */
export async function addDocument(filename, buffer) {
  const ext = path.extname(String(filename)).toLowerCase();
  if (!SUPPORTED.has(ext)) {
    throw new Error(`${ext || 'that file type'} is not supported — upload a PDF, TXT or MD`);
  }
  ensureDir();

  const id = `${Date.now().toString(36)}-${slug(filename) || 'document'}`;
  const filePath = path.join(EVIDENCE_DIR, `${id}${ext}`);
  fs.writeFileSync(filePath, buffer);

  let text = '';
  try {
    // Line-aware extraction, not extractPdfText: the evidence quote is the line a
    // skill was found on, and section headings are recognised by starting one.
    text = ext === '.pdf' ? await extractPdfLines(filePath) : fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    fs.rmSync(filePath, { force: true });
    throw new Error(`could not read ${filename}: ${err.message}`);
  }

  // Keep the line structure: §4's role attribution needs to know which lines sit
  // under which heading, so this deliberately does NOT collapse newlines the way
  // resume-context.js does for prompt text.
  text = String(text).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  if (text.length < MIN_TEXT_CHARS) {
    fs.rmSync(filePath, { force: true });
    throw new Error(
      `${filename} has no readable text layer (${text.length} characters). ` +
      `It is probably a scan or an image export — upload a PDF exported from the document itself.`
    );
  }

  const textPath = path.join(EVIDENCE_DIR, `${id}.txt`);
  fs.writeFileSync(textPath, text);

  const entry = {
    id, filename: String(filename), uploadedAt: new Date().toISOString(),
    chars: text.length, file: path.basename(filePath), textFile: path.basename(textPath),
  };
  const m = readManifest();
  m.documents = [...m.documents.filter(d => d.id !== id), entry];
  writeManifest(m);
  return entry;
}

export function removeDocument(id) {
  const m = readManifest();
  const doc = m.documents.find(d => d.id === id);
  if (!doc) return false;
  for (const f of [doc.file, doc.textFile]) {
    if (f) fs.rmSync(path.join(EVIDENCE_DIR, f), { force: true });
  }
  m.documents = m.documents.filter(d => d.id !== id);
  writeManifest(m);
  return true;
}

/**
 * Every document's text, for the evidence matcher.
 *
 * Returned per document rather than concatenated: evidence has to cite which CV
 * it came from, and role attribution reads one document's layout at a time.
 */
export function corpus() {
  const out = [];
  for (const doc of listDocuments()) {
    if (!doc.textFile) continue;
    try {
      out.push({ id: doc.id, filename: doc.filename, text: fs.readFileSync(path.join(EVIDENCE_DIR, doc.textFile), 'utf8') });
    } catch { /* a document removed from under us is simply not evidence */ }
  }
  return out;
}

/** True when there is anything to reason over. Callers must degrade, not throw. */
export const hasCorpus = () => corpus().length > 0;

export const evidenceDir = () => EVIDENCE_DIR;
