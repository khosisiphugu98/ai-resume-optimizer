#!/usr/bin/env node
/**
 * Live watch over everything the bot sends to an employer.
 *
 * Auto-submit means applications now leave the machine without anyone reading
 * them first. That is fine as long as somebody can see what went out and say
 * "that answer is wrong" quickly — the failure mode worth fearing is not one
 * bad application, it's a hundred of them carrying the same bad answer before
 * anyone notices.
 *
 * So this tails the submission ledger and prints every field of every
 * submission as it happens, with the tier that decided each value, and raises
 * the specific things that are worth a human's eye: values the model inferred
 * rather than knew, submissions that could not be confirmed, applications that
 * went out nearly empty, and answers that contradict the profile.
 *
 * Read-only. It never touches the pipeline. Ctrl+C to stop.
 *
 *   npm run watch:submissions           follow new submissions
 *   npm run watch:submissions -- --all  replay everything recorded so far first
 */
import fs from 'node:fs';
import { SUBMISSIONS_LOG, listSubmissions } from '../src/apply/submission-log.js';
import { loadProfile } from '../src/profile.js';

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
};

const profile = loadProfile();
const id = profile.identity || {};

/**
 * A submission is worth interrupting someone over when the machine was
 * guessing, when nobody knows whether it arrived, or when what it sent
 * disagrees with what the candidate actually said about themselves.
 */
function concerns(rec) {
  const out = [];

  if (rec.outcome === 'submitted_unconfirmed') {
    out.push('the confirmation page was not recognised — nobody knows whether this arrived');
  }
  if (!rec.resume) {
    out.push('no CV was attached');
  }
  // The Greenhouse symptom: the form scope collapsed to a single wrapper, the
  // CV attached, and every question went unanswered.
  if (rec.channel !== 'email' && rec.fieldCount <= 2) {
    out.push(`only ${rec.fieldCount} field(s) filled — the form may not have been read properly`);
  }

  const inferred = (rec.fields || []).filter(f => f.decidedBy === 'llm' || f.probable);
  for (const f of inferred) {
    out.push(`inferred, not known: ${JSON.stringify(f.question)} → ${JSON.stringify(f.value)}`);
  }

  // Cross-check the handful of facts that have exactly one right answer. A
  // wrong email or phone number is silent and total: the employer replies into
  // the void and the application looks like it was never followed up.
  const check = (label, sent, truth) => {
    if (!sent || !truth) return;
    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9@.]/g, '');
    if (norm(sent) !== norm(truth)) out.push(`${label} sent as ${JSON.stringify(sent)}, profile says ${JSON.stringify(truth)}`);
  };
  for (const f of rec.fields || []) {
    const q = String(f.question || '').toLowerCase();
    if (/e-?mail/.test(q)) check('email', f.value, id.email);
    else if (/first name/.test(q)) check('first name', f.value, id.firstName);
    else if (/last name|surname/.test(q)) check('last name', f.value, id.lastName);
  }

  return out;
}

function render(rec) {
  const when = new Date(rec.submittedAt).toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' });
  const ok = rec.outcome === 'submitted';
  const head = `${ok ? C.green('SENT') : C.yellow('SENT?')} ${C.bold(rec.job.title)} @ ${C.bold(rec.job.company)}`;

  console.log(`\n${C.dim(`[${when}]`)} ${head}`);
  console.log(C.dim(`  job #${rec.job.id} · ${rec.channel}${rec.vendor ? ` · ${rec.vendor}` : ''}`
    + `${rec.agent ? ` · agent:${rec.agent.kind}` : ''} · fit ${rec.job.fitScore ?? '?'} · ${rec.steps} step(s)`));
  console.log(C.dim(`  ${rec.appliedAt || rec.job.posting || ''}`));
  console.log(C.dim(`  CV: ${rec.resume || C.red('none attached')}`));

  if (!rec.fields.length) console.log(C.dim('  (no fields recorded)'));
  for (const f of rec.fields) {
    // The tier is the whole point of printing this: it says whether the answer
    // came from a fact, a stored decision, or a guess.
    const tier = C.dim(`[${f.decidedBy || '?'}${f.probable ? '~' : ''}]`);
    console.log(`  ${tier} ${C.cyan(String(f.question ?? '').slice(0, 70))}`);
    console.log(`        ${String(f.value ?? '').replace(/\s+/g, ' ').slice(0, 140)}`);
  }

  for (const c of concerns(rec)) console.log(C.yellow(`  ⚠ ${c}`));
}

const seen = new Set();
const replay = process.argv.includes('--all');

// Newest-first from the ledger, oldest-first for reading.
for (const rec of listSubmissions({ limit: 1000 }).reverse()) {
  const key = `${rec.job.id}-${rec.applicationId}-${rec.submittedAt}`;
  seen.add(key);
  if (replay) render(rec);
}

console.log(C.dim(`\nWatching ${SUBMISSIONS_LOG}`));
console.log(C.dim(`${seen.size} submission(s) already recorded${replay ? '' : ' (pass --all to replay them)'}. Ctrl+C to stop.\n`));

let lastReport = 0;
function poll() {
  let fresh = 0;
  for (const rec of listSubmissions({ limit: 200 }).reverse()) {
    const key = `${rec.job.id}-${rec.applicationId}-${rec.submittedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    render(rec);
    fresh++;
  }
  // A quiet heartbeat every 30 minutes, so a silent watcher is distinguishable
  // from a stopped one.
  const now = Date.now();
  if (!fresh && now - lastReport > 30 * 60_000) {
    lastReport = now;
    console.log(C.dim(`[${new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' })}] watching — ${seen.size} recorded so far`));
  }
}

// Polling rather than fs.watch: the writer appends from another process, and
// fs.watch's rename/change semantics differ enough across platforms that a
// 2-second poll on a small file is the simpler thing that always works.
fs.mkdirSync(SUBMISSIONS_LOG.replace(/\/[^/]+$/, ''), { recursive: true });
lastReport = Date.now();
setInterval(poll, 2000);
