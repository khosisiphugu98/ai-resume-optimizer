// Tailoring guards. The failure these exist to stop is silent and expensive: a
// no-op optimisation exports the untailored seed CV under a job-specific filename,
// and every downstream check passes it. 19 of 164 résumés on disk were duplicates
// that way, including the only application ever emailed. No network.
import './_sandbox.mjs';   // refuses to run against the real database
import { normaliseResumeText, outputName, resumeTextHash } from '../src/tailor/optimiser.js';
import { db, resumeHashOwner } from '../src/db.js';
import { validateResumePdf, CORE_RESUME_SKILLS } from './extract-text.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const section = s => console.log(`\n${s}`);

// The comparison tailorForJob makes: the rendered document before optimisation
// versus after. An earlier version of this guard compared the export against the
// SEED PDF and would have caught nothing — the optimiser re-renders the seed into
// its own template, so an untailored export matches the other untailored exports
// (hash 4532b3dd… across 14 files) and never the seed file itself (dc7cb603…).
section('unchanged document is detected as untailored');
{
  const BASE = '  KHOSI SIPHUGU   Marketing Analyst\n\n SQL  Python  GA4 ';
  const before = normaliseResumeText(BASE);

  t('whitespace-only difference is still unchanged',
    normaliseResumeText('KHOSI SIPHUGU Marketing Analyst\nSQL Python GA4') === before, true);

  t('a real edit is a change',
    normaliseResumeText(`${BASE} Looker Studio`) === before, false);

  t('normalisation is idempotent', normaliseResumeText(before), before);
}

// `skills` used to be Object.keys(profile.skills) — 188 entries that had grown to
// include "Remote", "KPI", "charts", "collaborate" and "attention to detail". Five
// of those appearing on a page was enough to certify it as a résumé.
section('the text-layer check needs real skills, not five English words');
{
  const generic = 'Khosi Siphugu k@example.com Remote KPI charts collaborate innovation datasets';
  const asBefore = validateResumePdf(generic, {
    name: 'Khosi Siphugu', email: 'k@example.com',
    skills: ['Remote', 'KPI', 'charts', 'collaborate', 'innovation', 'datasets'],
  });
  t('the old broad list certified junk', asBefore.ok, true);

  const asNow = validateResumePdf(generic, {
    name: 'Khosi Siphugu', email: 'k@example.com', skills: CORE_RESUME_SKILLS,
  });
  t('the curated list rejects it', asNow.ok, false);

  const real = 'Khosi Siphugu k@example.com SQL Python GA4 Looker Studio Tableau Power BI Grafana programmatic';
  t('and still passes a real résumé', validateResumePdf(real, {
    name: 'Khosi Siphugu', email: 'k@example.com', skills: CORE_RESUME_SKILLS,
  }).ok, true);
}

section('single-page ratio');
{
  // Mirrors the guard in tailorForJob. Measured across 40 real exports: 675px wide,
  // ratio 1.22–1.33. A doubled document lands near 2.6.
  const MAX = 1.8;
  const overLimit = (w, h) => h / w > MAX;
  t('a real export passes', overLimit(675, 897), false);
  t('A4 passes', overLimit(675, 954), false);
  t('a doubled document fails', overLimit(675, 1794), true);
}

// Company and title are both truncated to 40 characters, so two long postings
// at the same employer produced the same path and one job's CV overwrote the
// other's: 190 tailored rows mapped to 159 distinct files on disk.
section('two postings never write to the same file');
{
  const who = { identity: { firstName: 'Khosi', lastName: 'Siphugu' } };
  const long = c => `Senior Performance Marketing and Digital Analytics ${c}`;
  const a = outputName({ id: 1401, company: 'Standard Bank Group', title: long('Manager') }, who);
  const b = outputName({ id: 1402, company: 'Standard Bank Group', title: long('Specialist') }, who);
  t('truncated titles still differ', a === b, false);
  t('the same job re-tailors to the same file',
    outputName({ id: 1401, company: 'Standard Bank Group', title: long('Manager') }, who), a);
  t('still a name a recruiter can read', /^Khosi_Siphugu_CV_Standard_Bank_Group_/.test(a), true);
}

// The untailored-CV guard compares a document against its own earlier self, so
// it catches "optimisation changed nothing" and is structurally blind to
// "optimisation changed the same things for four unrelated jobs". Four of 28
// exports were byte-identical across four job descriptions with four different
// match scores — 14% of the run, every one a CV written for another posting.
section('the same document for two different postings (D2)');
{
  const CV = 'Khosi Siphugu — Marketing Analyst. SQL, Python, Power BI. ETL pipelines.';

  t('the same text hashes the same', resumeTextHash(CV), resumeTextHash(CV));
  t('whitespace is not a difference',
    resumeTextHash(CV), resumeTextHash(`  ${CV.replace(/ /g, '\n  ')}  `));
  t('different text hashes differently',
    resumeTextHash(CV) === resumeTextHash(`${CV} Tableau.`), false);

  const hash = resumeTextHash(CV);
  db.prepare(`INSERT INTO jobs (id, external_id, url, title, company, discovered_at, apply_type, status, resume_text_hash)
              VALUES (7701, 'cv-a', 'x', 'PPC Manager', 'HYRAX', datetime('now'), 'external', 'tailored', ?)`).run(hash);

  const twin = resumeHashOwner(hash, 7702);
  t('a second job producing the same CV finds the first', twin?.id, 7701);
  t('and can name it', `${twin?.title} @ ${twin?.company}`, 'PPC Manager @ HYRAX');
  t('re-tailoring the same job is not a duplicate of itself',
    resumeHashOwner(hash, 7701), null);
  t('a genuinely different CV is fine',
    resumeHashOwner(resumeTextHash(`${CV} Tableau.`), 7702), null);

  db.prepare('DELETE FROM jobs WHERE id = 7701').run();
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
