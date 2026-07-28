// Field-level accuracy audit of what the pipeline actually sent to employers.
//
// Reads the append-only submission ledger and checks every value that went out
// against the master profile. The pipeline's own logs say what it *decided*;
// this says whether the decision was right.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const LOG = path.join(ROOT, 'artifacts/submissions/submissions.jsonl');
const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'profile/master-profile.json'), 'utf8'));

const since = process.argv[2] || '1970-01-01';

const rows = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean)
  .filter(r => r.submittedAt >= since);

// A correction record supersedes the original for the same application.
const latest = new Map();
for (const r of rows) latest.set(r.applicationId, r);
const subs = [...latest.values()];

const id = profile.identity;
const norm = s => String(s ?? '').trim().toLowerCase();

// What a correct answer looks like, per question shape. Anything not matched
// here is reported as unclassified rather than silently passed.
const RULES = [
  { name: 'first name', q: /first\s*name|given name/i, ok: v => norm(v) === norm(id.firstName) },
  { name: 'last name', q: /last\s*name|surname|family name/i, ok: v => norm(v) === norm(id.lastName) },
  { name: 'full name', q: /^(full |your )?name$/i, ok: v => norm(v).includes(norm(id.firstName)) },
  { name: 'email', q: /e-?mail/i, ok: v => [id.email, id.linkedinEmail].map(norm).includes(norm(v)) },
  // A country-code select wants the country, not the number — feeding it the raw
  // phone was defect D1 and is what PR-2c fixed, so "South Africa (+27)" here is
  // the correct answer and must not be flagged as a mismatched phone.
  { name: 'phone country code', q: /(country\s*code|dial(ing)?\s*code)/i, ok: v => /south africa|\+?27\b/i.test(String(v)) },
  { name: 'phone', q: /phone|mobile|cell|contact number/i, ok: v => norm(v).replace(/\D/g, '').includes('828204538') },
  { name: 'city', q: /city|town|current location|where.*based/i, ok: v => norm(v) === norm(id.city) },
  { name: 'country', q: /country|nationality/i, ok: v => norm(v).includes('south africa') || norm(v) === 'za' },
  { name: 'linkedin', q: /linkedin/i, ok: v => /linkedin\.com/i.test(v) },
  { name: 'years experience', q: /years.*experience|experience.*years/i, ok: v => /\b[23]\b|2-3|3-5/.test(String(v)) },
  { name: 'salary', q: /salary|remuneration|compensation|ctc|expected pay/i, ok: v => /negotiable|480|\d{5,}/i.test(String(v)) },
  { name: 'notice / availability', q: /notice|available|start date|earliest/i, ok: v => /30|1 month|month|immediate|\d{4}-\d{2}-\d{2}/i.test(String(v)) },
  { name: 'work authorisation', q: /authoris|authoriz|right to work|eligible to work|sponsorship|visa|citizen|permit/i, ok: v => /yes|no|south africa|citizen|true/i.test(String(v)) },
  { name: "driver's licence", q: /driver.?s? licen[sc]e/i, ok: v => /yes|true|valid|code/i.test(String(v)) },
  { name: 'how did you hear', q: /how did you (hear|find)|source|referr/i, ok: v => String(v).length > 0 },
];

let totalFields = 0;
const problems = [];
const tiers = {};
const perSub = [];

for (const s of subs) {
  const fields = s.fields || [];
  const row = { at: s.submittedAt, job: `${s.job.title} @ ${s.job.company}`, channel: s.channel, outcome: s.outcome, n: fields.length, bad: 0, unclassified: 0 };
  for (const f of fields) {
    totalFields++;
    const tier = f.decidedBy || 'unknown';
    tiers[tier] = (tiers[tier] || 0) + 1;
    const q = String(f.question || '');
    const v = f.value;

    // A question the collector could not read is the highest-severity defect:
    // it means an answer was sent to something nobody could see.
    if (!q.trim() || q.trim().length < 3) {
      problems.push({ sev: 'CRITICAL', job: row.job, why: 'question text empty/unreadable', q, v, tier });
      row.bad++; continue;
    }
    // The model's own "I cannot answer this" markers must never reach a form.
    // One did, on the only application this run auto-submitted.
    if (/^(unanswerable|unknown|n\/?a|none|not applicable|no answer|null|undefined|i (don'?t|do not) know)$/i.test(String(v ?? '').trim())) {
      problems.push({ sev: 'CRITICAL', job: row.job, why: 'non-answer sentinel sent as a field value', q, v, tier });
      row.bad++; continue;
    }

    const rule = RULES.find(r => r.q.test(q));
    if (!rule) { row.unclassified++; continue; }
    if (!rule.ok(v)) {
      problems.push({ sev: tier === 'llm' ? 'HIGH' : 'MEDIUM', job: row.job, why: `${rule.name}: value does not match profile`, q, v, tier });
      row.bad++;
    }
  }
  perSub.push(row);
}

console.log(`\n=== SUBMISSION AUDIT (since ${since}) ===\n`);
console.log(`ledger lines: ${rows.length} · distinct applications: ${subs.length}`);
console.log(`fields sent: ${totalFields}\n`);
console.log('decided-by tier histogram:');
for (const [k, v] of Object.entries(tiers).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(k).padEnd(12)} ${String(v).padStart(4)}  ${(100 * v / totalFields).toFixed(0)}%`);
}
console.log('\nper submission:');
for (const r of perSub) {
  console.log(`  ${r.at.slice(0, 16).replace('T', ' ')} ${String(r.channel).padEnd(13)} ${String(r.outcome).padEnd(22)} ${String(r.n).padStart(2)}f ${r.bad ? `${r.bad} SUSPECT` : 'clean'}${r.unclassified ? ` (${r.unclassified} unclassified)` : ''}  ${r.job.slice(0, 50)}`);
}
console.log(`\nproblems: ${problems.length}`);
for (const p of problems) {
  console.log(`  [${p.sev}] ${p.job.slice(0, 44)}`);
  console.log(`      tier=${p.tier}  ${p.why}`);
  console.log(`      Q: ${JSON.stringify(String(p.q).slice(0, 90))}`);
  console.log(`      A: ${JSON.stringify(String(p.v).slice(0, 90))}`);
}
console.log('');
