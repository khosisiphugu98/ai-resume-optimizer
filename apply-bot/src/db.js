import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, SEARCHES } from './config.js';
import { normaliseSkill } from './profile.js';

fs.mkdirSync(path.dirname(PATHS.db), { recursive: true });

export const db = new Database(PATHS.db);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id                 INTEGER PRIMARY KEY,
  source             TEXT NOT NULL DEFAULT 'linkedin',
  external_id        TEXT NOT NULL,
  url                TEXT,
  title              TEXT,
  company            TEXT,
  location           TEXT,
  workplace_type     TEXT,
  tier               TEXT,
  search_keywords    TEXT,
  posted_at          TEXT,
  discovered_at      TEXT NOT NULL,
  apply_type         TEXT,          -- easy_apply | external | email | unknown
  external_apply_url TEXT,
  ats_vendor         TEXT,
  apply_email        TEXT,
  jd_text            TEXT,
  fit_score          INTEGER,
  fit_rationale      TEXT,
  reject_reason      TEXT,
  parked_question    TEXT,
  parked_at          TEXT,
  status             TEXT NOT NULL DEFAULT 'new',
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_discovered ON jobs(discovered_at);

CREATE TABLE IF NOT EXISTS applications (
  id                     INTEGER PRIMARY KEY,
  job_id                 INTEGER NOT NULL REFERENCES jobs(id),
  channel                TEXT NOT NULL,   -- linkedin_easy | external_ats | email
  resume_path            TEXT,
  cover_letter_path      TEXT,
  ats_vendor             TEXT,
  adapter_used           TEXT,
  submitted_at           TEXT,
  confirmation_evidence  TEXT,
  outcome                TEXT             -- submitted|abandoned|blocked|error
);

