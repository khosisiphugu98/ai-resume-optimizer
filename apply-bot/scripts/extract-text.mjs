// Text-layer validation gate. Used by verification and, later, by the pipeline
// before any tailored PDF is uploaded to an ATS.
import fs from 'node:fs';

export async function extractPdfText(pdfPath) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const pdf = await getDocument({ data, useSystemFonts: true }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    text += content.items.map(it => it.str).join(' ') + '\n';
  }
  return text;
}

/**
 * The same text, but with the page's actual line breaks.
 *
 * `extractPdfText` joins every item on a page into one line, which is fine for
 * asking "is there a text layer". It is not fine for reading a CV: with no line
 * breaks, a quote cannot be cut to the line it came from, and a heading like
 * EDUCATION cannot be told from the same word inside a sentence. Both matter to
 * the evidence gate, which reports the line a skill was found on and uses
 * headings to find where the experience section stops.
 *
 * Lines come from pdfjs's own end-of-line flag where it sets one, and from a
 * change in baseline (`transform[5]`) where it does not.
 */
export async function extractPdfLines(pdfPath) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const pdf = await getDocument({ data, useSystemFonts: true }).promise;

  const lines = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    let line = '';
    let lastY = null;

    for (const it of content.items) {
      const y = Math.round(it.transform?.[5] ?? 0);
      // A baseline shift of more than a couple of units is a new line; smaller
      // ones are superscripts and kerning tweaks within the same line.
      if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line.trim()); line = ''; }
      line += (line ? ' ' : '') + it.str;
      lastY = y;
      if (it.hasEOL) { lines.push(line.trim()); line = ''; lastY = null; }
    }
    if (line.trim()) lines.push(line.trim());
    lines.push('');
  }
  return lines.filter((l, i) => l || lines[i - 1]).join('\n');
}

/**
 * The hard technical skills a genuine export of this résumé always contains.
 *
 * Deliberately NOT `Object.keys(profile.skills)`: that list has grown to 188
 * entries including `Remote`, `KPI`, `charts`, `collaborate` and `attention to
 * detail`, so "at least five skills found" degenerated into "at least five common
 * English words found" and any A4 page passed. Every token here was verified
 * present in a real tailored export.
 */
export const CORE_RESUME_SKILLS = [
  'SQL', 'Python', 'GA4', 'Looker Studio', 'Tableau',
  'Power BI', 'Grafana', 'programmatic',
];

// Assert a generated resume PDF is actually machine-readable.
export function validateResumePdf(text, { name, email, skills = [] }) {
  const hay = text.toLowerCase();
  const found = skills.filter(s => hay.includes(s.toLowerCase()));
  return {
    ok: hay.includes(name.toLowerCase()) && hay.includes(email.toLowerCase()) && found.length >= 5,
    chars: text.length,
    hasName: hay.includes(name.toLowerCase()),
    hasEmail: hay.includes(email.toLowerCase()),
    skillsFound: found,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = await extractPdfText(process.argv[2]);
  console.log(validateResumePdf(text, {
    name: 'Khosi Siphugu',
    email: 'mksiphugu@gmail.com',
    skills: CORE_RESUME_SKILLS,
  }));
  console.log('\n--- first 400 chars ---\n' + text.slice(0, 400));
}
