import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { ROOT, SERVER, CAPS, PATHS } from './config.js';
import {
  boardSnapshot, recentEvents, db, getSetting, setSetting, parkedQueue, releaseAnswered,
  allSearches, addSearch, setSearchEnabled, deleteSearch,
  blockJob, unblockJob, blockCompany, unblockCompany, blockedCompanies,
  pendingOutcomes, setOutcome, autoTimeoutOutcomes, outcomeSummary,
  OUTCOME_STATES, OUTCOME_TIMEOUT_DAYS,
  listSkillSuggestions, dismissSkillSuggestion, removeSkillSuggestion,
} from './db.js';
import { bus, emit, emitBoard } from './bus.js';
import { saveAnswer, allAnswers, learnFromApproved } from './answer/bank.js';
import { loadProfile, unconfirmed, profileExists, editableGaps, setProfileValue, confirmSkill, confirmedSkillNames } from './profile.js';
import { cancelEmail } from './db.js';
import { flushOutbox, HOLD_MINUTES } from './email/outbox.js';
import * as gmail from './email/gmail.js';
import { applySecretsToEnv, setSecret, secretsStatus } from './secrets.js';
import { calibrationReport, buildFewShot } from './score/calibrate.js';
import { currentThreshold, setThreshold, THRESHOLD, AUDIT } from './score/index.js';

applySecretsToEnv();

const DASH = path.join(ROOT, 'dashboard');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function json(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Everything the last attempt filled in, for the answer bank to learn from. */
function lastFilled(jobId) {
  const app = db.prepare(
    `SELECT filled_json FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1`).get(jobId);
  try {
    return JSON.parse(app?.filled_json || '[]');
  } catch {
    return [];
  }
}

const routes = {
  '/api/board': (req, res) => json(res, {
    ...boardSnapshot(),
    caps: CAPS,
    mode: getSetting('mode', 'observe'),
    stopped: fs.existsSync(PATHS.stop),
    running,
    profileReady: profileExists() && unconfirmed(loadProfile({ fresh: true })).length === 0,
    secrets: secretsStatus(),
    gmailConnected: gmail.isConfigured(),
  }),

  '/api/events': (req, res) => json(res, recentEvents(200)),

  '/api/parked': (req, res) => json(res, {
    queue: parkedQueue().map(q => ({ ...q, options: q.options_json ? JSON.parse(q.options_json) : null })),
    profileGaps: profileExists() ? unconfirmed(loadProfile({ fresh: true })) : ['no profile — copy profile.example.json to profile/master-profile.json'],
    profileFields: editableGaps(),
    // Skills jobs asked for that aren't confirmed yet. Hide any that have since been
    // confirmed in the profile so a stale suggestion never lingers after the fact.
    skillSuggestions: listSkillSuggestions(profileExists() ? confirmedSkillNames(loadProfile({ fresh: true })) : []),
  }),

  '/api/answers': (req, res) => json(res, allAnswers()),

  // What discovery searches for, and who it must never search up.
  '/api/searches': (req, res) => json(res, {
    searches: allSearches(),
    blocked: blockedCompanies(),
  }),

  // Drafts waiting out their hold. Shown so a send can be caught before it is
  // permanent — no action needed to let one go.
  '/api/outbox': (req, res) => {
    const rows = db.prepare(`
      SELECT o.*, j.title, j.company FROM outbox o JOIN jobs j ON j.id = o.job_id
      WHERE o.status = 'held' ORDER BY o.send_after`).all();
    json(res, {
      gmailConnected: gmail.isConfigured(),
      holdMinutes: HOLD_MINUTES,
      drafts: rows.map(r => ({ ...r, attachments: JSON.parse(r.attachments_json || '[]') })),
    });
  },

  // Everything the bot filled, for approval before it's sent.
  '/api/review': (req, res) => {
    const jobs = db.prepare(`SELECT * FROM jobs WHERE status = 'awaiting_review' ORDER BY fit_score DESC, id`).all();
    json(res, jobs.map(job => {
      const app = db.prepare(
        `SELECT * FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1`).get(job.id);
      return {
        job,
        filled: app?.filled_json ? JSON.parse(app.filled_json) : [],
        screenshots: app?.screenshots_json ? JSON.parse(app.screenshots_json) : [],
        steps: app?.step_count ?? 0,
      };
    }));
  },

  // Everything configurable, in one place. Never returns a secret itself —
  // only whether it is set, and enough of a hint to tell two keys apart.
  '/api/settings': (req, res) => json(res, {
    openai: secretsStatus(),
    gmail: { ...gmail.status(), address: gmailAddress },
    profile: {
      exists: profileExists(),
      unconfirmed: profileExists() ? unconfirmed(loadProfile({ fresh: true })).length : null,
    },
    caps: CAPS,
    paths: { profileDir: path.join(ROOT, 'profile'), artifacts: PATHS.artifacts },
  }),

  // Applications that went out and have heard nothing back. This is the whole
  // outcome-capture surface: Easy Apply and the ATS boards report nothing, so
  // without the operator marking them there is no data to calibrate against.
  '/api/sent': (req, res) => json(res, {
    pending: pendingOutcomes(),
    states: OUTCOME_STATES,
    summary: outcomeSummary(),
    timeoutDays: OUTCOME_TIMEOUT_DAYS,
  }),

  // Does the fit score predict anything? Usually "not enough data yet", which is
  // a legitimate answer and the one this will give for months.
  '/api/calibration': (req, res) => json(res, {
    ...calibrationReport(),
    threshold: currentThreshold(),
    defaultThreshold: THRESHOLD,
    auditRate: AUDIT.rate,
    auditCap: AUDIT.dailyCap,
  }),

  '/api/job': (req, res, url) => {
    const id = Number(url.searchParams.get('id'));
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!job) return json(res, { error: 'not found' }, 404);
    const events = db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY id').all(id);
    const apps = db.prepare('SELECT * FROM applications WHERE job_id = ?').all(id);
    json(res, { job, events, applications: apps });
  },
};

