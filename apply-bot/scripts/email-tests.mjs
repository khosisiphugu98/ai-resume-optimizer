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
import {
  extractInstructions, isClosed, unmeetableRequirements,
} from '../src/discover/jd-instructions.js';
import { classifyApply } from '../src/discover/linkedin.js';
import { buildMimeMessage, toBase64Url } from '../src/email/mime.js';
import { composeCoverEmail } from '../src/email/compose.js';
import { verifyCoverLetter, extractClaims } from '../src/email/verify.js';
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
// The one email this system has sent went out as "Application for BI Engineer
// Position": no name, no reference, the real title abbreviated into something a
// recruiter cannot search for. That came from `subjectTemplate`, which the model
// fills in on every extraction whether or not the posting asked for a subject,
// and which unconditionally beat the subject built here.
t('a subject the posting dictated is obeyed',
  buildSubject({ instructedSubject: 'Application - MKT/2026/04' }, { title: 'X' }, PROFILE),
  'Application - MKT/2026/04');
t('a subject the model invented is not',
  buildSubject({ subjectTemplate: 'Application for BI Engineer Position' },
    { title: 'Business Intelligence Engineer' }, PROFILE),
  'Application: Business Intelligence Engineer — Khosi Siphugu');
t('unless the posting really did instruct it',
  buildSubject({ subjectTemplate: 'Quote ref MKT/2026/04', subjectWasInstructed: true }, { title: 'X' }, PROFILE),
  'Quote ref MKT/2026/04');
t('otherwise includes the reference',
  buildSubject({ referenceNumber: 'MKT/2026/04' }, { title: 'Marketing Analyst' }, PROFILE),
  'Application: Marketing Analyst — Ref MKT/2026/04 — Khosi Siphugu');
t('plain subject when there is no reference',
  buildSubject({}, { title: 'Marketing Analyst' }, PROFILE),
  'Application: Marketing Analyst — Khosi Siphugu');

// jd_text was always passed to the model so it could reason from it, and
// nothing in the pipeline ever extracted an instruction from a posting and
// acted on one.
section('reading what the posting actually told you to do (§7)');
{
  const i = jd => extractInstructions(jd);

  // Of 50 postings naming an address to apply to, 11 were misrouted. The
  // address is read from the sentence that instructs it, not from the document.
  t('an apply address in the instruction sentence',
    i('Suitable candidates should send their CV to careers@pineapple.co.za').applyEmail,
    'careers@pineapple.co.za');
  t('another phrasing entirely',
    i('Applications must be emailed to nsmith@redglobal.com before month end.').applyEmail,
    'nsmith@redglobal.com');
  // legal@metricgroup.net was extracted as the apply address for a Maintenance
  // Foreman post. A role inbox is not an invitation.
  t('a role inbox is never the apply address',
    i('Send your CV to legal@metricgroup.net').applyEmail, null);
  t('an address that is not an instruction is ignored',
    i('For data queries contact dpo@acme.co.za. Apply via the button above.').applyEmail, null);
  t('and the router follows it',
    classifyApply({ jd: 'Suitable candidates should send their CV to careers@pineapple.co.za', applyRoute: 'unknown' }),
    { applyType: 'email', applyEmail: 'careers@pineapple.co.za' });
  t('a posting with no instruction keeps its scraped route',
    classifyApply({ jd: 'A great role on our data team.', applyRoute: 'external' }).applyType, 'external');

  t('a reference code', i('Please quote reference number MKT/2026/04').referenceNumber, 'MKT/2026/04');
  t('a dictated subject line',
    i('Email us with the subject line: Data Analyst Application 2026').subjectLine,
    'Data Analyst Application 2026');

  t('a portfolio request', i('Please include a link to your portfolio.').requires, ['portfolio']);
  t('an assessment', i('You will be required to complete an online test.').requires, ['assessment']);
  t('a cover letter', i('Attach a covering letter with your application.').requires, ['cover_letter']);
  t('an ordinary posting demands nothing', i('We are hiring a data analyst.').requires, []);

  t('a closing date, day-first', i('Closing date: 15/08/2026').closingDate, '2026-08-15');
  t('written out', i('Applications close on 15 August 2026').closingDate, '2026-08-15');
  t('already ISO', i('Deadline: 2026-08-15').closingDate, '2026-08-15');
  // A bare date in a description is far more often a start date than a deadline.
  t('an unlabelled date is not a deadline', i('Start date 15 August 2026').closingDate, null);
  t('a passed date closes the posting', isClosed({ closingDate: '2026-01-01' }, new Date('2026-07-29')), true);
  t('a future one does not', isClosed({ closingDate: '2026-12-01' }, new Date('2026-07-29')), false);
  t('and no date never closes it', isClosed({}, new Date('2026-07-29')), false);

  // 13.4% of postings ask for a portfolio, and an application that silently
  // omits one is a wasted send.
  const noPortfolio = { links: { portfolio: '' } };
  t('a portfolio nobody has is a blocker',
    unmeetableRequirements({ requires: ['portfolio'] }, noPortfolio).length, 1);
  t('and one that is on file is not',
    unmeetableRequirements({ requires: ['portfolio'] }, { links: { portfolio: 'https://khosi.dev' } }).length, 0);
  t('an assessment is never satisfiable unattended',
    unmeetableRequirements({ requires: ['assessment'] }, { links: { portfolio: 'https://khosi.dev' } }).length, 1);
  // A covering letter is written for every email application, and most ATS forms
  // offer somewhere to put one. Recorded, not held.
  t('a cover letter is not a blocker',
    unmeetableRequirements({ requires: ['cover_letter'] }, noPortfolio).length, 0);
}

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

