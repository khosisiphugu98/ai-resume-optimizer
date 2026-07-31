// The last look before anything reaches an employer, and the rule it enforces:
// Claude reads and objects, deterministic code decides, and the model never gets
// to choose a value. No network — the reviewer is injected.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflight, deterministicObjections, preflightGate } from '../src/apply/preflight.js';
import { resolveFormBatch, resolveField, DETERMINISTIC_ONLY_REASON } from '../src/answer/resolver.js';
import { listSubmissions } from '../src/apply/submission-log.js';

const readSubmissionsFrom = (file, opts = {}) => listSubmissions({ file, limit: 100, ...opts });

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const section = s => console.log(`\n${s}`);

const P = {
  identity: { firstName: 'Khosi', lastName: 'Siphugu', email: 'k@example.com', phone: '+27 82 000 0000', city: 'Pretoria', country: 'South Africa', confirmed: true },
  links: { linkedin: 'https://linkedin.com/in/khosi', github: '', portfolio: '' },
  authorization: { countries: { ZA: { authorized: true, requiresSponsorship: false } }, willingToRelocate: true, noticePeriodDays: 30, confirmed: true },
  current: { company: 'Hyve Mobile', title: 'AdOps Operations Assistant', totalYearsExperience: 3, confirmed: true },
  education: [{ institution: 'UCT', degree: 'BBusSc', field: 'Analytics', end: '2020' }],
  certifications: [],
  skills: { SQL: { years: 3, confirmed: true } },
  compensation: { fallbackText: 'Negotiable' },
  consent: { dataProcessing: true, dataSharing: false, marketingEmail: false, smsUpdates: false, talentPool: false },
  misc: { howDidYouHear: 'LinkedIn' },
};

// The reviewer is never allowed to be the reason something sends, only a reason
// it does not — so every test here injects one rather than reaching the network.
const reviewer = objections => async () => ({ objections });
const withReviewer = objections => ({ callFn: reviewer(objections), enabled: on, hasKeyFn: on });
const silent = reviewer([]);
const on = () => true;

section('what the deterministic half catches on its own');
{
  const objs = f => deterministicObjections({ filled: f, profile: P });

  // The string that was typed into Gulf Associates' form and submitted.
  t('the sentinel that reached an employer',
    objs([{ question: 'Portfolio / work samples', value: 'unanswerable', tier: 'llm' }])[0]?.severity, 'block');
  t('and it says what it is',
    /word for "I cannot answer this"/.test(objs([{ question: 'Portfolio', value: 'unanswerable' }])[0]?.why || ''), true);

  t('a value that contradicts a plain profile fact',
    objs([{ question: 'Last name', value: 'Smith', tier: 'llm' }])[0]?.severity, 'block');
  t('the same fact, stated correctly, passes',
    objs([{ question: 'Last name', value: 'Siphugu', tier: 'profile' }]).length, 0);

  // The value the resolver fitted onto the control's option list. It is the same
  // answer, said in the form's words — and the options have to travel with it,
  // because "Phone country code" means two different questions with and without
  // them.
  const CODES = ['United States +1', 'South Africa +27'];
  t('an option-fitted value is still the profile\'s answer',
    objs([{ question: 'Phone country code', value: 'South Africa +27', tier: 'profile', options: CODES }]).length, 0);
  t('and a wrong one against the same list is caught',
    objs([{ question: 'Phone country code', value: 'United States +1', tier: 'llm', options: CODES }])[0]?.severity, 'block');
  t('with no options recorded, an option-dependent field is left alone',
    objs([{ question: 'Phone country code', value: 'South Africa +27', tier: 'profile' }]).length, 0);

  t('a permission granted against the profile',
    objs([{ question: 'Do you allow us to provide you TEXT/SMS updates?', value: 'Yes', tier: 'bank-exact' }])[0]?.severity, 'block');
  t('and one granted in line with it',
    objs([{ question: 'Do you allow us to provide you TEXT/SMS updates?', value: 'No', tier: 'profile' }]).length, 0);

  t('the CV attachment is not an answer to check',
    objs([{ question: 'Resume', value: 'cv.pdf', kind: 'file' }]).length, 0);
  t('an ordinary open-text answer is left alone',
    objs([{ question: 'Why do you want this role?', value: 'The role sits squarely in campaign analytics.', tier: 'llm' }]).length, 0);
}

