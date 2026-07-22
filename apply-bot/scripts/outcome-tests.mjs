// Phase 8 §8.2 tests — outcome capture.
//
// This is the layer everything else in phase 8 rests on: if outcomes are not
// recorded honestly, the calibration report is confidently wrong rather than
// merely empty. The cases that matter are the ones about what is *excluded* —
// an unlabelled application must never be silently dropped from a rate.
import {
  db, upsertJob, setOutcome, pendingOutcomes, autoTimeoutOutcomes, outcomeSummary,
  recordEmailApplication, OUTCOME_STATES, RESPONSE_STATES, OUTCOME_TIMEOUT_DAYS,
} from '../src/db.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const section = s => console.log(`\n${s}`);

const DAY = 864e5;
const daysAgo = n => new Date(Date.now() - n * DAY).toISOString();

db.exec("DELETE FROM applications WHERE job_id IN (SELECT id FROM jobs WHERE external_id LIKE 'oc-%')");
db.exec("DELETE FROM jobs WHERE external_id LIKE 'oc-%'");

/** A submitted application `age` days old, optionally already labelled. */
function sent({ ext, fit = 70, channel = 'linkedin_easy', age = 10, state = null, note = null }) {
  const jobId = upsertJob({ external_id: ext, title: 'Marketing Analyst', company: `Co ${ext}` });
  db.prepare('UPDATE jobs SET fit_score = ?, status = ? WHERE id = ?').run(fit, 'submitted', jobId);
  const info = db.prepare(`
    INSERT INTO applications (job_id, channel, submitted_at, outcome, outcome_state, outcome_note)
    VALUES (?, ?, ?, 'submitted', ?, ?)`).run(jobId, channel, daysAgo(age), state, note);
  return info.lastInsertRowid;
}

section('the ordinal scale');
t('states in order', OUTCOME_STATES, ['no_response', 'rejected', 'screen', 'interview', 'offer']);
// A rejection means a human read it. Silence means nobody did. Treating them the
// same throws away the difference the whole report depends on.
t('a rejection counts as a response', RESPONSE_STATES.includes('rejected'), true);
t('silence does not', RESPONSE_STATES.includes('no_response'), false);

section('setOutcome');
const a1 = sent({ ext: 'oc-1', age: 10 });
t('accepts a valid state', setOutcome(a1, { state: 'interview' }), true);
const row1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(a1);
t('records the state', row1.outcome_state, 'interview');
t('defaults to a manual source', row1.outcome_source, 'manual');
t('stamps a time', !!row1.outcome_at, true);
t('rejects a state off the scale',
  (() => { try { setOutcome(a1, { state: 'ghosted' }); return 'no throw'; } catch (e) { return /one of/.test(e.message); } })(), true);
t('unknown application id is not a silent success', setOutcome(99999, { state: 'rejected' }), false);

section('pendingOutcomes — only what the operator can usefully answer');
db.exec("DELETE FROM applications WHERE job_id IN (SELECT id FROM jobs WHERE external_id LIKE 'oc-%')");
sent({ ext: 'oc-2', age: 30 });                       // stale, unlabelled
sent({ ext: 'oc-3', age: 12 });                       // unlabelled
sent({ ext: 'oc-4', age: 2 });                        // too fresh to ask about
sent({ ext: 'oc-5', age: 20, state: 'rejected' });    // already answered
const pend = pendingOutcomes();
t('excludes the too-fresh and the already-labelled', pend.length, 2);
t('oldest first', pend[0].age_days > pend[1].age_days, true);
t('carries an age', pend[0].age_days >= 29, true);
t('carries the fit score, which is the point', pend[0].fit_score, 70);
t('carries title and company', [!!pend[0].title, !!pend[0].company], [true, true]);

section('autoTimeoutOutcomes — an absence of a reply is data');
db.exec("DELETE FROM applications WHERE job_id IN (SELECT id FROM jobs WHERE external_id LIKE 'oc-%')");
const old1 = sent({ ext: 'oc-6', age: OUTCOME_TIMEOUT_DAYS + 5 });
const old2 = sent({ ext: 'oc-7', age: OUTCOME_TIMEOUT_DAYS + 1 });
const young = sent({ ext: 'oc-8', age: OUTCOME_TIMEOUT_DAYS - 1 });
const labelled = sent({ ext: 'oc-9', age: OUTCOME_TIMEOUT_DAYS + 30, state: 'interview' });

t('marks only the timed-out', autoTimeoutOutcomes(), 2);
const st = id => db.prepare('SELECT outcome_state, outcome_source FROM applications WHERE id = ?').get(id);
t('oldest marked no_response', st(old1), { outcome_state: 'no_response', outcome_source: 'timeout' });
t('second marked too', st(old2).outcome_state, 'no_response');
t('one day short is left alone', st(young).outcome_state, null);
t('an existing verdict is not overwritten', st(labelled).outcome_state, 'interview');
t('running it again marks nothing', autoTimeoutOutcomes(), 0);

section('outcomeSummary — awaiting is reported, not hidden');
db.exec("DELETE FROM applications WHERE job_id IN (SELECT id FROM jobs WHERE external_id LIKE 'oc-%')");
sent({ ext: 'oc-10', age: 10, state: 'no_response' });
sent({ ext: 'oc-11', age: 10, state: 'rejected' });
sent({ ext: 'oc-12', age: 10, state: 'interview' });
sent({ ext: 'oc-13', age: 10 });                                        // unlabelled
sent({ ext: 'oc-14', age: 10, state: 'rejected', note: 'audit sample' }); // counted apart
const sum = outcomeSummary();
t('counts every submitted application', sum.submitted, 5);
t('counts the labelled', sum.labelled, 4);
t('counts responses, silence excluded', sum.responses, 3);
t('reports what is still awaiting a verdict', sum.awaiting, 1);
t('audit-sample rows are counted separately', sum.audit, 1);

section('the email channel gets an application row like every other channel');
db.exec("DELETE FROM applications WHERE job_id IN (SELECT id FROM jobs WHERE external_id LIKE 'oc-%')");
const emailJob = upsertJob({ external_id: 'oc-15', title: 'Growth Analyst', company: 'Mailer Co' });
db.prepare("UPDATE jobs SET fit_score = 80, status = 'submitted' WHERE id = ?").run(emailJob);
const eid = recordEmailApplication({ jobId: emailJob, resumePath: '/tmp/cv.pdf', to: 'jobs@mailer.co', outboxId: 7 });
const erow = db.prepare('SELECT * FROM applications WHERE id = ?').get(eid);
t('channel is email', erow.channel, 'email');
t('counts as submitted', erow.outcome, 'submitted');
t('has a submitted_at, so it can age', !!erow.submitted_at, true);
t('evidence names the recipient', /jobs@mailer\.co/.test(erow.confirmation_evidence), true);
// Without this row the email channel is invisible to the calibration report,
// and it is the channel most likely to behave differently from the rest.
t('email applications reach outcome capture', setOutcome(eid, { state: 'screen', source: 'email' }), true);

db.exec("DELETE FROM applications WHERE job_id IN (SELECT id FROM jobs WHERE external_id LIKE 'oc-%')");
db.exec("DELETE FROM jobs WHERE external_id LIKE 'oc-%'");

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