CREATE TABLE IF NOT EXISTS answers (
  id             INTEGER PRIMARY KEY,
  question_norm  TEXT NOT NULL,
  question_raw   TEXT,
  field_type     TEXT,
  answer_value   TEXT,
  scope          TEXT NOT NULL DEFAULT 'global',
  source         TEXT,               -- profile | human | llm_approved
  confidence     REAL,
  times_used     INTEGER NOT NULL DEFAULT 0,
  last_used_at   TEXT,
  human_verified INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  UNIQUE (question_norm, scope)
);

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY,
  job_id          INTEGER REFERENCES jobs(id),
  ts              TEXT NOT NULL,
  stage           TEXT,
  level           TEXT NOT NULL DEFAULT 'info',
  message         TEXT,
  screenshot_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS rate_ledger (
  date                   TEXT PRIMARY KEY,
  linkedin_easy          INTEGER NOT NULL DEFAULT 0,
  external_ats           INTEGER NOT NULL DEFAULT 0,
  email                  INTEGER NOT NULL DEFAULT 0,
  linkedin_pageviews     INTEGER NOT NULL DEFAULT 0,
  challenges_hit         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Additive migrations. CREATE TABLE IF NOT EXISTS won't add columns to a table
// that already exists, so new columns go here.
function addColumn(table, name, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
}
addColumn('jobs', 'resume_path', 'TEXT');
addColumn('jobs', 'cover_letter_path', 'TEXT');
addColumn('jobs', 'tailored_at', 'TEXT');
// Where a blocked job came from, so unblocking puts it back in the pipeline at
// the stage it had reached rather than at the start.
addColumn('jobs', 'blocked_from', 'TEXT');
// How many times apply has tried this job. A single transient failure (a posting
// that was slow to render, a popup that lost the race) used to strand a job in
// apply_failed forever, because the apply queue only reads 'tailored'/'approved'.
// The apply stage now re-queues apply_failed jobs up to APPLY_MAX_ATTEMPTS.
addColumn('jobs', 'apply_attempts', 'INTEGER NOT NULL DEFAULT 0');
addColumn('applications', 'filled_json', 'TEXT');
addColumn('applications', 'screenshots_json', 'TEXT');
addColumn('applications', 'step_count', 'INTEGER');
// Guest-endpoint fetches are unauthenticated, so they carry no account risk and
// are counted apart from signed-in pageviews rather than against that cap.
addColumn('rate_ledger', 'guest_fetches', 'INTEGER NOT NULL DEFAULT 0');
// Below-threshold jobs deliberately let through to keep the calibration data from
// censoring itself (§8.6). Capped daily, so it needs a counter that resets.
addColumn('rate_ledger', 'audit_samples', 'INTEGER NOT NULL DEFAULT 0');
// What happened after an application went out (§8.2). `outcome` above is what the
// bot did; these are what the employer did, which is the only thing that can tell
// us whether the fit score predicts anything.
addColumn('applications', 'outcome_state', 'TEXT');
addColumn('applications', 'outcome_at', 'TEXT');
addColumn('applications', 'outcome_source', 'TEXT');
addColumn('applications', 'outcome_note', 'TEXT');

const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

const insertJob = db.prepare(`
  INSERT INTO jobs (source, external_id, url, title, company, location, tier,
                    search_keywords, discovered_at, apply_type, status)
  VALUES (@source, @external_id, @url, @title, @company, @location, @tier,
          @search_keywords, @discovered_at, @apply_type, 'new')
  ON CONFLICT (source, external_id) DO NOTHING`);

/** Returns the row id if newly inserted, or null if already known. */
export function upsertJob(job) {
  const res = insertJob.run({
    source: 'linkedin',
    apply_type: 'unknown',
    discovered_at: now(),
    tier: null,
    search_keywords: null,
    url: null, title: null, company: null, location: null,
    ...job,
  });
  return res.changes ? res.lastInsertRowid : null;
}

export function updateJob(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE jobs SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`)
    .run({ id, ...fields });
}

export function logEvent({ jobId = null, stage = null, level = 'info', message, screenshot = null }) {
  const info = db.prepare(
    `INSERT INTO events (job_id, ts, stage, level, message, screenshot_path)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(jobId, now(), stage, level, message, screenshot);
  return { id: info.lastInsertRowid, jobId, ts: now(), stage, level, message, screenshot };
}

export function bumpRate(column, by = 1) {
  db.prepare(`INSERT INTO rate_ledger (date) VALUES (?) ON CONFLICT(date) DO NOTHING`).run(today());
  db.prepare(`UPDATE rate_ledger SET ${column} = ${column} + ? WHERE date = ?`).run(by, today());
}

export function todayRates() {
  return db.prepare('SELECT * FROM rate_ledger WHERE date = ?').get(today())
    || { date: today(), linkedin_easy: 0, external_ats: 0, email: 0, linkedin_pageviews: 0,
         challenges_hit: 0, guest_fetches: 0, audit_samples: 0 };
}

// The three bulky terminal buckets grow without bound (discovery keeps adding to
// them), so a single LIMIT over all statuses lets them push the small, active
// pipeline statuses — tailored, apply_failed, awaiting_review — clean off the
// board. Those are exactly the ones the operator is watching. So: every
// non-bulk job is always returned in full, and only the bulk buckets are capped.
const BOARD_BULK_STATUSES = ['discovered', 'rejected', 'expired'];

export function boardSnapshot() {
  const cols = `id, title, company, location, tier, apply_type, ats_vendor, fit_score,
                reject_reason, parked_question, status, url, discovered_at`;
  const placeholders = BOARD_BULK_STATUSES.map(() => '?').join(',');

  const active = db.prepare(`
    SELECT ${cols} FROM jobs
    WHERE status NOT IN (${placeholders})
    ORDER BY discovered_at DESC`).all(...BOARD_BULK_STATUSES);

  const bulk = db.prepare(`
    SELECT ${cols} FROM jobs
    WHERE status IN (${placeholders})
    ORDER BY discovered_at DESC LIMIT 400`).all(...BOARD_BULK_STATUSES);

  const counts = db.prepare('SELECT status, COUNT(*) n FROM jobs GROUP BY status').all();
  return { jobs: [...active, ...bulk], counts, rates: todayRates() };
}

export function recentEvents(limit = 200) {
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit).reverse();
}

// ---------------------------------------------------------------------------
// Outcomes (§8.2). Deliberately ordinal: "rejected after a human read it" is a
// better signal than silence, because it means the application was at least
// parsed. Silence is data too — an unlabelled application biases every rate
// upward, so they time out rather than staying null forever.
// ---------------------------------------------------------------------------
export const OUTCOME_STATES = ['no_response', 'rejected', 'screen', 'interview', 'offer'];