/**
 * Pipeline stages, runnable from the dashboard so the whole system is operable
 * without a terminal.
 *
 * Exactly one runs at a time. That is not just tidiness: every browser stage
 * shares the single persistent Chrome profile, and two concurrent LinkedIn
 * sessions on one account is the fastest way to get flagged.
 */
let running = null;

// Resolved once on connect and cached — the settings panel shows which account
// mail would go out from, and that is worth a network call only when it changes.
let gmailAddress = null;

const STAGES = {
  login: async () => {
    const { getContext, attachScreencast, isLoggedIn } = await import('./browser.js');
    const ctx = await getContext({ headless: false });
    const page = ctx.pages()[0] || await ctx.newPage();
    await attachScreencast(page);
    if (await isLoggedIn(page)) return emit({ stage: 'login', message: 'Already logged in to LinkedIn' });
    await page.goto('https://www.linkedin.com/login');
    emit({ stage: 'login', message: 'A browser window is open — log in to LinkedIn there, 2FA included. It stays logged in afterwards.' });
  },
  check: async () => {
    const { getContext, isLoggedIn } = await import('./browser.js');
    const ctx = await getContext();
    const page = ctx.pages()[0] || await ctx.newPage();
    const ok = await isLoggedIn(page);
    emit({ stage: 'login', level: ok ? 'info' : 'warn', message: ok ? 'LinkedIn session is live' : 'Not logged in — press Log in to LinkedIn' });
  },
  discover: async () => { const m = await import('./discover/linkedin.js'); await m.runDiscovery(); },
  enrich:   async () => { const m = await import('./discover/linkedin.js'); await m.runEnrich({ limit: 25 }); },
  score:    async () => { const m = await import('./score/index.js'); await m.runScoring({ limit: 30 }); },
  seed:     async () => {
    const { getContext, attachScreencast } = await import('./browser.js');
    const { seedDefaultResume } = await import('./tailor/optimiser.js');
    const ctx = await getContext();
    const page = ctx.pages()[0] || await ctx.newPage();
    await attachScreencast(page);
    await seedDefaultResume(page);
  },
  tailor:   async () => { const m = await import('./tailor/optimiser.js'); await m.runTailoring({ limit: 10 }); },
  apply:    async () => { const m = await import('./apply/run.js'); await m.runApplications({ limit: 5 }); },
  email:    async () => { const m = await import('./email/outbox.js'); await m.runEmailApplications({ limit: 10 }); },
  replies:  async () => { const m = await import('./email/outbox.js'); await m.checkReplies(); },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${SERVER.port}`);

  // Server-sent events — board updates and log lines.
  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');

    const sent = new Set();
    const push = e => {
      if (e.id != null) { if (sent.has(e.id)) return; sent.add(e.id); }
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    };

    // In-process bus — instant, used when the pipeline and server share a process
    // (`npm run run`).
    bus.on('event', push);

    // Table tail — covers the split-process case (`npm run serve` in one terminal,
    // `npm run discover` in another). Without this the dashboard would sit silent
    // while the bot worked. Deduped against the bus by event id.
    let lastId = db.prepare('SELECT MAX(id) m FROM events').get().m || 0;
    const poll = setInterval(() => {
      const rows = db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(lastId);
      for (const r of rows) {
        lastId = r.id;
        push({ type: 'event', id: r.id, jobId: r.job_id, ts: r.ts, stage: r.stage, level: r.level, message: r.message });
      }
      if (rows.length) push({ type: 'board' });
    }, 1000);

    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { bus.off('event', push); clearInterval(poll); clearInterval(ping); });
    return;
  }

  // Start a pipeline stage. Returns immediately; progress arrives over SSE.
  if (url.pathname === '/api/run' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { stage } = JSON.parse(body || '{}');

    if (!STAGES[stage]) return json(res, { error: `unknown stage "${stage}"` }, 400);
    if (running) return json(res, { error: `${running} is already running`, running }, 409);
    if (fs.existsSync(PATHS.stop) && stage !== 'check') {
      return json(res, { error: 'kill switch is on — clear it first' }, 409);
    }

    running = stage;
    emit({ stage, message: `Started: ${stage}` });
    emitBoard();

    STAGES[stage]()
      .catch(err => emit({ stage, level: 'error', message: `${stage} failed: ${err.message}` }))
      .finally(() => {
        running = null;
        emit({ stage, message: `Finished: ${stage}` });
        emitBoard();
      });

    return json(res, { started: stage });
  }

  // Store the OpenAI key locally. Without one, scoring falls back to a keyword
  // heuristic and answer drafting is unavailable.
  if (url.pathname === '/api/key' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { key } = JSON.parse(body || '{}');
    setSecret('OPENAI_API_KEY', key || '');
    emit({ stage: 'control', message: key ? 'OpenAI key saved — AI scoring and answer drafting enabled' : 'OpenAI key cleared' });
    emitBoard();
    return json(res, secretsStatus());
  }

  // Gmail, connectable without touching a terminal.
  if (url.pathname === '/api/gmail' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { action, credentials } = JSON.parse(body || '{}');
    try {
      if (action === 'credentials') {
        const r = gmail.saveCredentials(credentials);
        emit({ stage: 'control', message: 'Gmail OAuth client saved — connect to finish' });
        return json(res, r);
      }

      if (action === 'connect') {
        // Returns the consent URL for the dashboard to open. The rest of the
        // flow lands on the local callback and resolves in the background.
        const { url: consentUrl, completed } = gmail.beginAuthorisation();
        completed.then(async () => {
          gmailAddress = await gmail.profileAddress().catch(() => null);
          emit({ stage: 'control', message: `Gmail connected${gmailAddress ? ` as ${gmailAddress}` : ''}` });
          emitBoard();
        }).catch(err => {
          emit({ stage: 'control', level: 'error', message: `Gmail connection failed: ${err.message}` });
        });
        return json(res, { consentUrl });
      }

      if (action === 'disconnect') {
        gmail.disconnect();
        gmailAddress = null;
        emit({ stage: 'control', level: 'warn', message: 'Gmail disconnected — drafts will be written but not sent' });
        emitBoard();
        return json(res, { ok: true });
      }
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
    return json(res, { error: 'action must be credentials, connect or disconnect' }, 400);
  }

  // Kill switch, toggleable from the dashboard.
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { on } = JSON.parse(body || '{}');
    if (on) {
      fs.writeFileSync(PATHS.stop, new Date().toISOString());
      emit({ stage: 'control', level: 'warn', message: 'Kill switch ON — everything halts before its next action' });
    } else {
      fs.rmSync(PATHS.stop, { force: true });
      emit({ stage: 'control', message: 'Kill switch cleared' });
    }
    emitBoard();
    return json(res, { stopped: !!on });
  }

  if (url.pathname === '/api/mode' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { mode } = JSON.parse(body || '{}');
    setSetting('mode', mode);
    return json(res, { mode });
  }

  // Answering one parked question releases every job that was only waiting on it.
  if (url.pathname === '/api/answer' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { question, value, fieldType = 'text', scope = 'global' } = JSON.parse(body || '{}');
    if (!question || value == null || value === '') return json(res, { error: 'question and value required' }, 400);

    const norm = saveAnswer({ question, value, fieldType, scope, source: 'human', humanVerified: 1 });
    const freed = releaseAnswered(norm);
    emit({ stage: 'answer', message: `Answered "${question.slice(0, 60)}" — released ${freed.length} application(s)` });
    emitBoard();
    return json(res, { normalised: norm, released: freed.length });
  }

  // Confirm a profile field from the dashboard. Confirming is what makes the
  // value usable — unconfirmed values are invisible to the resolver.
  if (url.pathname === '/api/profile' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { path: dotPath, value } = JSON.parse(body || '{}');
    if (!dotPath || value === '' || value == null) return json(res, { error: 'path and value required' }, 400);
    try {
      const out = setProfileValue(dotPath, value);
      emit({ stage: 'profile', message: `Confirmed ${dotPath} = ${out.value} (${out.remaining} field(s) still unconfirmed)` });
      emitBoard();
      return json(res, out);
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // Confirm or dismiss a skill the optimiser suggested. Confirming writes it into
  // the profile as a real skill (so future tailoring can use it); dismissing hides
  // it for good. Either way it leaves the suggestion queue.
  if (url.pathname === '/api/skill-suggestion' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { skill, action, years } = JSON.parse(body || '{}');
    if (!skill || !['confirm', 'dismiss'].includes(action)) {
      return json(res, { error: 'skill and action (confirm|dismiss) required' }, 400);
    }
    try {
      if (action === 'confirm') {
        const out = confirmSkill(skill, years);
        removeSkillSuggestion(skill);
        emit({ stage: 'profile', message: `Confirmed skill "${out.skill}"${out.years != null ? ` (${out.years}y)` : ''} — will be used in future tailoring` });
      } else {
        dismissSkillSuggestion(skill);
        emit({ stage: 'profile', message: `Dismissed skill suggestion "${skill}"` });
      }
      emitBoard();
      return json(res, { ok: true });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // GET-only. Without the method guard a POST to a path that also has a GET
  // handler (e.g. /api/review) is swallowed by the reader and silently does
  // nothing.
  if (req.method === 'GET' && routes[url.pathname]) return routes[url.pathname](req, res, url);

  // Cancel a held draft. The only action that stops an email being sent.
  if (url.pathname === '/api/outbox' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { id, action } = JSON.parse(body || '{}');
    if (action === 'cancel') {
      const ok = cancelEmail(Number(id));
      if (ok) {
        const row = db.prepare('SELECT job_id, to_addr FROM outbox WHERE id = ?').get(Number(id));
        db.prepare(`UPDATE jobs SET status = 'rejected', reject_reason = 'email cancelled in outbox' WHERE id = ?`).run(row.job_id);
        emit({ jobId: row.job_id, stage: 'email', message: `Cancelled before sending to ${row.to_addr}` });
        emitBoard();
      }
      return json(res, { cancelled: ok });
    }
    if (action === 'send') {
      db.prepare(`UPDATE outbox SET send_after = ? WHERE id = ? AND status = 'held'`)
        .run(new Date().toISOString(), Number(id));
      const r = await flushOutbox();
      return json(res, r);
    }
    return json(res, { error: 'action must be cancel or send' }, 400);
  }

  // Approve or skip a reviewed application. Approving marks it for submission on
  // the next apply run — it re-runs the whole flow rather than resuming a modal
  // that closed hours ago.
  if (url.pathname === '/api/review' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { id, action } = JSON.parse(body || '{}');
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id));
    if (!job) return json(res, { error: 'not found' }, 404);

    if (action === 'approve') {
      const learned = learnFromApproved(lastFilled(job.id));
      db.prepare(`UPDATE jobs SET status = 'approved' WHERE id = ?`).run(job.id);
      emit({
        jobId: job.id, stage: 'review',
        message: `Approved — ${job.title} @ ${job.company} will submit on the next run` +
          (learned ? `. Learned ${learned} answer(s) — the same question will not need reviewing again.` : ''),
      });
    } else if (action === 'skip') {
      db.prepare(`UPDATE jobs SET status = 'rejected', reject_reason = 'skipped in review' WHERE id = ?`).run(job.id);
      emit({ jobId: job.id, stage: 'review', message: `Skipped — ${job.title} @ ${job.company}` });
    } else {
      return json(res, { error: 'action must be approve or skip' }, 400);
    }
    emitBoard();
    return json(res, { ok: true });
  }

  // Record what an employer actually did. The only signal that can answer whether
  // the fit score predicts anything, and it exists only because someone clicks it.
  if (url.pathname === '/api/outcome' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { id, state, note } = JSON.parse(body || '{}');
    try {
      if (!setOutcome(Number(id), { state, source: 'manual', note })) {
        return json(res, { error: 'no such application' }, 404);
      }
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
    const row = db.prepare(`
      SELECT j.title, j.company, j.fit_score FROM applications a
      JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`).get(Number(id));
    emit({
      stage: 'outcome',
      message: `${row.title} @ ${row.company} (fit ${row.fit_score ?? '—'}) → ${state}`,
    });
    emitBoard();
    return json(res, { ok: true, summary: outcomeSummary() });
  }

  // Move the fit threshold. Deliberately an operator action, never automatic:
  // the report shows the trade-off, a person decides. Auto-tuning on data this
  // thin would chase noise, and the loop that produced the data is the same one
  // the number feeds.
  if (url.pathname === '/api/threshold' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { value, regenerateExamples } = JSON.parse(body || '{}');
    try {
      if (value != null) {
        const n = setThreshold(value);
        emit({ stage: 'score', message: `Fit threshold set to ${n} — takes effect on the next scoring run` });
      }
      if (regenerateExamples) {
        const few = buildFewShot();
        if (!few) return json(res, { error: 'not enough labelled outcomes to build examples yet' }, 400);
        setSetting('score_examples', JSON.stringify(few));
        emit({ stage: 'score', message: `Scoring examples rebuilt from ${few.examples.length} real outcomes` });
      }
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
    emitBoard();
    return json(res, { threshold: currentThreshold() });
  }

  // Edit the search list. Takes effect on the next discovery run — nothing here
  // touches a run already in flight.
  if (url.pathname === '/api/searches' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { action, id, keywords, location, tier, remote, enabled } = JSON.parse(body || '{}');
    try {
      if (action === 'add') {
        const s = addSearch({ keywords, location, tier, remote });
        emit({ stage: 'discover', message: `Search added — "${s.keywords}" · ${s.location} (tier ${s.tier})` });
      } else if (action === 'toggle') {
        const s = setSearchEnabled(Number(id), enabled);
        emit({ stage: 'discover', message: `Search ${s.enabled ? 'enabled' : 'paused'} — "${s.keywords}"` });
      } else if (action === 'delete') {
        const s = deleteSearch(Number(id));
        if (s) emit({ stage: 'discover', message: `Search removed — "${s.keywords}" · ${s.location}` });
      } else {
        return json(res, { error: 'action must be add, toggle or delete' }, 400);
      }
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
    return json(res, { searches: allSearches(), blocked: blockedCompanies() });
  }

  // Veto a job — or a whole company — before anything goes out. Blocking is
  // reversible and keeps the tailored resume; it only stops the sending.
  if (url.pathname === '/api/block' && req.method === 'POST') {
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const { id, action, company, reason } = JSON.parse(body || '{}');
    try {
      if (action === 'block') {
        const r = blockJob(Number(id), reason || 'blocked by you');
        if (!r) return json(res, { error: 'not found' }, 404);
        emit({
          jobId: r.job.id, stage: 'control', level: 'warn',
          message: `Blocked — ${r.job.title} @ ${r.job.company} will not be applied to` +
            (r.cancelledDrafts ? ` (${r.cancelledDrafts} held draft(s) cancelled)` : ''),
        });
      } else if (action === 'unblock') {
        const r = unblockJob(Number(id));
        if (!r) return json(res, { error: 'not blocked' }, 400);
        emit({ jobId: r.job.id, stage: 'control', message: `Unblocked — back to "${r.restoredTo}"` });
      } else if (action === 'block-company') {
        const r = blockCompany(company, reason || 'blocked by you');
        emit({
          stage: 'control', level: 'warn',
          message: `Blocked ${r.company} — ${r.blocked} live job(s) pulled` +
            (r.cancelledDrafts ? `, ${r.cancelledDrafts} held draft(s) cancelled` : '') +
            '. Future postings from them are filtered at discovery.',
        });
      } else if (action === 'unblock-company') {
        if (!unblockCompany(company)) return json(res, { error: 'not blocked' }, 400);
        emit({ stage: 'control', message: `${company} unblocked — their postings will be considered again` });
      } else {
        return json(res, { error: 'action must be block, unblock, block-company or unblock-company' }, 400);
      }
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
    emitBoard();
    return json(res, { ok: true });
  }

  // Step screenshots from an application attempt.
  if (url.pathname === '/api/shot') {
    const p = path.resolve(url.searchParams.get('p') || '');
    if (!p.startsWith(path.resolve(PATHS.artifacts)) || !fs.existsSync(p)) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return fs.createReadStream(p).pipe(res);
  }

  // Tailored resume PDFs, so the drawer can preview exactly what would be sent.
  if (url.pathname === '/api/resume') {
    const job = db.prepare('SELECT resume_path FROM jobs WHERE id = ?').get(Number(url.searchParams.get('id')));
    const p = job?.resume_path && path.resolve(job.resume_path);
    if (!p || !p.startsWith(path.resolve(PATHS.artifacts)) || !fs.existsSync(p)) {
      res.writeHead(404); return res.end('No resume for this job');
    }
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${path.basename(p)}"` });
    return fs.createReadStream(p).pipe(res);
  }

  // Static dashboard
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.join(DASH, file);
  if (!full.startsWith(DASH) || !fs.existsSync(full)) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'text/plain' });
  fs.createReadStream(full).pipe(res);
});

