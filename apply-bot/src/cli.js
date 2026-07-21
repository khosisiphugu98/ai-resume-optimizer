#!/usr/bin/env node
import fs from 'node:fs';
import { PATHS, SEARCHES } from './config.js';
import { getContext, closeContext, isLoggedIn, attachScreencast } from './browser.js';
import { runDiscovery, runEnrich } from './discover/linkedin.js';
import { startServer } from './server.js';
import { emit } from './bus.js';
import { getSetting, setSetting, todayRates } from './db.js';

const cmd = process.argv[2];

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

  async enrich() {
    await guard();
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
    console.log(`\n  Connected as ${await gmail.profileAddress()}\n`);
  },

  async searches() {
    for (const s of SEARCHES) console.log(`  [${s.tier}] ${s.keywords.padEnd(34)} ${s.location}${s.remote ? ' (remote)' : ''}`);
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
    npm run discover    Discovery only
    npm run enrich [n]  Fetch JDs and resolve apply routes
    npm run searches    List configured searches
    npm run stop        Write the kill switch
    npm run resume      Clear the kill switch
    npm run mode [m]    Get/set observe | review | auto
`);
  process.exit(1);
}

await commands[cmd]();
