/**
 * Scoring calibration against real outcomes (§8.3).
 *
 * The question this exists to answer is narrow: does the fit score predict
 * whether anyone replies? `THRESHOLD = 65` was picked out of the air, and so was
 * `worthScoring`'s `hits.length >= 2` gate. Neither has ever been checked.
 *
 * The failure mode here is not a wrong number, it is a confident one. A response
 * rate computed from nine applications is noise wearing a percentage sign, and a
 * threshold tuned on it will be worse than the guess it replaced. So:
 *
 * - every rate carries a Wilson interval, because "22%" and "2 of 9" are the same
 *   fact and only one of them is honest;
 * - a bucket under `minSample` is suppressed rather than displayed as 0%;
 * - the report says outright when there is not enough data, which is the expected
 *   answer for a long time.
 *
 * And the structural problem, which no amount of statistics fixes on its own:
 * the threshold decides what gets applied to, which decides the data used to set
 * the threshold. Jobs below it are never observed, so false negatives are
 * invisible and the number drifts upward forever on evidence that only looks good
 * because everything beneath it was never tried. The audit sample (§8.6) is the
 * only thing that makes the sweep below the threshold mean anything, so the
 * report refuses to recommend a move upward without it.
 */
import { db, RESPONSE_STATES } from '../db.js';

/** 95% two-sided. */
const Z = 1.959963985;

/**
 * Wilson score interval for a binomial proportion.
 *
 * Not the textbook normal approximation: at the rates this system sees — 2–8%
 * responses on tens of applications — that one produces intervals that include
 * negative probabilities. Wilson stays inside [0, 1] and stays honest at small n,
 * which is the only regime this report will run in for months.
 */
export function wilson(successes, n, z = Z) {
  if (!n) return { rate: null, low: 0, high: 1, n: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    rate: p,
    low: Math.max(0, centre - margin),
    high: Math.min(1, centre + margin),
    n,
    successes,
  };
}

const responded = row => RESPONSE_STATES.includes(row.outcome_state);
const isAudit = row => /^audit sample/.test(row.outcome_note || '');

/** Every labelled application, with the job facts a breakdown might slice by. */
export function labelledApplications() {
  return db.prepare(`
    SELECT a.id, a.channel, a.ats_vendor, a.submitted_at, a.outcome_state,
           a.outcome_at, a.outcome_source, a.outcome_note,
           j.fit_score, j.tier, j.search_keywords, j.company, j.title
    FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.outcome = 'submitted' AND a.outcome_state IS NOT NULL
    ORDER BY a.submitted_at`).all();
}

/**
 * Group rows and report a rate per group, suppressing anything too small to read.
 *
 * Showing "0%" for a group of three is worse than showing nothing: it looks like
 * a finding, and it is the single most likely way this report misleads its owner.
 */
function breakdown(rows, keyOf, minSample) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key == null || key === '') continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const n = group.length;
      const hits = group.filter(responded).length;
      const suppressed = n < minSample;
      return {
        key,
        n,
        responses: hits,
        suppressed,
        ...(suppressed ? { rate: null, low: null, high: null } : wilson(hits, n)),
      };
    })
    .sort((a, b) => b.n - a.n);
}

const BUCKET_SIZE = 10;
const bucketOf = score => Math.floor(Math.max(0, Math.min(99, score)) / BUCKET_SIZE) * BUCKET_SIZE;

/**
 * Sweep candidate thresholds over the labelled set.
 *
 * `missed` is the column that matters. A threshold set too high discards good
 * jobs silently — the only evidence is a thin pipeline that looks like a quiet
 * week — so the expensive error is the one that never shows up in the response
 * rate at all.
 */
export function thresholdSweep(rows, { from = 40, to = 90, step = 5 } = {}) {
  const usable = rows.filter(r => typeof r.fit_score === 'number');
  const sweep = [];

  for (let threshold = from; threshold <= to; threshold += step) {
    const above = usable.filter(r => r.fit_score >= threshold);
    const below = usable.filter(r => r.fit_score < threshold);
    const captured = above.filter(responded).length;
    const missed = below.filter(responded).length;

    sweep.push({
      threshold,
      sent: above.length,
      captured,
      missed,
      ...(above.length ? wilson(captured, above.length) : { rate: null, low: null, high: null, n: 0 }),
    });
  }
  return sweep;
}

/** Which profile gaps cost the most volume — the cheapest thing to act on. */
export function parkedByQuestion(limit = 10) {
  return db.prepare(`
    SELECT question_raw AS question, COUNT(DISTINCT job_id) AS blocked,
           MAX(reason) AS reason
    FROM parked_questions
    GROUP BY question_norm
    ORDER BY blocked DESC, question_raw
    LIMIT ?`).all(limit);
}

/** How long a reply actually takes, so the timeout is set on evidence. */
function timeToResponse(rows) {
  const days = rows
    .filter(r => responded(r) && r.submitted_at && r.outcome_at)
    .map(r => (new Date(r.outcome_at) - new Date(r.submitted_at)) / 864e5)
    .filter(d => d >= 0)
    .sort((a, b) => a - b);

  if (!days.length) return { n: 0, median: null, p90: null };
  const at = q => days[Math.min(days.length - 1, Math.floor(q * days.length))];
  return {
    n: days.length,
    median: Math.round(at(0.5)),
    p90: Math.round(at(0.9)),
    max: Math.round(days.at(-1)),
  };
}

