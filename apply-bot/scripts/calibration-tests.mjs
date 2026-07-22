// Phase 8 §8.3–8.7 tests — calibration.
//
// The risk this file guards against is not a crash, it is a plausible-looking
// number. A response rate from three applications, a threshold sweep that cannot
// see false negatives, a bucket showing 0% because nobody has replied yet — each
// of those reads as a finding and none of them is one. So most of what is
// asserted here is about *refusing* to report: suppression, the minimum sample,
// and the censoring warning.
import { db, upsertJob, setOutcome, bumpRate } from '../src/db.js';
import {
  wilson, calibrationReport, thresholdSweep, labelledApplications, buildFewShot,
} from '../src/score/calibrate.js';
import {
  currentThreshold, setThreshold, shouldAuditSample, fewShotBlock, AUDIT, THRESHOLD,
} from '../src/score/index.js';
import { setSetting } from '../src/db.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const section = s => console.log(`\n${s}`);
const round = (x, d = 3) => x == null ? null : Number(x.toFixed(d));

const DAY = 864e5;
const daysAgo = n => new Date(Date.now() - n * DAY).toISOString();

const reset = () => {
  db.exec("DELETE FROM applications WHERE job_id IN (SELECT id FROM jobs WHERE external_id LIKE 'cal-%')");
  db.exec("DELETE FROM parked_questions WHERE job_id IN (SELECT id FROM jobs WHERE external_id LIKE 'cal-%')");
  db.exec("DELETE FROM jobs WHERE external_id LIKE 'cal-%'");
};

let seq = 0;
/** One submitted, labelled application. */
function app({ fit, state, channel = 'linkedin_easy', tier = 'A', vendor = null,
               search = 'Marketing Analyst', note = null, age = 20, respondedAfter = null }) {
  const ext = `cal-${++seq}`;
  const jobId = upsertJob({ external_id: ext, title: `Role ${seq}`, company: `Co ${seq}`, tier, search_keywords: search });
  db.prepare('UPDATE jobs SET fit_score = ?, status = ? WHERE id = ?').run(fit, 'submitted', jobId);
  const info = db.prepare(`
    INSERT INTO applications (job_id, channel, ats_vendor, submitted_at, outcome, outcome_state,
                              outcome_at, outcome_source, outcome_note)
    VALUES (?, ?, ?, ?, 'submitted', ?, ?, 'manual', ?)`).run(
    jobId, channel, vendor, daysAgo(age), state,
    respondedAfter == null ? null : daysAgo(age - respondedAfter), note);
  return info.lastInsertRowid;
}

reset();

// ---------------------------------------------------------------------------
section('Wilson interval');
// The known value from the spec. The normal approximation gives a lower bound
// below zero here, which is why it is not used.
const w = wilson(1, 10);
t('n=10 k=1 lands in the documented range', [round(w.low), round(w.high)], [0.018, 0.404]);
t('the point estimate is still the raw proportion', round(w.rate), 0.1);
t('zero successes still has a real upper bound', round(wilson(0, 10).high) > 0.25, true);
t('the interval narrows as n grows', wilson(10, 100).high - wilson(10, 100).low < w.high - w.low, true);
t('an empty sample reports no rate at all', wilson(0, 0).rate, null);
t('bounds never leave [0,1]', [wilson(0, 3).low, wilson(3, 3).high], [0, 1]);

// ---------------------------------------------------------------------------
section('buckets below the minimum are suppressed, not shown as 0%');
reset(); seq = 0;
// One bucket with enough to report, one deliberately short.
for (let i = 0; i < 10; i++) app({ fit: 72, state: i < 2 ? 'interview' : 'no_response' });
for (let i = 0; i < 3; i++) app({ fit: 45, state: 'no_response' });