/** Anything at or above `rejected` means a human engaged with the application. */
export const RESPONSE_STATES = ['rejected', 'screen', 'interview', 'offer'];

/** Days of silence after which an application is called a non-response. */
export const OUTCOME_TIMEOUT_DAYS = 45;

const DAY_MS = 864e5;

/**
 * Submitted applications still waiting on a verdict, oldest first.
 *
 * `minAgeDays` exists because asking about something sent this morning is noise —
 * nothing has had time to happen yet.
 */
export function pendingOutcomes({ minAgeDays = 7, limit = 100 } = {}) {
  const cutoff = new Date(Date.now() - minAgeDays * DAY_MS).toISOString();
  return db.prepare(`
    SELECT a.id, a.job_id, a.channel, a.ats_vendor, a.submitted_at,
           j.title, j.company, j.fit_score, j.tier, j.url,
           CAST(julianday('now') - julianday(a.submitted_at) AS INTEGER) AS age_days
    FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.outcome = 'submitted' AND a.submitted_at IS NOT NULL
      AND a.outcome_state IS NULL AND a.submitted_at <= ?
    ORDER BY a.submitted_at
    LIMIT ?`).all(cutoff, limit);
}

export function setOutcome(applicationId, { state, source = 'manual', note = null } = {}) {
  if (!OUTCOME_STATES.includes(state)) {
    throw new Error(`outcome must be one of: ${OUTCOME_STATES.join(', ')}`);
  }
  const r = db.prepare(`
    UPDATE applications SET outcome_state = ?, outcome_at = ?, outcome_source = ?,
           outcome_note = COALESCE(?, outcome_note)
    WHERE id = ?`).run(state, now(), source, note, applicationId);
  return r.changes > 0;
}

/**
 * An absence of a reply is data. Leaving it null biases every response rate
 * upward, because the denominator quietly excludes everything nobody answered.
 */
export function autoTimeoutOutcomes({ days = OUTCOME_TIMEOUT_DAYS } = {}) {
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
  return db.prepare(`
    UPDATE applications SET outcome_state = 'no_response', outcome_at = ?, outcome_source = 'timeout'
    WHERE outcome = 'submitted' AND submitted_at IS NOT NULL
      AND outcome_state IS NULL AND submitted_at < ?`).run(now(), cutoff).changes;
}

/** Headline counts for the Sent panel. Audit-sample rows are counted apart. */
export function outcomeSummary() {
  const row = db.prepare(`
    SELECT COUNT(*) AS submitted,
           SUM(CASE WHEN outcome_state IS NOT NULL THEN 1 ELSE 0 END) AS labelled,
           SUM(CASE WHEN outcome_state IN ('rejected','screen','interview','offer') THEN 1 ELSE 0 END) AS responses,
           SUM(CASE WHEN outcome_note LIKE 'audit sample%' THEN 1 ELSE 0 END) AS audit
    FROM applications WHERE outcome = 'submitted' AND submitted_at IS NOT NULL`).get();
  return {
    submitted: row.submitted || 0,
    labelled: row.labelled || 0,
    responses: row.responses || 0,
    audit: row.audit || 0,
    awaiting: (row.submitted || 0) - (row.labelled || 0),
  };
}

/**
 * The email channel sends through Gmail rather than a browser, so it has no
 * application row of its own. Without one it is invisible to calibration — and
 * email is the channel most likely to differ from the rest.
 */