// Live browser frames — separate channel from SSE because they're big and
// lossy-by-design: a dropped frame should never back up the event log.
const wss = new WebSocketServer({ server, path: '/live' });
bus.on('frame', data => {
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.bufferedAmount < 1_000_000) client.send(data);
  }
});

export function startServer() {
  return new Promise(resolve => {
    // Loopback only. This server takes an OpenAI key and Gmail credentials and
    // can fire off applications in your name — it has no auth because it is not
    // meant to be reachable from anywhere but this machine.
    server.listen(SERVER.port, '127.0.0.1', async () => {
      console.log(`\n  Dashboard → http://localhost:${SERVER.port}\n`);

      if (gmail.isConfigured()) gmailAddress = await gmail.profileAddress().catch(() => null);

      // The dashboard is the single owner of the browser profile. A browser
      // left over from a crashed run or a stray script would otherwise block
      // every stage that needs Chrome, so it is cleared on the way up.
      const { reclaimProfile, closeBrowserOnExit } = await import('./browser.js');
      closeBrowserOnExit();
      const reaped = reclaimProfile({ quiet: true });
      if (reaped) console.log(`  Cleared ${reaped} leftover browser process holding the profile.\n`);
      const missing = [
        secretsStatus().openai ? null : 'OpenAI key',
        gmail.isConfigured() ? null : 'Gmail',
      ].filter(Boolean);
      if (missing.length) console.log(`  Not set up yet: ${missing.join(', ')} — open the gear in the dashboard.\n`);

      // Drafts send themselves once the hold expires — cancelling is the action,
      // not sending. Running this here means the dashboard being open is what
      // keeps the outbox moving.
      setInterval(() => {
        flushOutbox().catch(err => emit({ stage: 'email', level: 'error', message: `Outbox flush failed: ${err.message}` }));

        // Silence is an outcome. Left unlabelled it is quietly excluded from
        // every response rate, which biases all of them upward.
        const timedOut = autoTimeoutOutcomes();
        if (timedOut) {
          emit({
            stage: 'outcome',
            message: `${timedOut} application(s) passed ${OUTCOME_TIMEOUT_DAYS} days with no reply — recorded as no response`,
          });
          emitBoard();
        }
      }, 60_000).unref?.();

      resolve(server);
    });
  });
}
