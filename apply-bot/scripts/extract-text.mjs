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
    skills: ['SQL', 'Python', 'GA4', 'Looker Studio', 'Tableau', 'Power BI', 'Grafana', 'programmatic'],
  }));
  console.log('\n--- first 400 chars ---\n' + text.slice(0, 400));
}
