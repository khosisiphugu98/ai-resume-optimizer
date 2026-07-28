/**
 * Read the instructions out of every job description already on file.
 *
 * The extraction pass runs at enrich time, and enrichment never runs twice on
 * the same posting — so without this the 2465 descriptions already stored would
 * keep the classification they were given by the old rules. Of the 50 that name
 * an address to apply to, 11 were routed somewhere other than the email channel,
 * including `careers@pineapple.co.za` for an Actuarial and Data Analyst.
 *
 * Two deliberate limits on what this will touch:
 *
 *   - `jd_instructions` is written for every posting. It is a new column that
 *     nothing has ever depended on, so filling it in cannot change a decision
 *     that has already been made.
 *   - `apply_type` is corrected only for postings nothing has applied to. A job
 *     that has been submitted, queued in the outbox or approved by a person has
 *     a route that already produced a real action, and rewriting that would make
 *     the record disagree with what happened.
 *
 * Dry by default. Pass --write to commit.
 */
import { db } from '../src/db.js';
import { extractInstructions, hasInstructions } from '../src/discover/jd-instructions.js';

const write = process.argv.includes('--write');

// States where the route has already been acted on, or is about to be.
const SETTLED = new Set(['submitted', 'outbox', 'approved', 'awaiting_review', 'manual_required']);

const rows = db.prepare(
  `SELECT id, title, company, status, apply_type, jd_text FROM jobs WHERE jd_text IS NOT NULL`).all();

const setInstructions = db.prepare('UPDATE jobs SET jd_instructions = ? WHERE id = ?');
const setRoute = db.prepare('UPDATE jobs SET jd_instructions = ?, apply_type = ?, apply_email = ? WHERE id = ?');

let stored = 0;
const reroutes = [];
const skipped = [];

const apply = db.transaction(() => {
  for (const job of rows) {
    const instructions = extractInstructions(job.jd_text);
    const json = hasInstructions(instructions) ? JSON.stringify(instructions) : null;
    if (json) stored++;

    const misrouted = instructions.applyEmail && job.apply_type !== 'email';
    if (misrouted && SETTLED.has(job.status)) {
      skipped.push(job);
      if (write && json) setInstructions.run(json, job.id);
      continue;
    }

    if (misrouted) {
      reroutes.push({ ...job, to: instructions.applyEmail });
      if (write) setRoute.run(json, 'email', instructions.applyEmail, job.id);
      continue;
    }

    if (write && json) setInstructions.run(json, job.id);
  }
});

apply();

console.log(`\n  ${rows.length} description(s) read`);
console.log(`  ${stored} carry an instruction worth storing`);
console.log(`  ${reroutes.length} misrouted posting(s) corrected to the email channel:`);
for (const r of reroutes) {
  console.log(`     #${String(r.id).padEnd(5)} ${r.apply_type.padEnd(11)} → email   ${r.to.padEnd(34)} ${r.title} @ ${r.company}`);
}
if (skipped.length) {
  console.log(`\n  ${skipped.length} left alone — already acted on:`);
  for (const s of skipped) console.log(`     #${s.id} (${s.status}) ${s.title} @ ${s.company}`);
}
console.log(write ? '\n  Written.\n' : '\n  Dry run — pass --write to commit.\n');
