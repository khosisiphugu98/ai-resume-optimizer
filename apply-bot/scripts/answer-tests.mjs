// Phase 2 tests. The important ones are the anti-fabrication guarantees: these
// answers go on real employment applications, so a wrong one has consequences
// beyond a failing build. No network.
import { resolveField, guardAnswer, unreadableQuestion } from '../src/answer/resolver.js';
import { resumeText } from '../src/answer/resume-context.js';
import { extractSkill, matchProfile, normalisePunctuation, stripImperative, channelEmail } from '../src/answer/matchers.js';
import { matchOption } from '../src/answer/options.js';
import { normaliseQuestion, similarity, saveAnswer, learnFromApproved } from '../src/answer/bank.js';
import { skillYears } from '../src/profile.js';
import { db, parkQuestions, parkedQueue, releaseAnswered, upsertJob, updateJob } from '../src/db.js';
import { heuristicScore, normaliseBlockers } from '../src/score/index.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const section = s => console.log(`\n${s}`);

// A profile where SQL is confirmed and Python deliberately is not.
const P = {
  identity: { firstName: 'Khosi', lastName: 'Siphugu', email: 'k@example.com', phone: '+27 82 000 0000', city: 'Johannesburg', country: 'South Africa' },
  links: { linkedin: 'https://linkedin.com/in/khosi', github: '', portfolio: '' },
  authorization: { countries: { ZA: { authorized: true, requiresSponsorship: false } }, requiresSponsorshipElsewhere: true, willingToRelocate: false, noticePeriodDays: 30, confirmed: true },
  current: { company: 'Hyve Mobile', title: 'AdOps Operations Assistant', totalYearsExperience: 3, confirmed: true },
  education: [{ institution: 'UCT', degree: 'BBusSc', field: 'Analytics', end: '2020' }],
  certifications: [{ name: 'Google Analytics Certification', issuer: 'Google', year: 2023 }],
  skills: { SQL: { years: 3, confirmed: true }, Python: { years: 3, confirmed: false }, 'Power BI': { years: 2, confirmed: true } },
  compensation: { fallbackText: 'Negotiable' },
  eeo: { gender: 'decline' },
  misc: { howDidYouHear: 'LinkedIn', hasDriversLicense: null },
};
const ctx = { profile: P, countryCode: 'ZA', company: 'Acme', ats: 'greenhouse' };
const r = async (question, extra = {}) => await resolveField({ question, ...extra }, ctx);

section('skill extraction');
t('with X',        extractSkill('How many years of experience do you have with SQL?'), 'SQL');
t('in X',          extractSkill('Years of experience in Python'), 'Python');
t('using X',       extractSkill('How many years have you spent using Power BI?'), 'Power BI');
t('bare → null',   extractSkill('How many years of experience do you have?'), null);

section('years of experience — MUST come from confirmed profile values');
t('confirmed skill answers',   (await r('How many years of experience do you have with SQL?')).value, '3');
t('confirmed via tier profile',(await r('How many years of experience do you have with SQL?')).tier, 'profile');
t('UNCONFIRMED skill parks',   (await r('How many years of experience with Python?')).status, 'park');
t('unknown skill parks',       (await r('How many years of experience with Kubernetes?')).status, 'park');
t('park says why',             /not in the profile/.test((await r('How many years of experience with Kubernetes?')).reason), true);
t('bare years uses total',     (await r('How many years of experience do you have?')).value, '3');

section('work authorisation — profile only, correct polarity');
t('authorised → Yes', (await r('Are you legally authorized to work in South Africa?', { options: ['Yes', 'No'] })).value, 'Yes');
t('sponsorship → No', (await r('Do you require visa sponsorship?', { options: ['Yes', 'No'] })).value, 'No');
t('matches given options', (await r('Are you legally authorized to work in South Africa?', { options: ['I am authorised', 'I am not authorised'] })).value, 'I am authorised');

