import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';

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
    || { date: today(), linkedin_easy: 0, external_ats: 0, email: 0, linkedin_pageviews: 0, challenges_hit: 0 };
}

export function boardSnapshot() {
  const jobs = db.prepare(`
    SELECT id, title, company, location, tier, apply_type, ats_vendor, fit_score,
           reject_reason, parked_question, status, url, discovered_at
    FROM jobs ORDER BY discovered_at DESC LIMIT 400`).all();
  const counts = db.prepare('SELECT status, COUNT(*) n FROM jobs GROUP BY status').all();
  return { jobs, counts, rates: todayRates() };
}

export function recentEvents(limit = 200) {
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit).reverse();
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

/** Postings go cold. Parked-forever is not a state worth keeping. */
export function expireStaleParked(days = 14) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  return db.prepare(`UPDATE jobs SET status = 'expired'
                     WHERE status = 'awaiting_answers' AND parked_at < ?`).run(cutoff).changes;
}
