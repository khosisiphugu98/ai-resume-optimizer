#!/usr/bin/env node
import fs from 'node:fs';
import { PATHS } from './config.js';
import { getContext, closeContext, isLoggedIn, attachScreencast, closeBrowserOnExit } from './browser.js';
import { runDiscovery, runEnrich } from './discover/linkedin.js';
import { startServer } from './server.js';
import { emit } from './bus.js';
import { getSetting, setSetting, todayRates, allSearches, blockedCompanies, listPageCaptures, listPagePlans } from './db.js';
import { applySecretsToEnv } from './secrets.js';

const cmd = process.argv[2];

// Only server.js did this, so every stage run from the CLI — score, tailor,
// apply, the whole `npm run cycle` — started with no API keys in the
// environment and silently degraded to its keyless path. The same run through
// the dashboard had them. Same code, different answers, no error either way.
applySecretsToEnv();

closeBrowserOnExit();

const commands = {
  async login() {
    const ctx = await getContext({ headless: false });
    const page = ctx.pages()[0] || await ctx.newPage();
    await attachScreencast(page);
    if (await isLoggedIn(page)) {
      console.log('Already logged in — session is live in the persistent profile.');
      return closeContext();
    }
    console.log('\n  Log in to LinkedIn in the browser window that just opened.');
    console.log('  Complete any 2FA. The session persists in apply-bot/data/chrome-profile.');
    console.log('  Press Ctrl+C here when the feed has loaded.\n');
    await page.goto('https://www.linkedin.com/login');
    await new Promise(() => {});   // hold the browser open
  },

  async check() {
    const ctx = await getContext({ headless: false });
    const page = ctx.pages()[0] || await ctx.newPage();
    const ok = await isLoggedIn(page);
    console.log(ok ? 'Logged in.' : 'NOT logged in — run: npm run login');
    console.log('Rates today:', todayRates());
    console.log('Mode:', getSetting('mode', 'observe'));
    await closeContext();
    process.exit(ok ? 0 : 1);
  },

  async discover() {
    await guard();
    const r = await runDiscovery();
    console.log(r);
    await closeContext();
  },

  // No guard: enrichment reads LinkedIn's public guest endpoint, so it needs
  // neither a session nor the browser profile and must stay runnable when
  // something else has the browser.
  async enrich() {
    if (fs.existsSync(PATHS.stop)) { console.error('STOP file present. Run `npm run resume` first.'); process.exit(1); }
    const r = await runEnrich({ limit: Number(process.argv[3]) || 20 });
    console.log(r);
    await closeContext();
  },

  /** Phase 1 default: serve the dashboard, then discover + enrich once. */
  async run() {
    await startServer();
    await guard();
    emit({ stage: 'run', message: `Starting run in ${getSetting('mode', 'observe')} mode` });
    try {
      await runDiscovery();
      await runEnrich({ limit: 25 });
      emit({ stage: 'run', message: 'Run complete. Dashboard stays up — Ctrl+C to exit.' });
    } catch (err) {
      emit({ stage: 'run', level: 'critical', message: `Run halted: ${err.message}` });
    }
  },

  async serve() {
    await startServer();
  },

  /** Dashboard + the autonomous loop: discover → enrich → score → tailor → apply → email → replies, on repeat until stopped. */
  async auto() {
    await startServer({ auto: true });
    emit({ stage: 'auto', message: `Autonomous mode — running continuously in ${getSetting('mode', 'observe')} mode. Ctrl+C or the kill switch to stop.` });
  },

  async profile() {
    const { loadProfile, unconfirmed } = await import('./profile.js');
    const p = loadProfile();
    const gaps = unconfirmed(p);
    console.log(`\n  ${p.identity.firstName} ${p.identity.lastName} · ${p.identity.email}`);
    if (!gaps.length) return console.log('\n  Profile fully confirmed — nothing will park on missing facts.\n');
    console.log(`\n  ${gaps.length} unconfirmed field(s). Each one parks any application that asks about it:\n`);
    for (const g of gaps) console.log('   ·', g);
    console.log(`\n  Edit apply-bot/profile/master-profile.json and set confirmed: true where the value is right.\n`);
  },

  // The evidence corpus. `evidence` lists it; `evidence <file...>` adds documents.
  async evidence() {
    const { listDocuments, addDocument } = await import('./evidence/store.js');
    const fsMod = await import('node:fs');
    const files = process.argv.slice(3);

    for (const f of files) {
      try {
        const doc = await addDocument(f.split('/').pop(), fsMod.readFileSync(f));
        console.log(`  added ${doc.filename} — ${doc.chars} characters of text`);
      } catch (err) {
        console.log(`  SKIPPED ${f} — ${err.message}`);
      }
    }

    const docs = listDocuments();
    if (!docs.length) return console.log('\n  No evidence documents. Add one:  npm run evidence -- path/to/CV.pdf\n');
    console.log(`\n  ${docs.length} evidence document(s):`);
    for (const d of docs) console.log(`   · ${d.filename} (${d.chars} chars, ${d.uploadedAt.slice(0, 10)})`);
    console.log();
  },

  // Report-only: which confirmed skills the CVs cannot support. Never writes.
  async audit() {
    const { loadProfile } = await import('./profile.js');
    const { corpus } = await import('./evidence/store.js');
    const { auditConfirmedSkills } = await import('./evidence/skills.js');

    const docs = corpus();
    if (!docs.length) return console.log('\n  No evidence documents to audit against. Add one:  npm run evidence -- path/to/CV.pdf\n');

    const rows = await auditConfirmedSkills(loadProfile({ fresh: true }), docs);
    const notSkills = rows.filter(r => !r.isSkill);
    const unevidenced = rows.filter(r => r.isSkill && !r.evidenced);

    console.log(`\n  ${rows.length} confirmed skill(s) checked against ${docs.length} document(s).`);
    console.log(`  ${rows.length - notSkills.length - unevidenced.length} evidenced · ${unevidenced.length} unevidenced · ${notSkills.length} not skills at all\n`);

    if (notSkills.length) {
      console.log('  NOT SKILLS — confirmed, but not something an employer can verify:');
      for (const r of notSkills) console.log(`   · ${r.skill}${r.years != null ? ` (${r.years}y)` : ''} — ${r.notSkillWhy}`);
      console.log();
    }
    if (unevidenced.length) {
      console.log('  NO EVIDENCE — the optimiser may write these into a tailored CV:');
      for (const r of unevidenced) console.log(`   · ${r.skill}${r.years != null ? ` (${r.years}y)` : ''}`);
      console.log();
    }
    console.log('  Nothing was changed. Edit profile/master-profile.json to act on this.\n');
  },

  async score() {
    const { runScoring } = await import('./score/index.js');
    console.log(await runScoring({ limit: Number(process.argv[3]) || 30 }));
  },

  async seed() {
    const { seedDefaultResume } = await import('./tailor/optimiser.js');
    const ctx = await getContext();
    const page = ctx.pages()[0] || await ctx.newPage();
    await attachScreencast(page);
    console.log(await seedDefaultResume(page, { force: process.argv[3] === '--force' }));
    await closeContext();
  },

  async tailor() {
    const { runTailoring } = await import('./tailor/optimiser.js');
    console.log(await runTailoring({ limit: Number(process.argv[3]) || 10 }));
    await closeContext();
  },

  async apply() {
    await guard();
    const { runApplications } = await import('./apply/run.js');
    const { currentMode } = await import('./apply/rate.js');
    const args = process.argv.slice(3);
    const mode = args.find(a => ['observe', 'review', 'auto'].includes(a)) || currentMode();
    const limit = Number(args.find(a => /^\d+$/.test(a))) || 5;
    console.log(await runApplications({ limit, mode, ignoreHours: args.includes('--now') }));
    await closeContext();
  },

  async email() {
    const { runEmailApplications } = await import('./email/outbox.js');
    console.log(await runEmailApplications({ limit: Number(process.argv[3]) || 10 }));
  },

  async outbox() {
    const { flushOutbox, HOLD_MINUTES } = await import('./email/outbox.js');
    const { outboxPending } = await import('./db.js');
    const pending = outboxPending();
    if (process.argv[3] === '--send') return console.log(await flushOutbox({ force: true }));
    if (!pending.length) return console.log('Outbox empty.');
    console.log(`\n  ${pending.length} draft(s) held (${HOLD_MINUTES} min hold):\n`);
    for (const d of pending) {
      const secs = Math.max(0, Math.round((new Date(d.send_after) - Date.now()) / 1000));
      console.log(`   #${d.id} → ${d.to_addr}  "${d.subject}"  ${secs > 0 ? `sends in ${Math.ceil(secs / 60)}m` : 'due'}`);
    }
    console.log('\n  npm run outbox -- --send   send everything now');
    console.log('  Cancel individual drafts in the dashboard.\n');
  },

  async replies() {
    const { checkReplies } = await import('./email/outbox.js');
    console.log(await checkReplies());
  },

  async 'gmail:auth'() {
    const gmail = await import('./email/gmail.js');
    if (!gmail.hasCredentials()) { console.log(gmail.SETUP_HELP); process.exit(1); }
    await gmail.authorise();
    // Naming the account needs a read scope, and this install is send-only by
    // design — so ask, and say so plainly when the answer is "not allowed to
    // look" rather than crashing a flow that in fact succeeded.
    const who = await gmail.profileAddress().catch(() => null);
    console.log(who
      ? `\n  Connected as ${who}\n`
      : '\n  Connected. Send-only access, so the account name is not readable from here.\n');
  },

  // What actually went to employers. Reads the append-only submission log.
  async submissions() {
    const { listSubmissions, SUBMISSIONS_DIR } = await import('./apply/submission-log.js');
    const verbose = process.argv.includes('--fields');
    const rows = listSubmissions({ limit: Number(process.argv[3]) || 50 });

    if (!rows.length) {
      console.log('\n  Nothing submitted yet. Every submission is recorded under');
      console.log(`  ${SUBMISSIONS_DIR}/ as it happens.\n`);
      return;
    }

    // Only `submitted` and `submitted_unconfirmed` are applications that went
    // out. Anything else is a correction to one — the ledger is append-only, so
    // a retraction is a later line for the same application, and showing it
    // without a label read as a second application to the same company.
    const OUTCOME_FLAG = {
      submitted: '',
      submitted_unconfirmed: ' [UNCONFIRMED]',
      error: ' [RETRACTED — did not reach the employer]',
    };
    const sent = rows.filter(r => String(r.outcome || '').startsWith('submitted')).length;

    console.log(`\n  ${sent} application(s) sent, ${rows.length} record(s), newest first:\n`);
    for (const r of rows) {
      const flag = OUTCOME_FLAG[r.outcome] ?? ` [${String(r.outcome || 'unknown').toUpperCase()}]`;
      const corrected = r.corrections ? `  (corrected ${r.corrections}×)` : '';
      console.log(`  ${r.submittedAt.slice(0, 16).replace('T', ' ')}  ${r.job.title} @ ${r.job.company}${flag}${corrected}`);
      console.log(`     ${r.channel}${r.vendor ? `/${r.vendor}` : ''} · ${r.fieldCount} field(s) · CV: ${r.resume || 'none'}`);
      if (r.appliedAt) console.log(`     ${String(r.appliedAt).slice(0, 100)}`);
      if (verbose) {
        for (const f of r.fields) {
          console.log(`       [${String(f.decidedBy || '?').padEnd(11)}] ${String(f.question || '').slice(0, 44).padEnd(46)} = ${JSON.stringify(String(f.value ?? '').slice(0, 44))}${f.probable ? '  (interpreted)' : ''}`);
        }
      }
      console.log('');
    }
    if (!verbose) console.log('  npm run submissions -- --fields   show every value sent\n');
  },

  async searches() {
    for (const s of allSearches()) {
      console.log(`  ${s.enabled ? ' ' : '·'} [${s.tier}] ${s.keywords.padEnd(34)} ${s.location}` +
        `${s.remote ? ' (remote)' : ''}  ${String(s.found).padStart(4)} found${s.enabled ? '' : '   [off]'}`);
    }
    const blocked = blockedCompanies();
    if (blocked.length) {
      console.log(`\n  Blocked companies: ${blocked.map(b => b.company).join(', ')}`);
    }
    console.log('\n  Add, disable or remove these in the dashboard\'s Search terms panel.\n');
  },

  async captures() {
    const rows = listPageCaptures();
    if (!rows.length) {
      console.log('\n  No unknown-page captures yet. They accrue as the apply stage hits');
      console.log('  application pages no vendor adapter can fill.\n');
      return;
    }
    const age = ts => {
      const h = Math.round((Date.now() - new Date(ts).getTime()) / 36e5);
      return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
    };
    console.log(`\n  ${rows.length} distinct unsolved page shape(s), newest first:\n`);
    for (const r of rows) {
      console.log(
        `  ${(r.host || '?').padEnd(32)} ${String(r.vendor || '').padEnd(10)} ` +
        `${String(r.failure_stage || '').padEnd(9)} ${String(r.control_count ?? 0).padStart(3)} ctrl  ` +
        `×${String(r.seen_count).padStart(3)}  ${age(r.captured_at).padStart(4)} ago  [${r.fingerprint.slice(0, 8)}]`,
      );
    }
    console.log('\n  Snapshots (a11y tree + DOM + screenshot) live under data/agent-snapshots/<fp>/.\n');
  },

  async plans() {
    const rows = listPagePlans();
    if (!rows.length) {
      console.log('\n  No learned plans yet. The agent caches a plan the first time it');
      console.log('  fills an unknown page; later visits to that shape replay it with no model call.\n');
      return;
    }
    const age = ts => {
      if (!ts) return '—';
      const h = Math.round((Date.now() - new Date(ts).getTime()) / 36e5);
      return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
    };
    console.log(`\n  ${rows.length} learned plan(s), most-recently-used first:\n`);
    for (const r of rows) {
      console.log(
        `  ${(r.host || '?').padEnd(32)} ${String(r.source).padEnd(9)} ` +
        `${String(r.success_count).padStart(3)}✓ ${String(r.fail_count).padStart(3)}✗  ` +
        `used ${age(r.last_used_at).padStart(4)} ago  [${r.fingerprint.slice(0, 8)}]`,
      );
    }
    console.log('');
  },

  async stop() {
    fs.writeFileSync(PATHS.stop, new Date().toISOString());
    console.log('STOP file written — all runs will halt before their next action.');
  },

  async resume() {
    fs.rmSync(PATHS.stop, { force: true });
    console.log('STOP cleared.');
  },

  async mode() {
    const m = process.argv[3];
    if (!m) return console.log('Mode:', getSetting('mode', 'observe'));
    setSetting('mode', m);
    console.log('Mode set to', m);
  },
};

async function guard() {
  if (fs.existsSync(PATHS.stop)) {
    console.error('STOP file present. Run `npm run resume` first.');
    process.exit(1);
  }
  const ctx = await getContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  if (!await isLoggedIn(page)) {
    console.error('Not logged in to LinkedIn. Run: npm run login');
    process.exit(1);
  }
}

if (!commands[cmd]) {
  console.log(`
  apply-bot — phase 1 (discovery + observability)

    npm run login       Log in to LinkedIn by hand, once
    npm run check       Verify session, show rates and mode
    npm run serve       Dashboard only  → http://localhost:5175
    npm run run         Dashboard + one discover/enrich pass
    npm run auto        Dashboard + the full pipeline on repeat until stopped
    npm run discover    Discovery only
    npm run enrich [n]  Fetch JDs and resolve apply routes
    npm run searches    List configured searches
    npm run submissions List everything that has been sent to an employer
    npm run captures    List unknown application pages the apply flow couldn't fill
    npm run plans       List learned plans the agent replays (Phase 3)
    npm run stop        Write the kill switch
    npm run resume      Clear the kill switch
    npm run mode [m]    Get/set observe | review | auto
`);
  process.exit(1);
}

await commands[cmd]();