section('EEO — always decline, matched to the offered wording');
t('picks decline option', (await r('What is your gender?', { options: ['Male', 'Female', 'Prefer not to say'] })).value, 'Prefer not to say');
t('disability declines',  (await r('Do you have a disability?', { options: ['Yes', 'No', 'I do not wish to answer'] })).value, 'I do not wish to answer');
t('default when no options', (await r('Please self-identify your race')).value, 'Decline to self-identify');

section('identity and logistics');
t('email',   (await r('Email address')).value, 'k@example.com');
t('phone',   (await r('Mobile number')).value, '+27 82 000 0000');
t('linkedin',(await r('LinkedIn profile URL')).value, 'https://linkedin.com/in/khosi');
t('notice',  (await r('What is your notice period?')).value, '30 days');
t('relocate',(await r('Are you willing to relocate?', { options: ['Yes', 'No'] })).value, 'No');
t('source',  (await r('How did you hear about this role?')).value, 'LinkedIn');

section('option matching — the answer in the form\'s vocabulary, not the profile\'s');
// Safe rules: a restatement of the same answer. Available everywhere, including
// at fill time.
t('exact wins',            matchOption('30 days', ['Immediately', '30 days']).rule, 'exact');
t('case and punctuation',  matchOption('yes', ['Yes.', 'No.']).option, 'Yes.');
t('word order and filler', matchOption('Bachelors degree', ['Degree, Bachelors', 'Masters']).option, 'Degree, Bachelors');
t('yes onto a worded yes', matchOption('Yes', ['Yes, I am authorised', 'No, I am not']).option, 'Yes, I am authorised');
t('no onto a worded no',   matchOption('No', ['Yes, I am authorised', 'No, I am not']).option, 'No, I am not');
t('ambiguous polarity refuses', matchOption('Yes', ['Yes, full-time', 'Yes, part-time', 'No']), null);
t('never guesses',         matchOption('Negotiable', ['R10 000 - R20 000', 'R20 000 - R30 000']), null);

// Semantic rules: an interpretation of the answer. Resolver only, and flagged.
const sem = (v, o) => matchOption(v, o, { semantic: true });
t('30 days is 1 month',    sem('30 days', ['Immediately', '1 month', '3 months']).option, '1 month');
t('  → and is confident',  sem('30 days', ['Immediately', '1 month', '3 months']).confident, true);
t('1 month is 30 days',    sem('1 month', ['Immediately', '30 days', '60 days']).option, '30 days');
t('4 weeks is 1 month',    sem('4 weeks', ['2 weeks', '1 month', '2 months']).option, '1 month');
t('lands inside a span',   sem('45 days', ['Immediately', '1-2 months', '6 months']).option, '1-2 months');
t('immediate matches now', sem('0 days', ['Immediately', '1 month']).option, 'Immediately');
// Nothing on offer covers the true notice period: round up, never down, and say
// it is a substitution.
t('rounds up, not down',   sem('45 days', ['Immediately', '30 days', '60 days']).option, '60 days');
t('  → flagged unconfident', sem('45 days', ['Immediately', '30 days', '60 days']).confident, false);
t('no longer option refuses', sem('90 days', ['Immediately', '30 days']), null);
// A number onto banded options — true statements only.
t('3 falls in 3-5 years',  sem('3', ['0-2 years', '3-5 years', '5+ years']).option, '3-5 years');
t('prefers the tighter band', sem('3', ['1-10 years', '3-5 years']).option, '3-5 years');
t('7 falls in 5+',         sem('7', ['0-2 years', '3-5 years', '5+ years']).option, '5+ years');
t('"more than 5" excludes 5', sem('5', ['Less than 5', 'More than 5', '5']).option, '5');
t('0 is none',             sem('0', ['None', '1-3 years']).option, 'None');
t('a number outside every band refuses', sem('12', ['0-2 years', '3-5 years']), null);
// Prose that contains a duration is still read — but reading a sentence is an
// interpretation, so it is never confident.
t('prose is read unconfidently', sem('I have three years', ['0-2 years', '3-5 years']).option, '3-5 years');
t('  → flagged unconfident',     sem('I have three years', ['0-2 years', '3-5 years']).confident, false);
t('a stated length is confident', sem('3 years', ['0-2 years', '3-5 years']).confident, true);
t('framing words stay confident', sem('30 days notice', ['1 month', '3 months']).confident, true);
t('duration is not a salary band', sem('30 days', ['R20 000 - R30 000', 'R30 000 - R40 000']), null);
// Unique containment, the weakest rule.
t('unique phrase match',   sem('Bachelor', ['Bachelor of Science (BSc)', 'Masters', 'PhD']).option, 'Bachelor of Science (BSc)');
t('  → flagged unconfident', sem('Bachelor', ['Bachelor of Science (BSc)', 'Masters', 'PhD']).confident, false);
t('ambiguous phrase refuses', sem('Bachelor', ['Bachelor of Science', 'Bachelor of Arts']), null);

