/**
 * Re-route the applications that were held in Review by two defects.
 *
 * The fixes in f472c40 stop new ones; they do nothing for the jobs already
 * sitting in the queue, because a job's status was written at the time it was
 * held and nothing re-derives it. This is the one-off that moves them.
 *
 *   follow-checkbox   → tailored. These were held because the record said the
 *                       candidate was granting a subscription, on a box that had
 *                       already been unticked. There was never anything wrong
 *                       with the application, so it goes back in the queue.
 *
 *   not-an-application → manual_required. Terminal. No approval turns a
 *                       job-search page into an application form, and approving
 *                       one was the route past the check that caught it.
 *
 *   review-mode        → tailored. Held while the mode was `review`; the mode is
 *                       `auto` now, so the reason has expired.
 *
 * A genuine pre-send objection is NOT touched. Those are the check working —
 * refusing to claim TensorFlow experience the profile does not support — and
 * clearing them would be overriding a safety decision nobody has reviewed.
 *
 * Run with --apply to write; prints what it would do otherwise.
 */
import { db, updateJob } from '../src/db.js';
import { emit } from '../src/bus.js';
import { holdKind } from '../src/apply/review.js';

const APPLY = process.argv.includes('--apply');

const held = db.prepare(`
  SELECT j.id, j.title, j.company, j.apply_type, j.apply_attempts,
         a.outcome_note AS note
  FROM jobs j
  LEFT JOIN applications a ON a.id = (SELECT MAX(id) FROM applications WHERE job_id = j.id)
  WHERE j.status = 'awaiting_review'
  ORDER BY j.id`).all();

// What each hold kind becomes. Anything not listed is deliberately left alone.
const ROUTES = {
  'preflight': null,                    // decided per-job below — only the follow-box ones move
  'not-an-application': { status: 'manual_required', keepReason: true },
  'review-mode': { status: 'tailored', keepReason: false },
};

const FOLLOW_BOX = /\bfollow\b.{0,80}\bto stay up to date\b/i;

const plan = [];
for (const j of held) {
  const kind = holdKind(j.note || '');

  // The follow-checkbox holds are preflight holds — the check fired correctly on
  // a bad record. They are told apart from real objections by what was objected
  // to, which is the only thing that distinguishes them.
  if (kind === 'preflight' && FOLLOW_BOX.test(j.note || '')) {
    plan.push({ ...j, kind: 'follow-checkbox', to: 'tailored', reason: null });
    continue;
  }
  const route = ROUTES[kind];
  if (!route) { plan.push({ ...j, kind, to: null }); continue; }
  plan.push({ ...j, kind, to: route.status, reason: route.keepReason ? j.note : null });
}

const moving = plan.filter(p => p.to);
const staying = plan.filter(p => !p.to);

console.log(`\n${held.length} job(s) in Review\n`);
for (const p of moving) {
  console.log(`  → ${p.to.padEnd(16)} #${String(p.id).padEnd(5)} [${p.kind}] ${String(p.title).slice(0, 44)}`);
}
console.log(`\n${staying.length} left alone (the pre-send check working, or an agent fill a person should confirm):`);
for (const p of staying) {
  console.log(`  · keep in Review  #${String(p.id).padEnd(5)} [${p.kind}] ${String(p.title).slice(0, 44)}`);
}

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to write.\n');
  process.exit(0);
}

const run = db.transaction(rows => {
  for (const p of rows) {
    updateJob(p.id, {
      status: p.to,
      reject_reason: p.reason ? String(p.reason).slice(0, 200) : null,
      // The attempts were spent proving a bug, not proving anything about the
      // posting. Refunded so a re-queued job gets its full retry budget.
      ...(p.to === 'tailored' ? { apply_attempts: 0 } : {}),
    });
  }
});
run(moving);

const byKind = {};
for (const p of moving) byKind[p.kind] = (byKind[p.kind] || 0) + 1;

emit({
  stage: 'review', component: 'review/backfill', level: 'warn',
  message: `Cleared ${moving.length} job(s) held in Review by two fixed defects — `
    + Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ')
    + `; ${staying.length} genuine hold(s) left for a person.`,
  data: {
    moved: moving.map(p => ({ id: p.id, kind: p.kind, to: p.to })),
    kept: staying.map(p => ({ id: p.id, kind: p.kind })),
  },
});

console.log(`\n✓ ${moving.length} moved, ${staying.length} kept.\n`);
