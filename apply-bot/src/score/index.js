import { db, updateJob, getSetting, setSetting, bumpRate, todayRates } from '../db.js';
import { emit, emitBoard } from '../bus.js';
import { loadProfile, summariseForLLM, normaliseSkill } from '../profile.js';
import { callLLM, hasKey } from '../llm.js';

/** The number that was picked out of the air. Now only the default (§8.4). */
export const THRESHOLD = 65;

/**
 * The threshold in force. Lives in `settings` so the operator can move it from
 * the dashboard once the calibration report gives them a reason to — retuning
 * should not require editing a source file and restarting.
 */
export function currentThreshold() {
  const stored = Number(getSetting('fit_threshold'));
  return Number.isFinite(stored) && stored > 0 && stored <= 100 ? stored : THRESHOLD;
}

export function setThreshold(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('threshold must be between 0 and 100');
  setSetting('fit_threshold', n);
  return n;
}

// --- audit sampling (§8.6) --------------------------------------------------
//
// The threshold decides what gets applied to, which decides the data used to set
// the threshold. Jobs below it are never observed, so a false negative leaves no
// trace anywhere — and a report built only on jobs that cleared the bar will
// happily recommend raising it, forever, on evidence that looks good precisely
// because everything underneath was never tried.
//
// The fix is to deliberately let a few through. One in twenty, capped at two a
// day, labelled separately, and excluded from the headline rate.
export const AUDIT = { rate: 0.05, dailyCap: 2, floor: 40, reason: 'audit sample' };

/** Injectable so the tests can assert the rate without depending on chance. */
export function shouldAuditSample(score, threshold, random = Math.random) {
  if (score < AUDIT.floor || score >= threshold) return false;
  if ((todayRates().audit_samples || 0) >= AUDIT.dailyCap) return false;
  return random() < AUDIT.rate;
}

const SYSTEM = `You score how well one candidate fits one job posting.

Score 0-100 on evidence in the profile only. Be strict — an inflated score wastes
an application, and applying to badly-matched roles damages the candidate's
standing with employers and job platforms.

Weigh: required skills the candidate demonstrably has; seniority fit; domain
overlap; whether the day-to-day work matches their background.

"blockers" are disqualifiers, not weaknesses: a required clearance, a required
degree they lack, a mandatory on-site location they cannot reach, a required
language they do not speak. A blocker means do not apply regardless of score.

Return JSON:
{"score": <0-100>, "rationale": "<one sentence>", "blockers": ["..."],
 "missingRequirements": ["..."]}`;

/**
 * Cheap heuristic before any LLM spend — kills the obvious misses for free.
 * The authorisation and seniority gates already ran at discovery (§2.3).
 */
export function heuristicScore(job, profile) {
  const jd = `${job.title || ''} ${job.jd_text || ''}`.toLowerCase();
  const skills = Object.entries(profile.skills || {})
    .filter(([n, m]) => !n.startsWith('_') && m?.confirmed)
    .map(([n]) => normaliseSkill(n));

  const hits = skills.filter(s => jd.includes(s));
  const overlap = skills.length ? hits.length / skills.length : 0;

  // Title relevance against the tiers the searches target.
  const titleRelevant = /analyst|analytics|growth|marketing|adops|ad operations|campaign|gtm|martech|revenue operations|programmatic|data/i
    .test(job.title || '');

  return {
    overlap,
    matchedSkills: hits,
    titleRelevant,
    // Not a verdict — a gate on whether the LLM call is worth making.
    worthScoring: titleRelevant && hits.length >= 2,
  };
}

/**
 * Examples of what actually converted for this candidate (§8.7).
 *
 * Cheap, and it grounds the model in real results rather than generic notions of
 * fit — "Marketing Analyst at a fintech got an interview" is worth more than any
 * amount of prompt about weighing seniority. Regenerated from labelled outcomes
 * and kept in `settings`, so refreshing it is not a code change.
 */
export function fewShotBlock() {
  const raw = getSetting('score_examples');
  if (!raw) return '';
  try {
    const { examples } = JSON.parse(raw);
    if (!examples?.length) return '';
    return 'HOW PAST APPLICATIONS ACTUALLY WENT (this candidate, real outcomes)\n' +
      examples.map(e => `- ${e.title} at ${e.company} (scored ${e.score}) — ${e.label}`).join('\n') +
      '\n\n';
  } catch {
    return '';
  }
}