const r1 = calibrationReport({ minSample: 8, minTotal: 40 });
const bucket = k => r1.buckets.find(b => b.key === k);
t('the well-populated bucket reports a rate', round(bucket(70).rate), 0.2);
t('it carries an interval', bucket(70).low < 0.2 && bucket(70).high > 0.2, true);
// Three applications and no replies is not a 0% response rate, it is no
// information — and displayed as "0%" it reads like the strongest finding here.
t('the thin bucket is suppressed', bucket(40).suppressed, true);
t('and reports no rate', bucket(40).rate, null);
t('but still shows its count, so it is visibly there', bucket(40).n, 3);

// ---------------------------------------------------------------------------
section('the report refuses to draw conclusions from too little data');
t('13 labelled is not enough', r1.ready, false);
t('and it says so in words', /Not enough data yet/.test(r1.verdict), true);
t('naming the target', /of 40/.test(r1.verdict), true);
t('the headline rate is still computed honestly', [r1.labelled, r1.responses], [13, 2]);

reset(); seq = 0;
const empty = calibrationReport();
t('with nothing labelled it says that plainly', /No labelled outcomes yet/.test(empty.verdict), true);
t('and reports zero rather than dividing by it', empty.headline.rate, null);

// ---------------------------------------------------------------------------
section('threshold sweep counts false negatives');
reset(); seq = 0;
const rows = [
  { fit: 80, state: 'interview' },    // responds, above every candidate threshold
  { fit: 75, state: 'no_response' },
  { fit: 70, state: 'rejected' },     // a human read it — counts as a response
  { fit: 62, state: 'interview' },    // responds *below* 65: the expensive miss
  { fit: 55, state: 'no_response' },
  { fit: 48, state: 'screen' },       // another miss above threshold 50
];
for (const r of rows) app(r);

const sweep = thresholdSweep(labelledApplications());
const at = th => sweep.find(s => s.threshold === th);
t('at 45 everything is sent', at(45).sent, 6);
t('and nothing is missed', at(45).missed, 0);
t('at 65 two responders fall below the line', at(65).missed, 2);
t('leaving three sent', at(65).sent, 3);
t('and two captured', at(65).captured, 2);
t('at 80 only one is sent', at(80).sent, 1);
t('and three responders are missed', at(80).missed, 3);
// A rejection means a human opened it. Counting that as no response would make
// silence and engagement look identical, which is the whole distinction.
t('a rejection counts toward captured at 70', at(70).captured, 2);

// ---------------------------------------------------------------------------
section('audit samples are held out of the headline and reported apart');
reset(); seq = 0;
for (let i = 0; i < 10; i++) app({ fit: 80, state: i < 3 ? 'interview' : 'no_response' });
for (let i = 0; i < 4; i++) app({ fit: 50, state: i < 2 ? 'screen' : 'no_response', note: 'audit sample' });

const r2 = calibrationReport({ minSample: 8, minTotal: 10 });
t('the headline excludes audit samples', r2.labelled, 10);
t('so the headline rate is not dragged down by them', round(r2.headline.rate), 0.3);
t('audit samples are counted separately', r2.audit.n, 4);
t('with their own rate', round(r2.audit.rate), 0.5);
t('the sweep includes them, which is the point of collecting them',
  thresholdSweep(labelledApplications()).find(s => s.threshold === 65).missed, 2);
t('and the censoring warning clears once they exist', r2.sweepCensored, false);

reset(); seq = 0;
for (let i = 0; i < 9; i++) app({ fit: 80, state: 'no_response' });
t('with no audit samples the sweep is flagged as censored',
  calibrationReport().sweepCensored, true);

// ---------------------------------------------------------------------------
section('breakdowns');
reset(); seq = 0;
for (let i = 0; i < 9; i++) app({ fit: 70, state: i < 1 ? 'rejected' : 'no_response', channel: 'linkedin_easy' });
for (let i = 0; i < 9; i++) app({ fit: 70, state: i < 4 ? 'interview' : 'no_response', channel: 'email' });
for (let i = 0; i < 2; i++) app({ fit: 70, state: 'interview', channel: 'external_ats' });

