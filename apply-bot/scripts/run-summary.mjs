/**
 * Read-only summary of a supervised live run.
 *
 * Usage: node scripts/run-summary.mjs '2026-07-27T06:00'
 * Prints per-attempt outcomes, field-fill coverage and park causes since a cutoff.
 */
import Database from 'better-sqlite3';

const since = process.argv[2] || '2026-07-27T06:00';
const D = new Database('data/pipeline.sqlite', { readonly: true });

console.log(`\n===== LIVE RUN SUMMARY since ${since} =====\n`);

console.log('--- apply attempts (in order) ---');
const applying = D.prepare(
  `SELECT ts, job_id, message FROM events
   WHERE ts > ? AND stage IN ('apply','email') AND message NOT LIKE 'Waiting%'
     AND message NOT LIKE 'Started:%' AND message NOT LIKE 'Finished:%'
   ORDER BY id`).all(since);
for (const e of applying) {
  console.log(`  ${e.ts.slice(11, 19)} job${String(e.job_id || '-').padEnd(5)} ${e.message.replace(/\n/g, ' ').slice(0, 155)}`);
}

console.log('\n--- outcome tally for jobs touched in this window ---');
const tally = D.prepare(
  `SELECT j.apply_type, j.status, COUNT(*) n FROM jobs j
   WHERE j.id IN (SELECT DISTINCT job_id FROM events WHERE ts > ? AND stage='apply' AND job_id IS NOT NULL)
   GROUP BY 1,2 ORDER BY 1,3 DESC`).all(since);
for (const r of tally) console.log(`  ${String(r.apply_type).padEnd(12)} ${String(r.status).padEnd(18)} ${r.n}`);

console.log('\n--- applications recorded in this window ---');
const apps = D.prepare(
  `SELECT a.id, a.job_id, a.channel, a.adapter_used, a.outcome, a.step_count, a.filled_json, j.company
   FROM applications a JOIN jobs j ON j.id = a.job_id
   WHERE a.id > (SELECT COALESCE(MAX(id),0) FROM applications WHERE rowid IN
     (SELECT rowid FROM applications LIMIT 0)) AND a.job_id IN
     (SELECT DISTINCT job_id FROM events WHERE ts > ? AND stage='apply' AND job_id IS NOT NULL)
   ORDER BY a.id`).all(since);
for (const a of apps) {
  let f = [];
  try { f = JSON.parse(a.filled_json || '[]'); } catch { /* ignore */ }
  console.log(`  app${a.id} job${a.job_id} ${String(a.channel).padEnd(13)} ${String(a.adapter_used).padEnd(16)} ${String(a.outcome).padEnd(10)} steps=${a.step_count} fields=${f.length}  ${a.company}`);
  for (const x of f) {
    console.log(`      ${String(x.tier || '?').padEnd(12)} ${String(x.question || '').slice(0, 52).padEnd(54)} => ${JSON.stringify(String(x.value ?? '').slice(0, 44))}`);
  }
}

console.log('\n--- parks recorded in this window ---');
for (const p of D.prepare(
  `SELECT job_id, question_raw, field_type, reason FROM parked_questions WHERE created_at > ? ORDER BY id`).all(since)) {
  console.log(`  job${String(p.job_id).padEnd(5)} [${String(p.field_type || '').padEnd(8)}] ${String(p.question_raw).replace(/\n/g, ' ').slice(0, 46).padEnd(48)} ${String(p.reason).replace(/\n/g, ' ').slice(0, 90)}`);
}

console.log('\n--- rate ledger ---');
console.log(' ', JSON.stringify(D.prepare('SELECT * FROM rate_ledger ORDER BY date DESC LIMIT 2').all()));
console.log('\n--- learned plans / answer bank ---');
console.log('  page_plans:', D.prepare('SELECT COUNT(*) n FROM page_plans').get().n,
  '| answers:', D.prepare('SELECT COUNT(*) n FROM answers').get().n,
  '| answers used:', D.prepare('SELECT COALESCE(SUM(times_used),0) n FROM answers').get().n);
console.log();
