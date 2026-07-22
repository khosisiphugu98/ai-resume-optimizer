import { db } from '../db.js';

/**
 * Cache key for a question. Aggressive on purpose — the same question phrased
 * three ways across three ATS platforms should hit one row.
 */
export function normaliseQuestion(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/\*/g, '')                       // required markers
    .replace(/\(.*?\)/g, ' ')                 // "(optional)", "(in years)"
    .replace(/[^a-z0-9+#\s]/g, ' ')
    .replace(/\b(please|kindly|do you|are you|have you|what is|whats|tell us|briefly)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = s => new Set(normaliseQuestion(s).split(' ').filter(w => w.length > 2));

/**
 * Token-set cosine similarity. Local and deterministic — no embedding call, so
 * it is cheap and unit-testable. Embeddings are the upgrade path if this proves
 * too blunt in practice.
 */
export function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.sqrt(A.size * B.size);
}

export const FUZZY_THRESHOLD = 0.85;

/** Exact hit, most specific scope first: company → ats → global. */
export function lookupExact(question, { company, ats } = {}) {
  const norm = normaliseQuestion(question);
  const scopes = [company && `company:${company}`, ats && `ats:${ats}`, 'global'].filter(Boolean);
  for (const scope of scopes) {
    const row = db.prepare('SELECT * FROM answers WHERE question_norm = ? AND scope = ?').get(norm, scope);
    if (row) return { ...row, matchType: 'exact' };
  }
  return null;
}

/** Near hit. Surfaced as "probable match" — never applied silently. */
export function lookupFuzzy(question, { company, ats } = {}) {
  const scopes = [company && `company:${company}`, ats && `ats:${ats}`, 'global'].filter(Boolean);
  const rows = db.prepare(
    `SELECT * FROM answers WHERE scope IN (${scopes.map(() => '?').join(',')})`
  ).all(...scopes);

  let best = null;
  for (const row of rows) {
    const score = similarity(question, row.question_raw || row.question_norm);
    if (score >= FUZZY_THRESHOLD && (!best || score > best.similarity)) {
      best = { ...row, similarity: score, matchType: 'fuzzy' };
    }
  }
  return best;
}

export function saveAnswer({ question, fieldType = 'text', value, scope = 'global', source, confidence = 1, humanVerified = 0 }) {
  const norm = normaliseQuestion(question);
  db.prepare(`
    INSERT INTO answers (question_norm, question_raw, field_type, answer_value, scope,
                         source, confidence, human_verified, created_at)
    VALUES (@norm, @raw, @type, @value, @scope, @source, @confidence, @verified, @now)
    ON CONFLICT (question_norm, scope) DO UPDATE SET
      answer_value   = excluded.answer_value,
      source         = excluded.source,
      confidence     = excluded.confidence,
      human_verified = excluded.human_verified
  `).run({
    norm, raw: question, type: fieldType, value: String(value), scope,
    source, confidence, verified: humanVerified, now: new Date().toISOString(),
  });
  return norm;
}

// The bank stores a field type it can render a form control from; the `filled`
// rows an application records carry the DOM kind instead.
const FIELD_TYPE = { input: 'text', select: 'select', radio: 'radio', checkbox: 'checkbox' };

/**
 * Approving a reviewed application is a human verifying its answers, so it has to
 * teach the bank (plan §3.7).
 *
 * Without this the bank only ever learns from questions that *parked*, and review
 * load never falls for the ones the model answered plausibly — the operator
 * re-approves the same "why do you want to work here" phrasing forever.
 *
 * Only drafted answers are worth storing. `profile` values are already
 * deterministic and would duplicate, `prefilled` came from the board itself, and
 * a file upload is not an answer. A `probable` (fuzzy) hit is promoted to an
 * exact one under the phrasing that was actually asked.
 *
 * Returns how many answers were learned.
 */
export function learnFromApproved(filled, { scope = 'global' } = {}) {
  let learned = 0;

  for (const f of filled || []) {
    if (f.tier !== 'llm' && !f.probable) continue;
    if (!f.question || f.value == null || f.value === '') continue;

    // An answer the operator typed by hand outranks one they merely waved
    // through, so approving never overwrites it.
    const existing = db.prepare('SELECT source FROM answers WHERE question_norm = ? AND scope = ?')
      .get(normaliseQuestion(f.question), scope);
    if (existing?.source === 'human') continue;

    saveAnswer({
      question: f.question,
      value: f.value,
      fieldType: FIELD_TYPE[f.kind] || 'text',
      scope,
      source: 'llm_approved',
      humanVerified: 1,
    });
    learned++;
  }

  return learned;
}

export function recordUse(id) {
  db.prepare('UPDATE answers SET times_used = times_used + 1, last_used_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

export function allAnswers() {
  return db.prepare('SELECT * FROM answers ORDER BY times_used DESC, id DESC').all();
}