section('resolved values are fitted to the options the form offers');
t('notice period in months',
  (await r('What is your notice period?', { fieldType: 'select', options: ['Immediately', '1 month', '3 months'] })).value, '1 month');
t('  → keeps what the profile said',
  (await r('What is your notice period?', { fieldType: 'select', options: ['Immediately', '1 month', '3 months'] })).rawValue, '30 days');
t('  → still tier profile',
  (await r('What is your notice period?', { fieldType: 'select', options: ['Immediately', '1 month', '3 months'] })).tier, 'profile');
t('confirmed years onto a band',
  (await r('How many years of experience do you have with SQL?', { fieldType: 'select', options: ['0-2 years', '3-5 years', '5+ years'] })).value, '3-5 years');
// A rounded-up notice period is applied, but marked so review sees it.
t('interpreted fit is flagged probable',
  (await r('What is your notice period?', { fieldType: 'select', options: ['Immediately', '60 days', '90 days'] })).probable, true);
// The option list is every claim the form will accept. None of them being true
// is a park, never the nearest string.
t('an answer that fits nothing parks',
  (await r('What is your notice period?', { fieldType: 'select', options: ['Immediately', 'Two weeks'] })).status, 'park');
t('  → park names the tier that answered',
  (await r('What is your notice period?', { fieldType: 'select', options: ['Immediately', 'Two weeks'] })).tier, 'profile-option');
t('gender with no decline option parks rather than pick one',
  (await r('What is your gender?', { fieldType: 'select', options: ['Male', 'Female'] })).status, 'park');

section('compensation — unimportant, so text answers never park');
t('text → negotiable', (await r('What are your salary expectations?')).value, 'Negotiable');
t('hard number parks',  (await r('Expected salary', { fieldType: 'number' })).status, 'park');

section('unset optional profile fields park rather than guess');
t("driver's licence parks", (await r("Do you have a valid driver's licence?", { options: ['Yes', 'No'] })).status, 'park');

section('guardAnswer — the deterministic control on model output');
t('rejects inflated years',
  guardAnswer('How many years of experience with SQL?', '7', ctx).ok, false);
t('accepts profile-matching years',
  guardAnswer('How many years of experience with SQL?', '3', ctx).ok, true);
t('rejects years for unconfirmed skill',
  guardAnswer('How many years of experience with Python?', '3', ctx).ok, false);
t('rejects any model authorisation answer',
  guardAnswer('Are you authorized to work in the US?', 'Yes', ctx).ok, false);
t('rejects unevidenced credential claim',
  guardAnswer('Do you hold an active security clearance?', 'Yes', ctx).ok, false);
t('allows evidenced credential',
  guardAnswer('Do you have a Google Analytics certification?', 'Yes', ctx).ok, true);
