// Phase 6 tests. The dangerous failure here is a hallucinated recipient — an
// application posted to a stranger — so extraction is pinned to addresses that
// literally appear in the posting. MIME correctness matters too: a malformed
// message is unrecoverable once sent.
import fs from 'node:fs';
import path from 'node:path';
import {
  looksLikeEmailApplication, extractHeuristically, missingAttachments, buildSubject,
  detectRequiredDocuments,
} from '../src/email/extract.js';
import { buildMimeMessage, toBase64Url } from '../src/email/mime.js';
import { composeCoverEmail } from '../src/email/compose.js';
import { draftEmailApplication, HOLD_MINUTES } from '../src/email/outbox.js';
import { db, upsertJob, updateJob, outboxPending, cancelEmail, outboxDue } from '../src/db.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const section = s => console.log(`\n${s}`);

const PROFILE = {
  identity: { firstName: 'Khosi', lastName: 'Siphugu', email: 'k@example.com', phone: '+27 82 000 0000', city: 'Johannesburg', country: 'South Africa' },
  links: { linkedin: 'https://linkedin.com/in/khosi' },
  authorization: { countries: { ZA: { authorized: true } }, noticePeriodDays: 30, confirmed: true },
  current: { company: 'Hyve Mobile', title: 'AdOps Operations Assistant', totalYearsExperience: 3, confirmed: true },
  education: [{ institution: 'UCT', degree: 'BBusSc', field: 'Analytics', end: '2020' }],
  certifications: [], skills: { SQL: { years: 3, confirmed: true } },
  compensation: {}, eeo: {}, misc: {},
};

section('detecting an email application');
t('ZA-style posting detected',
  looksLikeEmailApplication('Please send your CV to careers@company.co.za before 15 August.'), true);
t('"email your application" detected',
  looksLikeEmailApplication('Email your application to jobs@acme.com'), true);
t('"forward your resume" detected',
  looksLikeEmailApplication('Forward your resume to hr@acme.co.za'), true);
t('an address alone is not enough',
  looksLikeEmailApplication('Questions? Contact recruiter@acme.com. Apply via the button below.'), false);
t('no address at all',
  looksLikeEmailApplication('Send your CV through our portal.'), false);

section('heuristic extraction — used when there is no LLM key');
const jd = 'Marketing Analyst. Send your CV to careers@takealot.co.za and quote reference MKT/2026/04 in the subject line.';
t('pulls the address', extractHeuristically(jd).to, 'careers@takealot.co.za');
t('pulls the reference number', extractHeuristically(jd).referenceNumber, 'MKT/2026/04');
t('marks itself degraded', extractHeuristically(jd).degraded, true);
t('reference with "Ref:" form',
  extractHeuristically('Apply to a@b.co.za. Ref: ABC-123').referenceNumber, 'ABC-123');

section('subject lines — ZA postings bin applications with no reference');
t('uses the posting template when given',
  buildSubject({ subjectTemplate: 'Application - MKT/2026/04' }, { title: 'X' }, PROFILE), 'Application - MKT/2026/04');
t('otherwise includes the reference',
  buildSubject({ referenceNumber: 'MKT/2026/04' }, { title: 'Marketing Analyst' }, PROFILE),
  'Application: Marketing Analyst — Ref MKT/2026/04 — Khosi Siphugu');
t('plain subject when there is no reference',
  buildSubject({}, { title: 'Marketing Analyst' }, PROFILE),
  'Application: Marketing Analyst — Khosi Siphugu');

section('required-document detection is deterministic, not model-dependent');
t('certified ID copy', detectRequiredDocuments('Send a certified copy of your ID document'), ['id_document']);
t('transcripts', detectRequiredDocuments('Attach your academic transcripts'), ['transcripts']);
t('police clearance', detectRequiredDocuments('A police clearance is required'), ['police_clearance']);
t('several at once',
  detectRequiredDocuments('Send your CV, ID document and matric certificate').sort(),
  ['certificates', 'id_document']);
t('nothing demanded', detectRequiredDocuments('Send your CV to a@b.com'), []);
t('heuristic path surfaces them',
  extractHeuristically('Email your CV and a copy of your ID to a@b.co.za').requiredAttachments.sort(),
  ['cv', 'id_document']);

section('attachments we cannot produce park the application');
t('id document flagged', missingAttachments(['cv', 'id_document']), ['id_document']);
t('transcripts flagged', missingAttachments(['cv', 'transcripts']), ['transcripts']);
t('spaces normalised', missingAttachments(['ID Document']), ['id_document']);
t('cv and cover letter are fine', missingAttachments(['cv', 'cover_letter']), []);

section('MIME construction');
const tmpPdf = path.resolve('artifacts/_attach.pdf');
fs.mkdirSync(path.dirname(tmpPdf), { recursive: true });
fs.writeFileSync(tmpPdf, '%PDF-1.4\n%fake\n');