export async function scoreJob(job, profile) {
  const h = heuristicScore(job, profile);

  if (!h.titleRelevant) {
    return { score: 0, rationale: 'Title is outside the targeted role families', blockers: [], heuristic: h };
  }
  if (!h.worthScoring) {
    return {
      score: 25,
      rationale: `Only ${h.matchedSkills.length} confirmed skill(s) appear in the description`,
      blockers: [], heuristic: h,
    };
  }
  if (!hasKey() || !job.jd_text) {
    // Degrade to the heuristic rather than blocking the pipeline.
    return {
      score: Math.round(40 + h.overlap * 50),
      rationale: `Heuristic only (${hasKey() ? 'no description fetched' : 'no OPENAI_API_KEY'}): ${h.matchedSkills.length} skills matched`,
      blockers: [], heuristic: h, degraded: true,
    };
  }

  const out = await callLLM([
    { role: 'system', content: SYSTEM },
    { role: 'user', content:
        `CANDIDATE PROFILE\n${summariseForLLM(profile)}\n\n` +
        fewShotBlock() +
        `JOB: ${job.title} at ${job.company} (${job.location})\n\n` +
        `DESCRIPTION\n${String(job.jd_text).slice(0, 6000)}` },
  ], { maxTokens: 400 });

  return {
    score: Math.max(0, Math.min(100, Number(out.score) || 0)),
    rationale: out.rationale || '',
    blockers: Array.isArray(out.blockers) ? out.blockers : [],
    missingRequirements: Array.isArray(out.missingRequirements) ? out.missingRequirements : [],
    heuristic: h,
  };
}

export async function runScoring({ limit = 30, audit = true, random = Math.random } = {}) {
  const profile = loadProfile();
  const threshold = currentThreshold();
  const jobs = db.prepare(`SELECT * FROM jobs WHERE status = 'enriched' ORDER BY id LIMIT ?`).all(limit);
  let scored = 0, rejected = 0, sampled = 0;

  let deferred = 0;

  for (const job of jobs) {
    try {
      const r = await scoreJob(job, profile);

      // The heuristic measures how much of the profile a posting happens to
      // mention, which is not a fit judgement and cannot clear the threshold on
      // a normal posting. Rejecting on it would quietly discard the entire
      // pipeline, so a degraded score is recorded and the job waits for a real
      // one instead of being thrown away.
      if (r.degraded) {
        updateJob(job.id, { fit_score: r.score, fit_rationale: r.rationale });
        deferred++;
        continue;
      }

      // A blocker disqualifies regardless of score.
      if (r.blockers.length) {
        updateJob(job.id, {
          fit_score: r.score, fit_rationale: r.rationale,
          status: 'rejected', reject_reason: `blocker: ${r.blockers[0]}`,
        });
        rejected++;
        emit({ jobId: job.id, stage: 'score', message: `Rejected (blocker: ${r.blockers[0]}) — ${job.title} @ ${job.company}` });
      } else if (r.score < threshold) {
        // Occasionally let one through anyway. Without a sample of what happens
        // below the line, the threshold can only ever be validated against jobs
        // that already cleared it.
        if (audit && shouldAuditSample(r.score, threshold, random)) {
          updateJob(job.id, {
            fit_score: r.score, fit_rationale: r.rationale,
            status: 'scored', reject_reason: AUDIT.reason,
          });
          bumpRate('audit_samples');
          sampled++;
          emit({
            jobId: job.id, stage: 'score',
            message: `Audit sample (fit ${r.score}, below ${threshold}) — ${job.title} @ ${job.company}. ` +
              `Applied to deliberately so the threshold has evidence from below it.`,
          });
        } else {
          updateJob(job.id, {
            fit_score: r.score, fit_rationale: r.rationale,
            status: 'rejected', reject_reason: `fit ${r.score} < ${threshold}`,
          });
          rejected++;
          emit({ jobId: job.id, stage: 'score', message: `Rejected (fit ${r.score}) — ${job.title} @ ${job.company}` });
        }
      } else {
        updateJob(job.id, { fit_score: r.score, fit_rationale: r.rationale, status: 'scored' });
        scored++;
        emit({ jobId: job.id, stage: 'score', message: `Fit ${r.score} — ${job.title} @ ${job.company}` });
      }
    } catch (err) {
      emit({ jobId: job.id, stage: 'score', level: 'error', message: `Scoring failed: ${err.message}` });
    }
    emitBoard();
  }

  if (deferred) {
    emit({
      stage: 'score', level: 'warn',
      message: `${deferred} job(s) held unscored — there is no OpenAI key, and the keyword fallback is not a fit judgement. ` +
               `Add a key in the dashboard and run scoring again to rank them.`,
    });
  }

  emit({
    stage: 'score',
    message: `Scoring complete — ${scored} passed, ${rejected} rejected, ${deferred} held` +
      (sampled ? `, ${sampled} audit sample(s)` : '') + ` (threshold ${threshold})`,
  });
  return { scored, rejected, deferred, sampled };
}
