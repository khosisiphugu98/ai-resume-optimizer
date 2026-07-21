// Phase 2 tests. The important ones are the anti-fabrication guarantees: these
// answers go on real employment applications, so a wrong one has consequences
// beyond a failing build. No network.
import { resolveField, guardAnswer } from '../src/answer/resolver.js';
import { extractSkill, matchProfile } from '../src/answer/matchers.js';
import { normaliseQuestion, similarity, saveAnswer } from '../src/answer/bank.js';
import { skillYears } from '../src/profile.js';
import { db, parkQuestions, parkedQueue, releaseAnswered, upsertJob, updateJob } from '../src/db.js';
import { heuristicScore } from '../src/score/index.js';

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

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