section('what the reviewer is allowed to do with what it finds');
{
  const filled = [{ question: 'Which statement fits best your experience?', value: 'Proficient in SQL and Advanced Excel', tier: 'llm' }];
  const run = (objections, extra = {}) =>
    preflight({ filled, profile: P, ...extra }, withReviewer(objections));

  t('a "block" objection holds the application',
    (await run([{ question: 'x', value: 'y', why: 'the profile says intermediate Excel', severity: 'block' }])).ok, false);
  t('and the reason names the field and the value',
    /Advanced Excel|Which statement/.test((await run([{ question: 'Which statement fits best your experience?', value: 'Proficient in SQL and Advanced Excel', why: 'the profile says intermediate Excel', severity: 'block' }])).reason || ''), true);

  t('a "note" does not',
    (await run([{ question: 'x', value: 'y', why: 'a bit terse', severity: 'note' }])).ok, true);
  t('but it is still reported',
    (await run([{ question: 'x', value: 'y', why: 'a bit terse', severity: 'note' }])).notes.length, 1);

  t('nothing to say means send',
    (await preflight({ filled, profile: P }, withReviewer([]))).ok, true);

  // An outage is not evidence that the application is wrong. Refusing to send
  // because the reviewer was unreachable turns a bad minute into a lost job.
  const broken = async () => { throw new Error('Claude 503'); };
  t('a reviewer that cannot be reached never blocks',
    (await preflight({ filled, profile: P }, { callFn: broken, enabled: on, hasKeyFn: on })).ok, true);
  t('but the deterministic half still runs when it is down',
    (await preflight({
      filled: [{ question: 'Portfolio', value: 'unanswerable' }], profile: P,
    }, { callFn: broken, enabled: on, hasKeyFn: on })).ok, false);

  // A spend limit is the opposite case, and used to be treated as the same one.
  // "You will regain access on 2026-08-01 at 00:00 UTC" says in the error itself
  // that the next attempt will fail too — so shrugging and sending on the
  // deterministic half means sending unreviewed for the rest of the day. It did,
  // four times, on 31 July. Hold instead: the application keeps, the reviewer
  // comes back, and nothing reaches an employer that no one read.
  const overLimit = async () => {
    throw new Error('Claude 400: {"error":{"message":"You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC."}}');
  };
  const held = await preflight({ filled, profile: P }, { callFn: overLimit, enabled: on, hasKeyFn: on });
  t('a spend limit holds rather than sending unreviewed', held.ok, false);
  t('  → and says which, so it is not mistaken for a bad answer',
    /reviewer is unavailable/.test(held.reason || ''), true);

  for (const [label, msg] of [
    ['a 429', 'Claude 429: rate_limit_error'],
    ['a bad key', 'Claude 401: authentication_error'],
    ['no credit', 'Your credit balance is too low'],
  ]) {
    t(`${label} holds too`,
      (await preflight({ filled, profile: P }, { callFn: async () => { throw new Error(msg); }, enabled: on, hasKeyFn: on })).ok, false);
  }

  // The split has to stay a split. A 500 or a dropped socket is still a blip.
  for (const [label, msg] of [
    ['a 503', 'Claude 503'],
    ['an overload', 'Claude 500: overloaded_error'],
    ['a dead socket', 'fetch failed'],
  ]) {
    t(`${label} still degrades rather than holding`,
      (await preflight({ filled, profile: P }, { callFn: async () => { throw new Error(msg); }, enabled: on, hasKeyFn: on })).ok, true);
  }

  t('turned off, it allows everything',
    (await preflight({
      filled: [{ question: 'Portfolio', value: 'unanswerable' }], profile: P,
    }, { callFn: silent, enabled: () => false, hasKeyFn: on })).ok, true);
}