const r3 = calibrationReport({ minSample: 8, minTotal: 10 });
const chan = k => r3.byChannel.find(c => c.key === k);
t('email and easy apply both reported', [chan('email').n, chan('linkedin_easy').n], [9, 9]);
t('with different rates', [round(chan('email').rate), round(chan('linkedin_easy').rate)], [0.444, 0.111]);
t('the two-application channel is suppressed', chan('external_ats').suppressed, true);
t('channels are ordered by volume', r3.byChannel[0].n >= r3.byChannel.at(-1).n, true);

// ---------------------------------------------------------------------------
section('the threshold lives in settings, not in the source');
t('defaults to the code constant', (setSetting('fit_threshold', ''), currentThreshold()), THRESHOLD);
t('a stored value wins', setThreshold(72), 72);
t('and is what runScoring would read', currentThreshold(), 72);
t('nonsense is refused',
  (() => { try { setThreshold(140); return 'no throw'; } catch (e) { return /between 0 and 100/.test(e.message); } })(), true);
t('a blank setting falls back rather than scoring everything as zero',
  (setSetting('fit_threshold', 'not a number'), currentThreshold()), THRESHOLD);
setThreshold(THRESHOLD);

// ---------------------------------------------------------------------------
section('audit sampling fires at roughly the configured rate');
db.prepare('DELETE FROM rate_ledger').run();
let fired = 0;
const trials = 1000;
for (let i = 0; i < trials; i++) {
  // Cap check reads the ledger, so keep it clear to measure the rate itself.
  db.prepare('DELETE FROM rate_ledger').run();
  if (shouldAuditSample(55, 65, Math.random)) fired++;
}
t(`fires near ${AUDIT.rate * 100}% over ${trials} draws`,
  fired / trials > 0.03 && fired / trials < 0.07, true);

const always = () => 0;   // always under the rate
t('never samples a job below the floor score', shouldAuditSample(AUDIT.floor - 1, 65, always), false);
t('samples one at the floor', shouldAuditSample(AUDIT.floor, 65, always), true);
// A job that already cleared the threshold is being applied to anyway — sampling
// it would double-count it and mislabel it as below-threshold evidence.
t('never samples a job at or above the threshold', shouldAuditSample(65, 65, always), false);
t('never samples one comfortably above it', shouldAuditSample(90, 65, always), false);

db.prepare('DELETE FROM rate_ledger').run();
t('respects the daily cap',
  (() => {
    const got = [];
    for (let i = 0; i < 5; i++) {
      const hit = shouldAuditSample(55, 65, always);
      got.push(hit);
      if (hit) bumpRate('audit_samples');
    }
    return got;
  })(),
  [true, true, false, false, false]);
db.prepare('DELETE FROM rate_ledger').run();

// ---------------------------------------------------------------------------
section('few-shot examples come from real outcomes');
reset(); seq = 0;
setSetting('score_examples', '');
t('no examples means no block in the prompt', fewShotBlock(), '');

for (let i = 0; i < 8; i++) app({ fit: 80, state: 'interview' });
for (let i = 0; i < 14; i++) app({ fit: 70, state: 'no_response' });
const few = buildFewShot({ perClass: 3, minTotal: 20 });
t('built once there are enough outcomes', few.examples.length, 6);
t('with both classes represented',
  [few.examples.filter(e => /response/.test(e.label)).length,
   few.examples.filter(e => /nothing/.test(e.label)).length], [3, 3]);

setSetting('score_examples', JSON.stringify(few));
const block = fewShotBlock();
t('the block reaches the prompt', /HOW PAST APPLICATIONS ACTUALLY WENT/.test(block), true);
t('and names a real posting', /Role 1 at Co 1/.test(block), true);
// A malformed setting must not take the scorer down with it.
setSetting('score_examples', '{ not json');
t('a corrupt setting degrades to no examples', fewShotBlock(), '');
setSetting('score_examples', '');

reset(); seq = 0;
for (let i = 0; i < 5; i++) app({ fit: 80, state: 'interview' });
t('below the minimum it declines to build any', buildFewShot({ minTotal: 20 }), null);

reset();
db.exec("DELETE FROM settings WHERE key IN ('fit_threshold','score_examples')");

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