export function recordEmailApplication({ jobId, resumePath, to, outboxId }) {
  // Carry the audit-sample marker onto the application row, exactly as recordAttempt
  // does for the browser channels — an audit-sample job sent by email would
  // otherwise land with outcome_note=NULL and be counted in the headline response
  // rate it was specifically meant to be held out of. 'audit sample' is
  // AUDIT.reason (score/index.js); the literal is used here to avoid a db→score
  // import, matching outcomeSummary()'s existing 'audit sample%' filter.
  const rejectReason = db.prepare('SELECT reject_reason FROM jobs WHERE id = ?').get(jobId)?.reject_reason;
  const note = rejectReason === 'audit sample' ? 'audit sample' : null;
  const info = db.prepare(`
    INSERT INTO applications (job_id, channel, resume_path, adapter_used, submitted_at,
                              confirmation_evidence, outcome, filled_json, screenshots_json, step_count, outcome_note)
    VALUES (?, 'email', ?, 'email:gmail', ?, ?, 'submitted', '[]', '[]', 1, ?)`)
    .run(jobId, resumePath || null, now(), `sent to ${to} (outbox ${outboxId})`, note);
  return info.lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Parked questions. A job can be blocked on several at once, so this is a table
// rather than a column on jobs.
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS parked_questions (
  id            INTEGER PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES jobs(id),
  question_norm TEXT NOT NULL,
  question_raw  TEXT NOT NULL,
  field_type    TEXT,
  options_json  TEXT,
  reason        TEXT,
  tier          TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (job_id, question_norm)
);
CREATE INDEX IF NOT EXISTS idx_parked_norm ON parked_questions(question_norm);
`);

export function parkQuestions(jobId, parked) {
  const stmt = db.prepare(`
    INSERT INTO parked_questions (job_id, question_norm, question_raw, field_type, options_json, reason, tier, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (job_id, question_norm) DO UPDATE SET reason = excluded.reason, tier = excluded.tier`);
  const ts = now();
  db.transaction(rows => {
    for (const p of rows) {
      stmt.run(jobId, p.questionNorm, p.question, p.fieldType || 'text',
               p.options ? JSON.stringify(p.options) : null, p.reason, p.tier, ts);
    }
  })(parked);
  db.prepare(`UPDATE jobs SET status = 'awaiting_answers', parked_question = ?, parked_at = ? WHERE id = ?`)
    .run(parked[0]?.question || null, ts, jobId);
}

/** Distinct blocking questions, most-blocking first — drives the dashboard queue. */
export function parkedQueue() {
  return db.prepare(`
    SELECT p.question_norm, p.question_raw, p.field_type, p.options_json, p.reason, p.tier,
           COUNT(DISTINCT p.job_id) AS blocking,
           GROUP_CONCAT(DISTINCT j.company) AS companies
    FROM parked_questions p
    JOIN jobs j ON j.id = p.job_id
    WHERE j.status = 'awaiting_answers'
    GROUP BY p.question_norm
    ORDER BY blocking DESC, p.id`).all();
}

/**
 * Answering one question releases every job that was only waiting on it — the
 * mechanism that makes the system more autonomous over time (§1).
 * Returns the job ids that moved back into the pipeline.
 */
export function releaseAnswered(questionNorm) {
  db.prepare('DELETE FROM parked_questions WHERE question_norm = ?').run(questionNorm);
  const freed = db.prepare(`
    SELECT j.id FROM jobs j
    WHERE j.status = 'awaiting_answers'
      AND NOT EXISTS (SELECT 1 FROM parked_questions p WHERE p.job_id = j.id)`).all().map(r => r.id);
  if (freed.length) {
    db.prepare(`UPDATE jobs SET status = 'scored', parked_question = NULL, parked_at = NULL
                WHERE id IN (${freed.map(() => '?').join(',')})`).run(...freed);
  }
  return freed;
}

// ---------------------------------------------------------------------------
// Skill suggestions. When tailoring, the optimiser reports skills a job asked for
// that the candidate has NOT confirmed in the profile. They are never added to the
// resume — they queue here so the candidate can confirm the ones that are actually
// true (which then flow into future tailoring) or dismiss the noise for good.
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS skill_suggestions (
  skill_norm  TEXT PRIMARY KEY,
  display     TEXT NOT NULL,
  job_count   INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending|dismissed
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);`);

// One canonical skill normaliser, shared with profile.js — it carries the alias map
// (ga4/gtm/js…), so a suggestion for "Google Analytics" dedups against, and is
// suppressed by, an already-confirmed "GA4". A separate local normaliser here would
// silently disagree and nag the operator to confirm a skill they already hold.
const normSkill = normaliseSkill;

/**
 * Record skills a job wanted but the candidate hasn't confirmed. Upserts by
 * normalised name, bumping the per-skill job count (the volume signal the
 * dashboard sorts by). A dismissed skill stays dismissed — it is not resurrected
 * just because another posting mentions it. Returns how many rows were newly
 * created as pending suggestions.
 */
export function recordSkillSuggestions(skills) {
  if (!Array.isArray(skills) || skills.length === 0) return 0;
  const ts = now();
  const upsert = db.prepare(`
    INSERT INTO skill_suggestions (skill_norm, display, job_count, status, first_seen, last_seen)
    VALUES (@norm, @display, 1, 'pending', @ts, @ts)
    ON CONFLICT (skill_norm) DO UPDATE SET
      job_count = job_count + 1,
      last_seen = @ts`);
  const isNew = db.prepare(`SELECT 1 FROM skill_suggestions WHERE skill_norm = ?`);
  let created = 0;
  db.transaction(rows => {
    for (const raw of rows) {
      const norm = normSkill(raw);
      if (!norm) continue;
      const existed = isNew.get(norm);
      upsert.run({ norm, display: String(raw).trim(), ts });
      if (!existed) created++;
    }
  })(skills);
  return created;
}

/** Pending suggestions, most-wanted first. Optionally hide ones already confirmed. */
export function listSkillSuggestions(excludeNorms = []) {
  const exclude = new Set(excludeNorms.map(normSkill));
  return db.prepare(`
    SELECT skill_norm, display, job_count FROM skill_suggestions
    WHERE status = 'pending' ORDER BY job_count DESC, display`)
    .all()
    .filter(r => !exclude.has(r.skill_norm));
}

export function dismissSkillSuggestion(skill) {
  return db.prepare(`UPDATE skill_suggestions SET status = 'dismissed' WHERE skill_norm = ?`)
    .run(normSkill(skill)).changes > 0;
}

/** Drop a suggestion once it's been confirmed into the profile. */
export function removeSkillSuggestion(skill) {
  return db.prepare(`DELETE FROM skill_suggestions WHERE skill_norm = ?`)
    .run(normSkill(skill)).changes > 0;
}

// ---------------------------------------------------------------------------
// Outbox. Email is the one irreversible channel — there is no unsend and the
// recipient is a named human — so drafts sit here briefly and auto-send unless
// cancelled.
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS outbox (
  id               INTEGER PRIMARY KEY,
  job_id           INTEGER NOT NULL REFERENCES jobs(id),
  to_addr          TEXT NOT NULL,
  cc_addr          TEXT,
  subject          TEXT NOT NULL,
  body             TEXT NOT NULL,
  attachments_json TEXT,
  reference_number TEXT,
  created_at       TEXT NOT NULL,
  send_after       TEXT NOT NULL,
  sent_at          TEXT,
  cancelled_at     TEXT,
  status           TEXT NOT NULL DEFAULT 'held',   -- held|sent|cancelled|failed
  error            TEXT,
  gmail_message_id TEXT,
  gmail_thread_id  TEXT,
  reply_state      TEXT                            -- replied|rejected|interview
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
`);

export function queueEmail(draft) {
  const ts = now();
  const info = db.prepare(`
    INSERT INTO outbox (job_id, to_addr, cc_addr, subject, body, attachments_json,
                        reference_number, created_at, send_after, status)
    VALUES (@job_id, @to, @cc, @subject, @body, @attachments, @ref, @now, @sendAfter, 'held')`).run({
    job_id: draft.jobId,
    to: draft.to,
    cc: (draft.cc || []).join(', ') || null,
    subject: draft.subject,
    body: draft.body,
    attachments: JSON.stringify(draft.attachments || []),
    ref: draft.referenceNumber || null,
    now: ts,
    sendAfter: draft.sendAfter,
  });
  return info.lastInsertRowid;
}

export function outboxPending() {
  return db.prepare(`SELECT * FROM outbox WHERE status = 'held' ORDER BY send_after`).all();
}

export function outboxDue() {
  return db.prepare(`SELECT * FROM outbox WHERE status = 'held' AND send_after <= ? ORDER BY send_after`).all(now());
}

export function cancelEmail(id) {
  const r = db.prepare(`UPDATE outbox SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'held'`)
    .run(now(), id);
  return r.changes > 0;
}

export function markEmailSent(id, { messageId, threadId }) {
  db.prepare(`UPDATE outbox SET status = 'sent', sent_at = ?, gmail_message_id = ?, gmail_thread_id = ? WHERE id = ?`)
    .run(now(), messageId, threadId, id);
}

export function markEmailFailed(id, error) {
  db.prepare(`UPDATE outbox SET status = 'failed', error = ? WHERE id = ?`).run(String(error).slice(0, 400), id);
}

// ---------------------------------------------------------------------------
// Saved searches. These live in the database rather than config.js because they
// are the one knob worth turning weekly: a search that returns nothing useful
// costs a pageview off the daily cap every run, and a title you have not thought
// of yet is the difference between a thin board and a full one.
//
// config.SEARCHES is the seed, not the source of truth — it populates the table
// once and is never read again.
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS searches (
  id         INTEGER PRIMARY KEY,
  keywords   TEXT NOT NULL,
  location   TEXT NOT NULL,
  tier       TEXT NOT NULL DEFAULT 'B',
  remote     INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (keywords, location)
);
`);

// Seeded once, tracked by a flag rather than by row count — deleting every
// search is a decision, and re-seeding on the next boot would silently undo it.
if (!getSetting('searches_seeded')) {
  const stmt = db.prepare(`
    INSERT INTO searches (keywords, location, tier, remote, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (keywords, location) DO NOTHING`);
  db.transaction(() => {
    for (const s of SEARCHES) stmt.run(s.keywords, s.location, s.tier, s.remote ? 1 : 0, now());
  })();
  setSetting('searches_seeded', '1');
}

/** Every search with how many jobs it has ever turned up — drives the panel. */
export function allSearches() {
  return db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM jobs j WHERE j.search_keywords = s.keywords) AS found
    FROM searches s
    ORDER BY s.tier, s.keywords`).all();
}

/** The shape runDiscovery consumes. Disabled searches are skipped, not deleted. */
export function activeSearches() {
  return db.prepare('SELECT * FROM searches WHERE enabled = 1 ORDER BY tier, id').all()
    .map(s => ({ tier: s.tier, keywords: s.keywords, location: s.location, remote: !!s.remote }));
}

export function addSearch({ keywords, location, tier = 'B', remote = false }) {
  const k = String(keywords || '').trim();
  const l = String(location || '').trim();
  if (!k) throw new Error('a job title or keyword is required');
  if (!l) throw new Error('a location is required');
  const r = db.prepare(`
    INSERT INTO searches (keywords, location, tier, remote, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (keywords, location) DO NOTHING`)
    .run(k, l, tier, remote ? 1 : 0, now());
  if (!r.changes) throw new Error(`"${k}" in ${l} is already on the list`);
  return { id: r.lastInsertRowid, keywords: k, location: l, tier, remote: !!remote };
}

export function setSearchEnabled(id, enabled) {
  db.prepare('UPDATE searches SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return db.prepare('SELECT * FROM searches WHERE id = ?').get(id);
}

export function deleteSearch(id) {
  const row = db.prepare('SELECT * FROM searches WHERE id = ?').get(id);
  db.prepare('DELETE FROM searches WHERE id = ?').run(id);
  return row;
}

// ---------------------------------------------------------------------------
// Blocking. Two kinds, both meaning "this must never go out".
//
// A blocked job keeps its row and its tailored resume — blocking is a veto on
// sending, not a delete, so it can be taken back. Anything already drafted into
// the outbox for it is cancelled, because a held draft sends itself.
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS blocked_companies (
  company_norm TEXT PRIMARY KEY,
  company      TEXT NOT NULL,
  reason       TEXT,
  created_at   TEXT NOT NULL
);
`);

const normCompany = c => String(c || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Statuses a block can rescue a job from. Already-submitted is too late. */
const BLOCKABLE = ['new', 'discovered', 'enriched', 'scored', 'tailored', 'approved',
                   'awaiting_review', 'awaiting_answers', 'outbox', 'applying'];

export function blockJob(id, reason = 'blocked by you') {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return null;
  if (job.status === 'blocked') return { job, cancelledDrafts: 0, alreadyBlocked: true };
  if (!BLOCKABLE.includes(job.status)) {
    throw new Error(`too late — this one is already "${job.status}"`);
  }

  // A held draft sends itself when the hold expires, so blocking has to reach
  // into the outbox or the block is cosmetic.
  const cancelled = db.prepare(
    `UPDATE outbox SET status = 'cancelled', cancelled_at = ? WHERE job_id = ? AND status = 'held'`)
    .run(now(), id).changes;

  db.prepare(`UPDATE jobs SET status = 'blocked', blocked_from = ?, reject_reason = ? WHERE id = ?`)
    .run(job.status, reason, id);

  return { job, cancelledDrafts: cancelled };
}

export function unblockJob(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job || job.status !== 'blocked') return null;
  // Back to where it was. A cancelled draft is not resurrected — re-running the
  // email stage drafts a fresh one against the current posting.
  const to = job.blocked_from && job.blocked_from !== 'outbox' ? job.blocked_from : 'tailored';
  db.prepare(`UPDATE jobs SET status = ?, blocked_from = NULL, reject_reason = NULL WHERE id = ?`)
    .run(to, id);
  return { job, restoredTo: to };
}

/**
 * Reverse a rejection. Puts a job back as far along as its data has earned, so it
 * resumes rather than restarts:
 *   - a fit-threshold rejection → 'scored'. This is the operator overriding a soft
 *     gate: the job scored below the line, and re-scoring would only reproduce that,
 *     so it resumes at 'scored' and proceeds.
 *   - anything else → back into the pipeline for a fresh look: 'enriched' if its JD
 *     was fetched, otherwise 'discovered' to fetch it first. A hard blocker (a
 *     missing qualification, a work-authorisation wall) is re-evaluated on the next
 *     scoring run rather than bypassed straight into the auto-apply path — it too
 *     carries a fit_score, so it must not be mistaken for a threshold override.
 * A job whose company is still blocked is refused: it would otherwise slip past the
 * veto, since scoring and apply don't re-check the blocklist. Unblock the company
 * instead. Returns null if the job isn't rejected.
 */
export function unrejectJob(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job || job.status !== 'rejected') return null;
  if (isCompanyBlocked(job.company)) {
    throw new Error(`${job.company} is blocked — unblock the company to consider its jobs again`);
  }
  const fitThreshold = /^fit\s/.test(job.reject_reason || '');   // "fit 40 < 65" — score/index.js
  const to = fitThreshold ? 'scored'
           : job.jd_text ? 'enriched'
           : 'discovered';
  db.prepare(`UPDATE jobs SET status = ?, reject_reason = NULL WHERE id = ?`).run(to, id);
  return { job, restoredTo: to };
}