section('the gate the wizard consults, and the check it wraps');
{
  const gate = also => preflightGate({ profile: P, job: null, also }, withReviewer([]));

  t('a clean application is allowed to submit',
    await gate()({ filled: [{ question: 'First name', value: 'Khosi', tier: 'profile' }], steps: 1 }), null);
  t('a sentinel holds it, with a reason',
    typeof await gate()({ filled: [{ question: 'Portfolio', value: 'unanswerable' }], steps: 1 }), 'string');

  // The adapter's own reason has to win: "there is nowhere to attach a CV" is a
  // more specific and more useful thing to tell an operator than anything the
  // review could say about the values.
  t('the adapter\'s own check runs first and wins',
    await gate(async () => 'nowhere to attach a CV')({ filled: [], steps: 1 }), 'nowhere to attach a CV');
}

section('deterministicOnly — Claude finds the field, the profile fills it');
{
  const ctx = { profile: P, countryCode: 'ZA', deterministicOnly: true };
  const form = [
    { uid: 'a', question: 'First name', fieldType: 'text' },
    { uid: 'b', question: 'Why do you want to work here?', fieldType: 'textarea' },
  ];
  const out = await resolveFormBatch(form, ctx);

  t('the profile still answers what it knows',
    out.resolved.find(r => r.uid === 'a')?.value, 'Khosi');
  t('and what it does not know parks rather than being written',
    out.resolved.find(r => r.uid === 'b')?.status, 'park');
  t('at a tier that says why',
    out.resolved.find(r => r.uid === 'b')?.tier, 'deterministic-only');
  t('the reason tells the operator what to do',
    out.resolved.find(r => r.uid === 'b')?.reason, DETERMINISTIC_ONLY_REASON);
  t('so the form is not ok to submit', out.ok, false);

  t('the single-field path agrees',
    (await resolveField({ question: 'Why do you want to work here?' }, ctx)).tier, 'deterministic-only');

  // Without the flag the same field would go to the model — which is the
  // behaviour every other path keeps.
  t('and the flag is what does it, not the question',
    (await resolveFormBatch(form, { profile: P, countryCode: 'ZA' }))
      .resolved.find(r => r.uid === 'b')?.tier !== 'deterministic-only', true);
}

// The ledger is append-only because it is evidence, so a corrected outcome
// arrives as a new line for an application that already has one. Reading every
// line back reported five submissions where there were three real ones and one
// retraction — and showed the retraction as a second application to the same
// company.
section('a corrected record is not a second application (D5)');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subs-'));
  const log = path.join(dir, 'submissions.jsonl');
  const line = (applicationId, at, outcome, company) => JSON.stringify({
    submittedAt: at, outcome, applicationId, channel: 'external_ats',
    job: { id: 2136, title: 'Data Analyst', company }, fieldCount: 3, fields: [],
  });
  fs.writeFileSync(log, [
    line(85, '2026-07-28T06:00:00Z', 'submitted', 'Gulf Associates'),
    line(87, '2026-07-28T07:36:41Z', 'submitted', 'Famous Brands'),
    line(86, '2026-07-28T06:30:00Z', 'submitted_unconfirmed', 'Agoda'),
    line(87, '2026-07-28T12:09:32Z', 'error', 'Famous Brands'),
  ].join('\n') + '\n');

  const rows = readSubmissionsFrom(log);
  t('one record per application', rows.length, 3);
  t('the latest record wins', rows.find(r => r.applicationId === 87).outcome, 'error');
  t('and says it was corrected', rows.find(r => r.applicationId === 87).corrections, 1);
  t('newest first', rows.map(r => r.applicationId), [87, 86, 85]);
  t('an unconfirmed send is still a send',
    rows.filter(r => String(r.outcome).startsWith('submitted')).length, 2);
  t('the raw ledger is still readable in full',
    readSubmissionsFrom(log, { includeSuperseded: true }).length, 4);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