// Every one of these strings is a real posting fragment from the live database.
// The old TLD class `[\w.]{2,}` ran past the address and swallowed the full stop
// that ended the sentence, so 5 of 45 stored recipients were unsendable.
section('addresses are not captured with the sentence punctuation attached');
{
  const cases = [
    ['Send your CV to stefan@prinsandprins.com.', 'stefan@prinsandprins.com'],
    ['Applications to roelien@propdevlaw.co.za.', 'roelien@propdevlaw.co.za'],
    ['Email contact@o-ring.tech.', 'contact@o-ring.tech'],
    ['Forward to Lfrench@networkrecruitment.co.za, thanks', 'Lfrench@networkrecruitment.co.za'],
    ['CV to maria.a.anazario@aubay.pt!', 'maria.a.anazario@aubay.pt'],
  ];
  for (const [jd, want] of cases) t(want, extractHeuristically(jd).to, want);
}

section('role inboxes are never chosen as the recipient');
{
  const jd = 'Send your CV to careers@acme.com. For data requests contact dpo@acme.com.';
  t('picks careers over dpo', extractHeuristically(jd).to, 'careers@acme.com');
  const dpoFirst = 'Data protection: dpo@acme.com. Applications to recruitment@acme.com.';
  t('skips a leading dpo@', extractHeuristically(dpoFirst).to, 'recruitment@acme.com');
  const onlyRole = 'Questions to legal@acme.com only.';
  t('falls back rather than losing the job', extractHeuristically(onlyRole).to, 'legal@acme.com');
}

section('the message never advertises that a bot wrote it');
{
  const msg = buildMimeMessage({
    from: 'k@example.com', to: 'hr@acme.com', subject: 'Application',
    body: 'Hello', attachments: [], now: new Date('2026-07-27T09:00:00Z'),
  });
  t('no "bot" anywhere in the message', /bot/i.test(msg), false);
  t('has a Date header', /^Date: .+/m.test(msg), true);
  t('has a Message-ID', /^Message-ID: <.+@example\.com>/m.test(msg), true);
  t('has a Reply-To', /^Reply-To: k@example\.com/m.test(msg), true);
}

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
// The letter is the document a human reads first, and it was the one document
// with no fabrication check. On 28 July, for an amplify5 posting whose
// description asks for Azure and Microsoft Fabric, the model wrote "familiarity
// with cloud technologies, including Azure" — a named product the profile has
// never contained. The description is where the invented term came from, so the
// description may not vouch for it.
section('the covering letter cannot claim what the profile does not have');
{
  const P = {
    identity: { firstName: 'Khosi', lastName: 'Siphugu', city: 'Pretoria', country: 'South Africa' },
    current: { company: 'Hyve Mobile', title: 'AdOps Operations Assistant' },
    education: [{ institution: 'University of Cape Town', degree: 'BBusSc', field: 'Management Studies' }],
    certifications: [],
    experience: [],
    skills: { 'SQL': { confirmed: true }, 'Power BI': { confirmed: true }, 'cloud platforms': { confirmed: true } },
  };
  const JOB = { title: 'BI Engineer', company: 'amplify5' };
  const opts = { job: JOB, docs: [] };

  const azure = 'My proficiency in SQL and familiarity with cloud technologies, including Azure, align well with the role.';
  const r1 = verifyCoverLetter(azure, P, opts);
  t('the real fabrication is caught', r1.ok, false);
  t('and it names the term', r1.unvouched.includes('Azure'), true);

  const honest = 'I am currently AdOps Operations Assistant at Hyve Mobile. I work with SQL and Power BI daily.';
  t('a letter making only supported claims passes', verifyCoverLetter(honest, P, opts).ok, true);

  // The employer, the role and the candidate are named in every letter for
  // reasons that have nothing to do with claiming a skill.
  const named = 'I would like to apply for the BI Engineer position at Amplify 5. Kind regards, Khosi Siphugu.';
  t('naming the company and role is not a claim', verifyCoverLetter(named, P, opts).ok, true);

  // A phrase must not run across a full stop or a paragraph break.
  t('claims do not span sentences',
    extractClaims('We use Microsoft Fabric.\n\nAdditionally I report weekly.').includes('Microsoft Fabric.\n\nAdditionally'),
    false);

  // The evidence corpus vouches for what the CV says, even when the structured
  // profile does not list it.
  t('the CV can vouch for a claim the profile omits',
    verifyCoverLetter('I have used Looker Studio for reporting.', P,
      { job: JOB, docs: [{ text: 'Built dashboards in Looker Studio for campaign reporting.' }] }).ok,
    true);

  // The deterministic body is assembled from profile fields only, so it is the
  // safe landing place when two model attempts both invent something.
  const fb = await composeCoverEmail({ ...JOB, jd_text: '' }, {
    ...P, identity: { ...P.identity, phone: '+27 82 820 4538', email: 'k@example.com' }, links: {},
  }, {});
  t('the fallback letter passes its own gate', verifyCoverLetter(fb, P, opts).ok, true);
}

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
