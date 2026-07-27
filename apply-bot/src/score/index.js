import { db, updateJob, getSetting, setSetting, bumpRate, todayRates } from '../db.js';
import { emit, emitBoard } from '../bus.js';
import { loadProfile, summariseForLLM, normaliseSkill } from '../profile.js';
import { callLLM, hasKey } from '../llm.js';
import { roleFamiliesRe } from '../reject-criteria.js';

/** The number that was picked out of the air. Now only the default (§8.4). */
/**
 * The fit score below which a job is not applied to.
 *
 * Lowered from 65. Across 613 real model scores the distribution is bimodal — the
 * 50-59 bucket holds 8 jobs and the 60-69 bucket holds 88 — so 65 cut straight
 * through the densest band on the board, rejecting 55 jobs scoring 60-64 on a
 * number backed by exactly one labelled outcome. 55 sits in the sparse gap
 * between the two modes, which is where a cut belongs until there is evidence to
 * place it better. `AUDIT.floor` below is what will eventually supply that
 * evidence; it is now low enough to sample the jobs this rejects.
 */
export const THRESHOLD = 55;

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
/**
 * Deliberate applications below the threshold, so it can eventually be validated.
 *
 * `floor` was 40 and the cap 2 a day, which produced two audit samples in the
 * system's entire history against the 40 labelled outcomes `calibrate.js` needs —
 * a bar it would never have reached. The floor drops to 25 (a job scoring under
 * that is not a near miss worth testing) and the cap rises, so the threshold
 * starts accumulating the evidence that would justify moving it again.
 */
export const AUDIT = { rate: 0.08, dailyCap: 6, floor: 25, reason: 'audit sample' };

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

"blockers" are hard disqualifiers, not weaknesses. Each one must be tagged with
its kind:

  auth      — a work-authorisation, visa, citizenship or clearance requirement the
              candidate cannot meet.
  language  — the role requires fluency in a language the candidate does not speak.
              The posting being written in another language is itself evidence.
  location  — the role is on-site somewhere the candidate genuinely cannot reach.
              An on-site or hybrid role in the candidate's OWN COUNTRY is NOT a
              blocker; they can travel and are willing to relocate.
  credential — a required degree, certification or licence they lack.
  experience — a required number of years or a domain they lack.

Only include something that would make the application futile. A preference, a
"nice to have", or a requirement stated as "or equivalent experience" is not a
blocker — reflect it in the score instead. If there are none, return an empty
array; never the string "None".

Return JSON:
{"score": <0-100>, "rationale": "<one sentence>",
 "blockers": [{"kind": "auth|language|location|credential|experience", "why": "..."}],
 "missingRequirements": ["..."]}`;

/**
 * Blocker kinds that end the application outright.
 *
 * The others are real, but they are matters of degree that the score already
 * reflects: a preferred degree, a "5+ years" line, an on-site role in a city the
 * candidate could commute to or move for. Treating all five as fatal rejected 42
 * jobs that should have been applied to, 23 of them scoring 50 or better —
 * including nine on-site roles inside South Africa, where the candidate lives.
 */
const FATAL_BLOCKERS = new Set(['auth', 'language']);

/**
 * Normalise whatever the model returned into `{kind, why}` entries worth acting on.
 *
 * Accepts the older bare-string shape so a stale response is not a crash, and
 * discards the ways a model says "nothing here" — three jobs were rejected with
 * the reason `blocker: None` because `["None"]` is a non-empty array.
 */
export function normaliseBlockers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(b => (typeof b === 'string' ? { kind: 'unknown', why: b } : b))
    .filter(b => b && typeof b.why === 'string')
    .map(b => ({ kind: String(b.kind || 'unknown').toLowerCase().trim(), why: b.why.trim() }))
    .filter(b => b.why && !/^(none|n\/?a|nil|no blockers?|not applicable|-)\.?$/i.test(b.why));
}

/**
 * Does this text name that skill, as a word rather than as a fragment?
 *
 * `jd.includes(skill)` looked reasonable until the short skills were counted:
 * "ml" matched inside html, "cro" inside microsoft, "git" inside logistics, "r"
 * inside everything. An Executive Assistant posting scored four skill matches
 * that way. Since `worthScoring` needs only two hits, the gate it was supposed to
 * be had quietly stopped existing, and `overlap` — which feeds the degraded
 * score — was measuring noise.
 */
/**
 * Confirmed skills a description must name before an off-title job is scored
 * anyway. Four is enough to separate a genuine match from a posting that happens
 * to mention Excel.
 */
export const BODY_RESCUE_SKILLS = 4;

export function mentions(text, skill) {
  if (!skill) return false;
  const esc = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9+#])${esc}(?![a-z0-9+#])`, 'i').test(text);
}

/**
 * Cheap heuristic before any LLM spend — kills the obvious misses for free.
 * The authorisation and seniority gates already ran at discovery (§2.3).
 */