const mime = buildMimeMessage({
  from: 'k@example.com', to: 'careers@acme.co.za', cc: ['hr@acme.co.za'],
  subject: 'Application: Marketing Analyst — Ref MKT/2026/04',
  body: 'Dear Hiring Team,\n\nHere is my application — with an em dash and a café.\n\nKind regards,\nKhosi',
  attachments: [tmpPdf],
});
t('has From/To/Cc', /From: k@example\.com/.test(mime) && /To: careers@acme\.co\.za/.test(mime) && /Cc: hr@acme\.co\.za/.test(mime), true);
t('non-ASCII subject is RFC 2047 encoded', /Subject: =\?UTF-8\?B\?/.test(mime), true);
t('subject header is pure ASCII', /^Subject: [\x20-\x7E]+$/m.test(mime), true);
t('multipart boundary declared and used',
  (() => { const b = mime.match(/boundary="(.+?)"/)?.[1]; return !!b && mime.includes(`--${b}--`); })(), true);
t('body base64-encoded, not raw 8-bit', !mime.includes('café'), true);
t('body round-trips',
  (() => {
    const b = mime.match(/boundary="(.+?)"/)[1];
    const part = mime.split(`--${b}`)[1];
    const b64 = part.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    return Buffer.from(b64, 'base64').toString('utf8').includes('café');
  })(), true);
t('attachment declared with filename', /filename="_attach\.pdf"/.test(mime), true);
t('attachment content-type', /Content-Type: application\/pdf/.test(mime), true);
t('CRLF line endings throughout', !/[^\r]\n/.test(mime), true);
t('base64url has no padding or +/', (() => { const u = toBase64Url(mime); return !/[+/=]/.test(u); })(), true);

let threw = null;
try { buildMimeMessage({ from: 'a@b.c', to: 'd@e.f', subject: 's', body: 'b', attachments: ['/nope.pdf'] }); }
catch (e) { threw = e.message; }
t('missing attachment throws rather than sending without it', /Attachment not found/.test(threw || ''), true);

section('cover email composition (no LLM key → deterministic fallback)');
const body = await composeCoverEmail(
  { title: 'Marketing Analyst', company: 'Takealot', jd_text: 'SQL and dashboards.' },
  PROFILE, { referenceNumber: 'MKT/2026/04', requiredBodyItems: ['notice period'] });
t('addressed', /^Dear Hiring Team,/.test(body), true);
t('signed with the real name', body.includes('Khosi Siphugu'), true);
t('includes contact details', body.includes('k@example.com') && body.includes('+27 82 000 0000'), true);
t('states the reference number', body.includes('Reference: MKT/2026/04'), true);
t('states notice period when asked', body.includes('Notice period: 30 days'), true);
t('names the actual employer', body.includes('Hyve Mobile'), true);

section('outbox — drafts hold, then send themselves');
db.exec("DELETE FROM outbox");
db.exec("DELETE FROM events");
db.exec("DELETE FROM jobs WHERE external_id LIKE 'em-%'");

const jobId = upsertJob({ external_id: 'em-1', title: 'Marketing Analyst', company: 'Takealot', location: 'Cape Town' });
updateJob(jobId, { status: 'tailored', apply_type: 'email', resume_path: tmpPdf, jd_text: jd });
const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);

const draft = await draftEmailApplication(job, PROFILE);
t('queued, not sent', draft.outcome, 'queued');
t('addressed from the posting', draft.to, 'careers@takealot.co.za');
t('reference carried through', draft.referenceNumber, 'MKT/2026/04');
t('one draft held', outboxPending().length, 1);
t('not due yet — the hold is real', outboxDue().length, HOLD_MINUTES > 0 ? 0 : 1);
t('written to disk for inspection',
  fs.existsSync(path.resolve(`artifacts/emails/${jobId}-${draft.outboxId}.txt`)), true);

t('cancelling stops it', cancelEmail(draft.outboxId), true);
t('nothing left held', outboxPending().length, 0);
t('cancelling twice is a no-op', cancelEmail(draft.outboxId), false);

section('a posting demanding documents we lack parks instead of sending');
const jobId2 = upsertJob({ external_id: 'em-2', title: 'Analyst', company: 'Acme', location: 'Cape Town' });
updateJob(jobId2, {
  status: 'tailored', apply_type: 'email', resume_path: tmpPdf,
  jd_text: 'Send your CV, a certified copy of your ID document and your academic transcripts to hr@acme.co.za',
});
const job2 = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId2);
const r2 = await draftEmailApplication(job2, PROFILE);
t('parked', r2.outcome, 'parked');
t('names the documents', /id_document|transcripts/.test(r2.parked[0].reason), true);
t('nothing queued', outboxPending().length, 0);

section('no resume on disk is an error, never an email without an attachment');
const jobId3 = upsertJob({ external_id: 'em-3', title: 'Analyst', company: 'Acme', location: 'CT' });
updateJob(jobId3, { status: 'tailored', apply_type: 'email', resume_path: '/does/not/exist.pdf', jd_text: jd });
const job3 = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId3);
let err3 = null;
try { await draftEmailApplication(job3, PROFILE); } catch (e) { err3 = e.message; }
t('throws', /No tailored resume/.test(err3 || ''), true);

// cleanup
db.exec("DELETE FROM outbox");
db.exec("DELETE FROM events");
db.exec("DELETE FROM parked_questions");
db.exec("DELETE FROM jobs WHERE external_id LIKE 'em-%'");
fs.rmSync(tmpPdf, { force: true });
fs.rmSync(path.resolve('artifacts/emails'), { recursive: true, force: true });

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