/** Blocks the company and sweeps every live job already on the board for it. */
export function blockCompany(company, reason = 'blocked by you') {
  const norm = normCompany(company);
  if (!norm) throw new Error('no company name to block');
  db.prepare(`INSERT INTO blocked_companies (company_norm, company, reason, created_at)
              VALUES (?, ?, ?, ?) ON CONFLICT(company_norm) DO NOTHING`)
    .run(norm, String(company).trim(), reason, now());

  const live = db.prepare(
    `SELECT id FROM jobs WHERE LOWER(TRIM(company)) = ? AND status IN (${BLOCKABLE.map(() => '?').join(',')})`)
    .all(norm, ...BLOCKABLE);
  let cancelledDrafts = 0;
  for (const { id } of live) cancelledDrafts += blockJob(id, reason)?.cancelledDrafts || 0;
  return { company: String(company).trim(), blocked: live.length, cancelledDrafts };
}

export function unblockCompany(company) {
  const norm = normCompany(company);
  return db.prepare('DELETE FROM blocked_companies WHERE company_norm = ?').run(norm).changes > 0;
}

export function isCompanyBlocked(company) {
  const norm = normCompany(company);
  if (!norm) return false;
  return !!db.prepare('SELECT 1 FROM blocked_companies WHERE company_norm = ?').get(norm);
}