export function heuristicScore(job, profile) {
  const jd = `${job.title || ''} ${job.jd_text || ''}`.toLowerCase();
  const skills = Object.entries(profile.skills || {})
    .filter(([n, m]) => !n.startsWith('_') && m?.confirmed)
    .map(([n]) => normaliseSkill(n));

  const hits = skills.filter(s => mentions(jd, s));
  const overlap = skills.length ? hits.length / skills.length : 0;

  // Relevance against the tiers the searches target. The families are
  // operator-editable from the Rejected column (src/reject-criteria.js).
  //
  // The description counts, not just the title. This gate decided the fate of
  // 1188 of 2305 jobs on twelve substrings matched against the title alone, and a
  // title is the one part of a posting written by marketing rather than by the
  // hiring manager: "Specialist", "Associate", "Consultant" say nothing, while the
  // body is wall-to-wall GA4 and Google Ads. 64 rejected postings had a family
  // term in the description and none in the title. The JD is already in hand for
  // the skill overlap two lines up, so consulting it costs nothing.
  const families = roleFamiliesRe();
  const titleRelevant = families.test(job.title || '');

  // The rescue path for a title that says nothing. Deliberately NOT the family
  // regex over the description: a family term appearing anywhere in six thousand
  // characters is almost free, and testing that admitted 956 of the 1187 gated
  // jobs — a gate that lets 80% through is not a gate. What actually distinguishes
  // a mislabelled match from an unrelated posting is whether the description names
  // the candidate's own confirmed skills, several of them, which is the same
  // evidence `worthScoring` already trusts.
  const bodyRelevant = !titleRelevant && hits.length >= BODY_RESCUE_SKILLS;
  const relevant = titleRelevant || bodyRelevant;

  return {
    overlap,
    matchedSkills: hits,
    titleRelevant: relevant,
    // Kept apart so the rationale can say which one carried it — a job admitted on
    // its description alone is worth being able to find later.
    matchedOn: titleRelevant ? 'title' : (bodyRelevant ? 'description' : null),
    // Not a verdict — a gate on whether the LLM call is worth making.
    worthScoring: relevant && hits.length >= 2,
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
    // `gated` says this job was never judged. Without it the board wrote
    // "fit 0 < 65" against 1188 jobs that no model ever looked at, which reads as
    // a considered rejection and hid the largest single leak in the pipeline
    // behind language that suggested the threshold was doing the work.
    return {
      score: 0, gated: true, blockers: [], heuristic: h,
      rationale: 'Neither the title nor the description mentions a targeted role family — not scored',
    };
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
        // Spelled out because the model was inferring it and getting it wrong.
        // Nine jobs were rejected as "on-site in Pretoria", "on-site in Cape Town",
        // "office-based, Foreshore" — all inside the candidate's own country — and
        // one, at fit 70, for requiring South African citizenship. The profile
        // summary carried a location line, but nothing told the model that being
        // based in the same country makes an on-site requirement reachable.
        `WHERE THE CANDIDATE IS\n` +
        `Lives in ${profile.identity?.city || 'unspecified'}, ${profile.identity?.country || 'unspecified'}. ` +
        `Willing to relocate: ${profile.authorization?.willingToRelocate ? 'yes' : 'no'}. ` +
        `An on-site or hybrid role anywhere in ${profile.identity?.country || 'their country'} is reachable ` +
        `and must not be treated as a location blocker.\n\n` +
        fewShotBlock() +
        `JOB: ${job.title} at ${job.company} (${job.location})\n\n` +
        `DESCRIPTION\n${String(job.jd_text).slice(0, 6000)}` },
  ], { maxTokens: 400 });

  return {
    score: Math.max(0, Math.min(100, Number(out.score) || 0)),
    rationale: out.rationale || '',
    blockers: normaliseBlockers(out.blockers),
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

      // Only a fatal blocker ends it. The rest are weaknesses the score already
      // carries, so they go on to be judged against the threshold like anything
      // else — a preferred degree or an on-site role in the candidate's own city
      // is not a reason to throw the job away unseen.
      const fatal = r.blockers.find(b => FATAL_BLOCKERS.has(b.kind));
      if (fatal) {
        updateJob(job.id, {
          fit_score: r.score, fit_rationale: r.rationale,
          status: 'rejected', reject_reason: `blocker (${fatal.kind}): ${fatal.why}`,
        });
        rejected++;
        emit({ jobId: job.id, stage: 'score', message: `Rejected (${fatal.kind}: ${fatal.why}) — ${job.title} @ ${job.company}` });
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
          // Say which gate closed. A job the family filter stopped was never
          // scored, and calling that "fit 0 < 65" is how 1188 unjudged rejections
          // passed for judgement.
          const reason = r.gated
            ? 'off-target: no role-family term in the title or description'
            : `fit ${r.score} < ${threshold}`;
          updateJob(job.id, {
            fit_score: r.score, fit_rationale: r.rationale,
            status: 'rejected', reject_reason: reason,
          });
          rejected++;
          emit({
            jobId: job.id, stage: 'score',
            message: r.gated
              ? `Off-target (not scored) — ${job.title} @ ${job.company}`
              : `Rejected (fit ${r.score}) — ${job.title} @ ${job.company}`,
          });
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
