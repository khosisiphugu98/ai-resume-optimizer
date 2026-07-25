import fs from 'node:fs';
import { extractPdfText } from '../../scripts/extract-text.mjs';

// The structured profile carries facts (titles, dates, skills) but no prose —
// the experience bullets and achievements that make an open-ended answer good,
// and that most yes/no questions can be inferred from, live only in the résumé.
// This makes that text available to the answer resolver.
//
// Cached by path+mtime so the PDF is parsed once per apply run rather than once
// per field. Best-effort: a missing or unreadable PDF returns '' and the resolver
// simply falls back to the structured profile, exactly as before.
let cache = { path: null, mtime: 0, text: '' };

export async function resumeText(pdfPath, { maxChars = 6000 } = {}) {
  if (!pdfPath || !fs.existsSync(pdfPath)) return '';
  const mtime = fs.statSync(pdfPath).mtimeMs;
  if (cache.path === pdfPath && cache.mtime === mtime) return cache.text;

  let text = '';
  try {
    const raw = await extractPdfText(pdfPath);
    // Collapse the PDF's ragged whitespace and cap length so a long CV cannot
    // crowd out the profile or the job description in the prompt.
    text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
  } catch { text = ''; }

  cache = { path: pdfPath, mtime, text };
  return text;
}
