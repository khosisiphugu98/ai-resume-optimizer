import { db, updateJob } from '../db.js';
import { emit, emitBoard } from '../bus.js';
import { loadProfile, summariseForLLM, normaliseSkill } from '../profile.js';
import { callLLM, hasKey } from '../llm.js';

export const THRESHOLD = 65;

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

export async function runScoring({ limit = 30 } = {}) {
  const profile = loadProfile();
  const jobs = db.prepare(`SELECT * FROM jobs WHERE status = 'enriched' ORDER BY id LIMIT ?`).all(limit);
  let scored = 0, rejected = 0;

  for (const job of jobs) {
    try {
      const r = await scoreJob(job, profile);

      // A blocker disqualifies regardless of score.
      if (r.blockers.length) {
        updateJob(job.id, {
          fit_score: r.score, fit_rationale: r.rationale,
          status: 'rejected', reject_reason: `blocker: ${r.blockers[0]}`,
        });
        rejected++;
        emit({ jobId: job.id, stage: 'score', message: `Rejected (blocker: ${r.blockers[0]}) — ${job.title} @ ${job.company}` });
      } else if (r.score < THRESHOLD) {
        updateJob(job.id, {
          fit_score: r.score, fit_rationale: r.rationale,
          status: 'rejected', reject_reason: `fit ${r.score} < ${THRESHOLD}`,
        });
        rejected++;
        emit({ jobId: job.id, stage: 'score', message: `Rejected (fit ${r.score}) — ${job.title} @ ${job.company}` });
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

  emit({ stage: 'score', message: `Scoring complete — ${scored} passed, ${rejected} rejected (threshold ${THRESHOLD})` });
  return { scored, rejected };
}