// The résumé now counts as evidence — the model may answer from it, so the guard
// must too, but a credential in neither source is still blocked.
t('rejects a credential in neither profile nor résumé',
  guardAnswer('Do you hold an AWS Certified Cloud Practitioner licence?', 'Yes', ctx).ok, false);
t('allows a credential the résumé evidences',
  guardAnswer('Do you hold an AWS Certified Cloud Practitioner licence?', 'Yes',
    { ...ctx, resumeText: 'AWS Certified Cloud Practitioner (2024)' }).ok, true);

section('résumé context — best-effort, never throws');
t('a missing résumé path yields empty text (falls back to the profile)', await resumeText('/no/such/file.pdf'), '');
t('a null path yields empty text', await resumeText(null), '');

section('question normalisation and fuzzy matching');
t('strips required marker + parens',
  normaliseQuestion('How many years of experience with SQL? *(in years)*'), 'how many years of experience with sql');
t('same question, two phrasings match',
  similarity('How many years of experience do you have with SQL?', 'Years of SQL experience?') > 0.5, true);
t('different questions do not match',
  similarity('What is your notice period?', 'How many years of Python experience?') < 0.3, true);

section('answer bank round-trip');
db.exec("DELETE FROM answers WHERE question_raw LIKE 'TEST %'");
saveAnswer({ question: 'TEST what is your favourite colour?', value: 'Blue', source: 'human', humanVerified: 1 });
t('exact hit returns stored value', (await resolveField({ question: 'TEST what is your favourite colour?' }, ctx)).value, 'Blue');
t('tier is bank-exact',             (await resolveField({ question: 'TEST what is your favourite colour?' }, ctx)).tier, 'bank-exact');

// Without this the bank only learns from questions that parked, so review load
// never falls for the ones the model answered plausibly.
section('approving a review teaches the bank');
db.exec("DELETE FROM answers WHERE question_raw LIKE 'TEST %'");
const APPROVED = [
  { question: 'TEST why do you want to work here?', value: 'Because of the adtech work', tier: 'llm', kind: 'input' },
  { question: 'TEST which office would you prefer?', value: 'Cape Town', tier: 'bank-fuzzy', kind: 'select', probable: true },
  { question: 'TEST email address', value: 'k@example.com', tier: 'profile', kind: 'input' },
  { question: 'TEST resume', value: 'cv.pdf', tier: 'resume', kind: 'file' },
  { question: 'TEST phone', value: '+27 82 000 0000', tier: 'prefilled', kind: 'input' },
  { question: 'TEST blank answer', value: '', tier: 'llm', kind: 'input' },
];
t('learns only drafted answers', learnFromApproved(APPROVED), 2);

const stored = q => db.prepare('SELECT * FROM answers WHERE question_norm = ?').get(normaliseQuestion(q));
t('llm answer stored',            stored('TEST why do you want to work here?').answer_value, 'Because of the adtech work');
t('marked llm_approved',          stored('TEST why do you want to work here?').source, 'llm_approved');
t('marked human verified',        stored('TEST why do you want to work here?').human_verified, 1);
t('fuzzy hit promoted to exact',  stored('TEST which office would you prefer?').answer_value, 'Cape Town');
t('field type mapped from kind',  stored('TEST which office would you prefer?').field_type, 'select');
t('profile value not duplicated', stored('TEST email address'), undefined);
t('file upload not an answer',    stored('TEST resume'), undefined);
t('prefilled value not stored',   stored('TEST phone'), undefined);
t('blank value not stored',       stored('TEST blank answer'), undefined);

// The operator typing an answer is a stronger signal than waving one through,
// so approving must not silently overwrite it.
saveAnswer({ question: 'TEST hand typed question', value: 'Correct', source: 'human', humanVerified: 1 });
t('hand-typed answer is not clobbered',
  [learnFromApproved([{ question: 'TEST hand typed question', value: 'Wrong', tier: 'llm', kind: 'input' }]),
   stored('TEST hand typed question').answer_value],
  [0, 'Correct']);