export function blockedCompanies() {
  return db.prepare(`
    SELECT b.*, (SELECT COUNT(*) FROM jobs j WHERE LOWER(TRIM(j.company)) = b.company_norm) AS jobs
    FROM blocked_companies b ORDER BY b.company`).all();
}

/** Postings go cold. Parked-forever is not a state worth keeping. */
export function expireStaleParked(days = 14) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  return db.prepare(`UPDATE jobs SET status = 'expired'
                     WHERE status = 'awaiting_answers' AND parked_at < ?`).run(cutoff).changes;
}

// ---------------------------------------------------------------------------
// Adaptive agent, Phase 1 — capture (docs/APPLY_BOT_ADAPTIVE_AGENT_PHASE1.md).
//
// A raw *observation* of an unknown application page at the moment it defeated
// the deterministic flow (no form found, no fillable fields, or a wizard that
// would not advance). This is the dataset the LLM planner (Phase 2) is built
// against — deliberately separate from the future `page_plans` cache, which
// holds *solved, replayable* structures rather than failures.
//
// Keyed by a host+control fingerprint and upserted: the auto loop re-hits the
// same dead postings on every cycle, and appending a row each time would bury
// the distinct shapes we actually want to see under duplicates.
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS page_captures (
  id              INTEGER PRIMARY KEY,
  -- Soft pointer, not a foreign key: a capture is an observational log entry and
  -- must not be blocked (or cascade-deleted) by the referenced job's lifecycle.
  job_id          INTEGER,
  captured_at     TEXT NOT NULL,
  first_seen_at   TEXT NOT NULL,
  vendor          TEXT,
  host            TEXT,
  url             TEXT,
  title           TEXT,
  fingerprint     TEXT NOT NULL,
  failure_stage   TEXT,
  failure_reason  TEXT,
  control_count   INTEGER,
  snapshot_path   TEXT,
  screenshot_path TEXT,
  seen_count      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_page_captures_fp ON page_captures(fingerprint);
`);

/**
 * Insert a capture, or bump the one already recorded for this fingerprint.
 * Returns the row id either way, so the caller can name the snapshot files
 * after it and (on a repeat) overwrite the previous ones in place.
 */
export function upsertPageCapture({ jobId = null, vendor = null, host = null, url = null,
                                    title = null, fingerprint, failureStage = null,
                                    failureReason = null, controlCount = null }) {
  const existing = db.prepare('SELECT id FROM page_captures WHERE fingerprint = ?').get(fingerprint);
  if (existing) {
    db.prepare(`
      UPDATE page_captures SET
        captured_at = @now, job_id = @jobId, vendor = @vendor, host = @host, url = @url,
        title = @title, failure_stage = @failureStage, failure_reason = @failureReason,
        control_count = @controlCount, seen_count = seen_count + 1
      WHERE id = @id`).run({
      id: existing.id, now: now(), jobId, vendor, host, url, title,
      failureStage, failureReason, controlCount,
    });
    return existing.id;
  }
  const info = db.prepare(`
    INSERT INTO page_captures (job_id, captured_at, first_seen_at, vendor, host, url, title,
                              fingerprint, failure_stage, failure_reason, control_count)
    VALUES (@jobId, @now, @now, @vendor, @host, @url, @title, @fingerprint,
            @failureStage, @failureReason, @controlCount)`).run({
    jobId, now: now(), vendor, host, url, title, fingerprint,
    failureStage, failureReason, controlCount,
  });
  return info.lastInsertRowid;
}

/** Record where the snapshot JSON and screenshot for a capture were written. */
export function setCapturePaths(id, snapshotPath, screenshotPath) {
  db.prepare('UPDATE page_captures SET snapshot_path = ?, screenshot_path = ? WHERE id = ?')
    .run(snapshotPath, screenshotPath, id);
}

/** Distinct captured page shapes, newest first — the `npm run captures` view. */
export function listPageCaptures({ limit = 200 } = {}) {
  return db.prepare(`
    SELECT id, host, vendor, failure_stage, control_count, seen_count,
           captured_at, first_seen_at, fingerprint, title, url
    FROM page_captures ORDER BY captured_at DESC LIMIT ?`).all(limit);
}