/**
 * The full report.
 *
 * `minTotal` is not a formality. At a 5% base rate with 40 applications, one
 * extra reply moves the headline by 2.5 points — so below that, every difference
 * between buckets is noise, and the report says so instead of ranking them.
 */
export function calibrationReport({ minSample = 8, minTotal = 40 } = {}) {
  const all = labelledApplications();

  // Audit-sample applications were sent *because* they scored below the
  // threshold, so mixing them into the headline would drag it down and make the
  // scorer look worse than it is. They are the control group, reported apart.
  const audit = all.filter(isAudit);
  const main = all.filter(r => !isAudit(r));

  const responses = main.filter(responded).length;
  const headline = wilson(responses, main.length);

  const pending = db.prepare(`
    SELECT COUNT(*) n FROM applications
    WHERE outcome = 'submitted' AND outcome_state IS NULL`).get().n;

  const auditResponses = audit.filter(responded).length;

  return {
    minSample,
    minTotal,
    labelled: main.length,
    awaiting: pending,
    responses,
    headline: main.length ? headline : { rate: null, low: null, high: null, n: 0 },

    // The honest answer for a long while. Everything below is still rendered,
    // but the dashboard leads with this rather than with a ranking.
    ready: main.length >= minTotal,
    verdict: verdictFor(main, responses, minTotal, audit),

    buckets: breakdown(main.filter(r => typeof r.fit_score === 'number'),
      r => bucketOf(r.fit_score), minSample)
      .map(b => ({ ...b, label: `${b.key}–${b.key + BUCKET_SIZE - 1}` }))
      .sort((a, b) => a.key - b.key),

    byTier: breakdown(main, r => r.tier, minSample),
    byChannel: breakdown(main, r => r.channel, minSample),
    byVendor: breakdown(main, r => r.ats_vendor, minSample),
    bySearch: breakdown(main, r => r.search_keywords, minSample),

    sweep: thresholdSweep(main.concat(audit)),
    // The sweep is only trustworthy below the current threshold where audit
    // samples exist. Without them, "missed" is structurally zero and the sweep
    // will recommend raising the threshold forever.
    sweepCensored: audit.length === 0,

    audit: {
      n: audit.length,
      responses: auditResponses,
      ...(audit.length ? wilson(auditResponses, audit.length) : { rate: null, low: null, high: null }),
    },

    parked: parkedByQuestion(),
    timing: timeToResponse(main),
  };
}

/**
 * A written answer to "does fit score predict response for this candidate?".
 *
 * "Not enough data yet" is a legitimate answer and the likely one, so it is
 * spelled out rather than left for the reader to infer from an empty table.
 */
function verdictFor(rows, responses, minTotal, audit) {
  if (!rows.length) {
    return 'No labelled outcomes yet. Mark results in the Sent panel as they come in — ' +
      'nothing here can be answered until roughly ' + minTotal + ' applications have verdicts.';
  }
  if (rows.length < minTotal) {
    return `Not enough data yet: ${rows.length} of ${minTotal} labelled applications. ` +
      `Differences between buckets at this sample size are noise. Do not move the threshold.`;
  }

  const scored = rows.filter(r => typeof r.fit_score === 'number');
  const high = scored.filter(r => r.fit_score >= 75);
  const low = scored.filter(r => r.fit_score < 75);
  if (high.length < 8 || low.length < 8) {
    return `${rows.length} labelled, but the scores are bunched — there is no spread to compare. ` +
      `Nothing can be concluded about whether the score is predictive.`;
  }

  const a = wilson(high.filter(responded).length, high.length);
  const b = wilson(low.filter(responded).length, low.length);
  const separated = a.low > b.high || b.low > a.high;

  if (!separated) {
    return `${rows.length} labelled at a ${(responses / rows.length * 100).toFixed(1)}% response rate. ` +
      `High-scoring and low-scoring applications have overlapping intervals ` +
      `(${(a.rate * 100).toFixed(0)}% vs ${(b.rate * 100).toFixed(0)}%), so the fit score is ` +
      `not yet shown to predict a response. Keep collecting.`;
  }

  const direction = a.rate > b.rate ? 'higher' : 'lower';
  return `${rows.length} labelled. Applications scoring 75+ respond at ` +
    `${(a.rate * 100).toFixed(0)}% versus ${(b.rate * 100).toFixed(0)}% below it, and the intervals ` +
    `do not overlap — the fit score does appear to predict a response, with ${direction} scores doing better.` +
    (audit.length ? '' : ' Note: no audit samples yet, so the sweep below the threshold is censored.');
}

/**
 * Few-shot examples for the scoring prompt, drawn from what actually converted
 * (§8.7).
 *
 * Grounds the model in this candidate's real results rather than generic notions
 * of fit. Kept in `settings` so it can be regenerated without a code change.
 */
export function buildFewShot({ perClass = 3, minTotal = 20 } = {}) {
  const rows = labelledApplications().filter(r => !isAudit(r));
  if (rows.length < minTotal) return null;

  const pick = (filter, label) => rows.filter(filter).slice(0, perClass).map(r => ({
    label,
    title: r.title,
    company: r.company,
    score: r.fit_score,
  }));

  const good = pick(r => ['interview', 'offer', 'screen'].includes(r.outcome_state), 'got a response');
  const bad = pick(r => r.outcome_state === 'no_response', 'heard nothing back');
  if (!good.length || !bad.length) return null;

  return { generatedAt: new Date().toISOString(), examples: [...good, ...bad] };
}
