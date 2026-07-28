// Live tail of the event bus for the supervised end-to-end run.
// Reads the events table directly so it sees every stage, including the ones
// that emit() to the dashboard rather than stdout.
import Database from 'better-sqlite3';

const db = new Database(new URL('../data/pipeline.sqlite', import.meta.url).pathname, { readonly: true });
const stages = (process.argv[2] || '').split(',').filter(Boolean);
let last = Number(process.argv[3]) || db.prepare('select coalesce(max(id),0) m from events').get().m;

const interesting = /submit|Submitted|park|Park|fail|Fail|error|Error|block|Block|challenge|manual|duplicate|agent|Agent|plan|Plan|sent|Sent|queued|held|review|unconfirmed/;

setInterval(() => {
  const rows = db.prepare('select * from events where id > ? order by id').all(last);
  for (const r of rows) {
    last = r.id;
    if (stages.length && !stages.includes(r.stage)) continue;
    if (r.level === 'debug' && !interesting.test(r.message || '')) continue;
    const t = r.ts.slice(11, 19);
    console.log(`${t} [${String(r.stage || '').padEnd(7)}] ${r.level === 'info' ? '' : r.level.toUpperCase() + ' '}${r.job_id ? `job${r.job_id} ` : ''}${r.message}`);
  }
}, 2000);