// A learned answer must actually short-circuit the ladder next time.
t('learned answer resolves as bank-exact next time',
  (await resolveField({ question: 'TEST why do you want to work here?' }, ctx)).tier, 'bank-exact');

db.exec("DELETE FROM answers WHERE question_raw LIKE 'TEST %'");

section('parked queue — answering once releases every waiting application');
db.exec("DELETE FROM parked_questions");
db.exec("DELETE FROM jobs WHERE external_id LIKE 'pk-%'");
const ids = ['pk-1', 'pk-2', 'pk-3'].map(ext =>
  upsertJob({ external_id: ext, title: 'Marketing Analyst', company: `Co-${ext}`, location: 'Cape Town' }));
const Q = { questionNorm: normaliseQuestion('How many years of Python?'), question: 'How many years of Python?', reason: 'unconfirmed', tier: 'profile' };
const Q2 = { questionNorm: normaliseQuestion('Do you have a portfolio?'), question: 'Do you have a portfolio?', reason: 'empty', tier: 'profile' };
parkQuestions(ids[0], [Q]);
parkQuestions(ids[1], [Q]);
parkQuestions(ids[2], [Q, Q2]);   // waiting on two

t('3 jobs parked', db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='awaiting_answers' AND external_id LIKE 'pk-%'").get().n, 3);
t('queue groups by question', parkedQueue().find(q => q.question_raw === Q.question).blocking, 3);

const freed = releaseAnswered(Q.questionNorm);
t('releases only fully-unblocked jobs', freed.length, 2);
t('job with a second question stays parked',
  db.prepare('SELECT status FROM jobs WHERE id = ?').get(ids[2]).status, 'awaiting_answers');
releaseAnswered(Q2.questionNorm);
t('answering the second releases it too',
  db.prepare('SELECT status FROM jobs WHERE id = ?').get(ids[2]).status, 'scored');

// The regression that kept LinkedIn Easy Apply at zero. The profile's email is a
// real fact, but LinkedIn offers a select of account-verified addresses only, so
// the profile value cannot be applied. The ladder must go on to the answer bank,
// where a human has already stored the address that IS on the list — before this,
// tier 1 returned its park and tiers 2-3 were never reached.
section('a tier-1 park falls through to the answer bank');
{
  // Two addresses, neither the profile's and neither a relay — genuinely
  // ambiguous, so the profile tier can only park. That park must not end the
  // ladder: a human has already said which one to use.
  const AMBIGUOUS = ['a.person@corp.com', 'b.person@corp.com'];
  const field = { question: 'TEST Email address', fieldType: 'select', options: AMBIGUOUS };

  const before = await resolveField(field, ctx);
  t('parks when nothing else knows', before.status, 'park');
  t('park comes from the profile tier', before.tier, 'profile');

  saveAnswer({
    question: 'TEST Email address', fieldType: 'select',
    value: 'b.person@corp.com', source: 'human', humanVerified: 1,
  });

  const after = await resolveField(field, ctx);
  t('bank answer now wins', after.value, 'b.person@corp.com');
  t('and is credited to the bank', after.tier, 'bank-exact');
  t('and is no longer parked', after.status, 'ok');
}

// A stored answer that also fails the option list must not mask the profile's
// reason — that reason is the one the operator can act on.
section('a bank answer that still does not fit keeps the profile park');
{
  const field = { question: 'TEST Email address', fieldType: 'select', options: ['x@corp.com', 'y@corp.com'] };
  const out = await resolveField(field, ctx);
  t('still parks', out.status, 'park');
  t('reports the profile tier', out.tier, 'profile');
}

// The real LinkedIn shape: the account's verified addresses, one of which is an
// Apple private-relay alias. The relay is never the address to give an employer.
section('email selects are matched on the mailbox, not on string equality');
{
  const em = (opts, profile = P) => matchProfile(profile, { question: 'Email address', options: opts });
  t('same mailbox, different domain',
    em(['k@icloud.com', 'hpmnwp4zwn@privaterelay.appleid.com'])?.value, 'k@icloud.com');
  t('the profile address when it is offered',
    em(['k@example.com', 'other@corp.com'])?.value, 'k@example.com');
  t('the only non-relay option, flagged probable',
    em(['someone@icloud.com', 'hpmnwp4zwn@privaterelay.appleid.com'])?.probable, true);
  t('two real strangers park', !!em(['a@corp.com', 'b@corp.com'])?.park, true);
  t('a free-text email box is untouched',
    matchProfile(P, { question: 'Email address' })?.value, 'k@example.com');
}

// Seen live: LinkedIn labels a country dropdown "Country: Current Location", and
// the city matcher owned "current location" and ran first — so a correct fact
// went into the wrong control, failed the option list, and parked the application.
section('"country" beats "location" when both are in the label');
{
  const loc = q => matchProfile(P, { question: q })?.value;
  t('Country: Current Location', loc('Country: Current Location'), 'South Africa');
  t('plain Country', loc('Country'), 'South Africa');
  t('plain City still works', loc('City'), 'Johannesburg');
  t('Current location is a city', loc('Current location'), 'Johannesburg');
  t('City/Town', loc('City/Town'), 'Johannesburg');
}

section('a country-code select gets the country, never the phone number');
{
  const CODES = ['United Kingdom (+44)', 'South Africa (+27)', 'United States (+1)'];
  t('routes to the country', matchProfile(P, { question: 'Phone country code', options: CODES })?.value, 'South Africa');
  t('which then fits the option',
    matchOption('South Africa', CODES, { semantic: true }).option, 'South Africa (+27)');
  t('a normal phone box still gets the number',
    matchProfile(P, { question: 'Mobile phone number' })?.value, '+27 82 000 0000');
}

section('a years question with yes/no options is a threshold, not a number');
{
  const YN = ['Yes', 'No'];
  t('3 years does not meet 4-5',
    matchProfile(P, { question: 'Do you have 4–5 years of experience in digital marketing?', options: YN })?.value, 'No');
  t('3 years meets "at least 2 years"',
    matchProfile(P, { question: 'Do you have at least 2 years of experience?', options: YN })?.value, 'Yes');
  t('an unconfirmed technology is a plain no',
    matchProfile(P, { question: 'Do you have 2 years of experience with Kubernetes?', options: YN })?.value, 'No');
  t('no threshold to test parks',
    !!matchProfile(P, { question: 'How many years of experience do you have?', options: YN })?.park, true);
}

section('generic qualifiers are not skills');
{
  t('relevant full-time', extractSkill('How many years of relevant full-time experience do you have? (Excluding internship)'), null);
  t('professional', extractSkill('How many years of professional experience do you have?'), null);
  t('a real technology survives', extractSkill('How many years of experience do you have with SQL?'), 'SQL');
  // Routed to the confirmed total instead of parking on a junk noun.
  t('answers from the total',
    matchProfile(P, { question: 'How many years of relevant full-time experience do you have?' })?.value, '3');
}

section('"Enter your ..." reaches the same matcher as "..."');
{
  t('first name', matchProfile(P, { question: 'Enter your first name' })?.value, 'Khosi');
  t('last name', matchProfile(P, { question: 'Please enter your last name' })?.value, 'Siphugu');
  t('email', matchProfile(P, { question: 'Enter your email address' })?.value, 'k@example.com');
  t('stripImperative is conservative', stripImperative('Interesting facts about you'), 'Interesting facts about you');
}

section('a question we could not read is never answered');
{
  const u = f => unreadableQuestion(f);
  t('empty label', !!u({ question: '', options: ['Yes', 'No'] }), true);
  t('label is its own option', !!u({ question: 'Yes', options: ['Yes', 'No'] }), true);
  t('two-character label', !!u({ question: 'Do', options: [] }), true);
  t('a real question is fine', u({ question: 'Do you agree to the terms?', options: ['Yes', 'No'] }), null);
  // And the ladder must refuse it outright, not hand it to the model.
  const out = await resolveField({ question: 'Yes', fieldType: 'checkbox', options: ['Yes', 'No'] }, ctx);
  t('parks at tier unreadable', out.tier, 'unreadable');
}

section('scoring heuristic');

// ATS copy is typed in word processors, so a straight-apostrophe pattern misses
// the real question. This one silently sent a licence question to the model, which
// is forbidden from asserting a credential and so declined it.
section('curly punctuation does not defeat the matchers');
{
  const P2 = { ...P, misc: { ...P.misc, hasDriversLicense: true, startAvailability: '' } };
  const c2 = { ...ctx, profile: P2 };
  const straight = matchProfile(P2, { question: "Do you have a valid driver's licence?", options: ['Yes', 'No'] });
  const curly = matchProfile(P2, { question: 'Do you have a valid driver’s licence?', options: ['Yes', 'No'] });
  t('straight apostrophe matches', straight?.value, 'Yes');
  t('curly apostrophe matches too', curly?.value, 'Yes');
  t('en-dash folded', normalisePunctuation('4–5 years'), '4-5 years');
}

section('salary — a numeric control needs a number, not "Negotiable"');
{
  const withFigure = { ...P, compensation: { fallbackText: 'Negotiable', expectedAnnual: 480000 } };
  t('text control still gets the phrase',
    matchProfile(withFigure, { question: 'Expected salary', fieldType: 'text' })?.value, 'Negotiable');
  t('numeric control gets the figure',
    matchProfile(withFigure, { question: 'Expected salary', fieldType: 'number' })?.value, '480000');
  t('and parks when no figure is on file',
    !!matchProfile(P, { question: 'Expected salary', fieldType: 'number' })?.park, true);
}

// The phrasings real forms use. "When are you available to start?" parked on a
// live application because the pattern only had "availability to start".
section('availability phrasings all reach the notice period');
{
  const asked = [
    'What is your notice period?',
    'When can you start?',
    'When are you available to start?',
    'When would you be available to commence?',
    'Earliest possible start date',
    'Availability to start',
  ];
  for (const q of asked) t(q, matchProfile(P, { question: q })?.value, '30 days');

  // Deliberately still a bare duration, because that is what fits a dropdown.
  t('fits a duration dropdown',
    matchOption('30 days', ['Immediately', 'Less than 2 weeks', '1 month'], { semantic: true }).option, '1 month');
}

// The single largest leak in the pipeline: twelve substrings against the title
// alone rejected 1188 of 2305 jobs with no model ever looking at them.
section('the role-family gate reads the description, not just the title');
{
  const h = (title, jd_text = '') => heuristicScore({ title, jd_text }, P);
  t('an on-target title still passes', h('Marketing Analyst').titleRelevant, true);
  // Titles the old twelve-term list threw away, every one of them real.
  for (const title of ['Google Ads Manager', 'Amazon PPC Manager', 'Junior Media Buyer',
                       'CRM Manager', 'SEO Manager', 'User Acquisition Specialist',
                       'Business Intelligence Engineer']) {
    t(title, h(title).titleRelevant, true);
  }
  // A title that says nothing, over a description that names the candidate's own
  // skills. Deliberately NOT "the description mentions a family term" — that let
  // 956 of 1187 gated jobs through, because "data" appears in almost any posting.
  const RICH = { ...P, skills: {
    SQL: { confirmed: true }, 'Power BI': { confirmed: true },
    GA4: { confirmed: true }, Tableau: { confirmed: true }, ETL: { confirmed: true },
  } };
  const rich = (title, jd_text) => heuristicScore({ title, jd_text }, RICH);
  const body = rich('Specialist, Commercial',
    'You will own SQL reporting, build Power BI and Tableau dashboards, own GA4 and maintain ETL jobs.');
  t('rescued by the description', body.titleRelevant, true);
  t('and it says which carried it', body.matchedOn, 'description');
  t('one passing mention is not enough',
    rich('Operations Coordinator', 'Some SQL exposure is a bonus.').titleRelevant, false);

  // Short skills used to match inside longer words — "ml" in html, "cro" in
  // microsoft, "git" in logistics — which is how an Executive Assistant posting
  // scored four skill hits and `worthScoring` stopped being a gate at all.
  const PS = { ...P, skills: { ML: { confirmed: true }, CRO: { confirmed: true }, Git: { confirmed: true } } };
  t('no fragment matches inside other words',
    heuristicScore({ title: 'Web Designer', jd_text: 'Build HTML across Microsoft logistics tooling.' }, PS).matchedSkills,
    []);
  t('but a real mention still counts',
    heuristicScore({ title: 'Web Designer', jd_text: 'You will use Git daily.' }, PS).matchedSkills,
    ['git']);
  t('a title match is credited to the title', h('Marketing Analyst').matchedOn, 'title');
  // Word boundaries: "data" used to match Metadata.
  t('Metadata Librarian is not a data role', h('Metadata Librarian').titleRelevant, false);
  t('genuinely off-target still gated', h('Chef de Partie', 'Kitchen work').titleRelevant, false);
}

section('blockers are validated before they can reject anything');
{
  t('an empty array is empty', normaliseBlockers([]), []);
  t('"None" is not a blocker', normaliseBlockers(['None']), []);
  t('nor is "N/A"', normaliseBlockers([{ kind: 'auth', why: 'N/A' }]), []);
  t('a bare string is kept, untyped',
    normaliseBlockers(['Requires US clearance']), [{ kind: 'unknown', why: 'Requires US clearance' }]);
  t('a typed blocker survives',
    normaliseBlockers([{ kind: 'auth', why: 'US work authorisation required' }]),
    [{ kind: 'auth', why: 'US work authorisation required' }]);
  t('kind is normalised', normaliseBlockers([{ kind: 'LOCATION', why: 'On-site in Pretoria' }])[0].kind, 'location');
}

section('scoring heuristic');
const hs = heuristicScore({ title: 'Marketing Data Analyst', jd_text: 'You will use SQL and Power BI daily.' }, P);
t('matches confirmed skills only', hs.matchedSkills.sort(), ['power bi', 'sql']);
t('title relevance', hs.titleRelevant, true);
t('worth an LLM call', hs.worthScoring, true);
t('irrelevant title gated out', heuristicScore({ title: 'Chef de Partie', jd_text: 'Kitchen work' }, P).worthScoring, false);

// cleanup
db.exec("DELETE FROM jobs WHERE external_id LIKE 'pk-%'");
db.exec("DELETE FROM answers WHERE question_raw LIKE 'TEST %'");
db.exec("DELETE FROM parked_questions");

// LinkedIn holds the iCloud address and offers only what it has verified, so an
// Easy Apply must carry that one. Everywhere else the Gmail address goes,
// because that is the mailbox the reply-watcher reads — an external application
// carrying the iCloud address gets a reply nothing is watching, and reads as one
// that was never followed up.
section('the email address follows the channel');
{
  const twoInbox = {
    ...P,
    identity: { ...P.identity, email: 'monitored@gmail.com', linkedinEmail: 'other@icloud.com' },
  };
  t('easy apply carries the LinkedIn address',
    channelEmail(twoInbox, { ats: 'linkedin' }), 'other@icloud.com');
  t('an external ATS carries the monitored one',
    channelEmail(twoInbox, { ats: 'greenhouse' }), 'monitored@gmail.com');
  t('so does email outreach', channelEmail(twoInbox, {}), 'monitored@gmail.com');
  // Without a LinkedIn address configured there is only one answer anywhere.
  t('one address means one answer',
    channelEmail(P, { ats: 'linkedin' }), P.identity.email);
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
