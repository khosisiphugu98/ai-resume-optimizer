import { db, updateJob, parkQuestions, bumpRate, appliedUrlOwner } from '../db.js';
import { emit, emitBoard } from '../bus.js';
import { getContext, attachScreencast, stopRequested, ChallengeDetected } from '../browser.js';
import { loadProfile } from '../profile.js';
import { applyEasy } from './linkedin-easy.js';
import { applyExternal, resolveExternalUrl } from './external.js';
import { detectVendor } from './adapters/index.js';
import { canApply, recordApplication, currentMode, applicationGap } from './rate.js';
import { AUDIT } from '../score/index.js';
import { resumeText } from '../answer/resume-context.js';
import path from 'node:path';
import { recordSubmission } from './submission-log.js';

// A posting that fails this many times stays in apply_failed and stops being
// re-queued. High enough to ride out transient failures, low enough that a
// genuinely-dead posting (closed, unresolvable form) does not burn the browser
// and pageview budget on every cycle forever.
export const APPLY_MAX_ATTEMPTS = 3;

/**
 * Failures that will fail identically on every retry.
 *
 * The retry budget exists for transient trouble — a slow render, a lost popup
 * race, a network blip. Spending it on a posting whose form does not exist, or
 * whose vendor we do not automate, proves the same thing three times and burns
 * three pageviews doing it. These go straight to terminal.
 */
const DETERMINISTIC_FAILURE = [
  /no application form found/i,
  /no fillable fields/i,
  /posting (is |has )?(closed|expired|no longer)/i,
  /404|not found/i,
  /requires? (an? )?(account|sign[- ]?in|login)/i,
];

export const isDeterministic = msg => DETERMINISTIC_FAILURE.some(re => re.test(msg || ''));

/** Persist an attempt so the dashboard can show exactly what was filled. */
function recordAttempt(job, channel, result, outcome, note = null) {
  const info = db.prepare(`
    INSERT INTO applications (job_id, channel, resume_path, ats_vendor, adapter_used,
                              submitted_at, confirmation_evidence, outcome,
                              filled_json, screenshots_json, step_count, outcome_note,
                              plan_fingerprint)
    VALUES (@job_id, @channel, @resume_path, @ats_vendor, @adapter, @submitted_at,
            @evidence, @outcome, @filled, @shots, @steps, @note, @fingerprint)`).run({
    job_id: job.id,
    channel,
    resume_path: job.resume_path || null,
    ats_vendor: result.vendor || job.ats_vendor || null,
    // The adaptive agent records which planner shape solved the page, so the
    // review card can show it came from the agent rather than a vendor adapter,
    // and a correction can pin back onto that plan.
    adapter: result.agent ? `agent:${result.agent.kind}` : (result.vendor ? `ats:${result.vendor}` : 'linkedin-easy'),
    fingerprint: result.agent?.fingerprint || null,
    submitted_at: outcome === 'submitted' ? new Date().toISOString() : null,
    evidence: result.evidence || null,
    outcome,
    filled: JSON.stringify(result.filled || []),
    shots: JSON.stringify(result.screenshots || []),
    steps: result.steps || 0,
    // Carried onto the application so the calibration report can hold audit
    // samples out of the headline rate — they were sent *because* they scored
    // below the threshold, so counting them with the rest would understate it.
    // The audit marker wins the slot when present — the calibration report keys
    // off it — otherwise the note says why this attempt ended where it did.
    note: job.reject_reason === AUDIT.reason ? AUDIT.reason : note,
  });
  return info.lastInsertRowid;
}

/**
 * Apply to jobs that have been tailored.
 *
 * observe — does nothing, by design.
 * review  — fills every step, captures it, abandons, and queues for approval.
 * auto    — fills and submits.
 *
 * Approving a reviewed application re-runs the whole flow with submit:true.
 * Resuming a half-filled modal is not possible: sessions expire, postings
 * change, and LinkedIn discards in-progress applications.
 */
export async function runApplications({ limit = 5, mode = currentMode(), ignoreHours = false, noGap = false } = {}) {
  if (mode === 'observe') {
    emit({ stage: 'apply', level: 'warn', message: 'Mode is observe — not applying to anything. Switch to review or auto.' });
    return { attempted: 0, submitted: 0, queued: 0, parked: 0, failed: 0 };
  }

  const profile = loadProfile();
  const ctx = await getContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  await attachScreencast(page);

  // A channel at its cap/budget (e.g. LinkedIn's pageview budget exhausted) is
  // dropped from candidate selection: otherwise its high-fit jobs fill the limited
  // batch, all get held, and a channel that CAN apply right now (external) is
  // starved. Approved jobs stay eligible whatever the channel state — a human said
  // go, so they never wait behind a capped channel.
  // `unknown` rides with external. Enrichment writes that route when LinkedIn's
  // guest page omits the apply control — which it does for any posting that wants
  // you signed in — and nothing ever re-derived it, so those jobs were tailored
  // and then stranded: no selector anywhere would pick them up. Sending them
  // through resolveExternalUrl is exactly the work that would have classified them
  // in the first place, and it either finds the real ATS or says the posting is
  // Easy Apply after all, which is handled below.
  const applyableType = { linkedin_easy: 'easy_apply', external_ats: 'external' };
  const ridesWith = { external_ats: ['external', 'unknown'] };
  const activeTypes = Object.entries(applyableType)
    .filter(([ch]) => canApply(ch, { ignoreHours }).ok)
    .flatMap(([ch, t]) => ridesWith[ch] || [t]);
  const typeList = activeTypes.map(() => '?').join(',') || 'NULL';

  // Approved-for-submit first, then freshly tailored, then a bounded retry of
  // anything that previously failed. Without the last bucket a job that failed
  // once — often for a transient reason (a slow-rendering posting, a lost popup
  // race) — sits in apply_failed forever, because nothing ever selects it again.
  const jobs = db.prepare(`
    SELECT * FROM jobs
    WHERE apply_type IN ('easy_apply', 'external', 'unknown')
      AND (
        status = 'approved'
        OR (apply_type IN (${typeList})
            AND (status = 'tailored' OR (status = 'apply_failed' AND apply_attempts < ?)))
      )
    ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'tailored' THEN 1 ELSE 2 END,
             fit_score DESC, id
    LIMIT ?`).all(...activeTypes, APPLY_MAX_ATTEMPTS, limit);

  if (!jobs.length) {
    emit({ stage: 'apply', message: 'No jobs ready to apply to — tailor some first' });
    return { attempted: 0, submitted: 0, queued: 0, parked: 0, failed: 0, manual: 0 };
  }

  const stats = { attempted: 0, submitted: 0, queued: 0, parked: 0, failed: 0, manual: 0 };

  const channelOf = j => (j.apply_type === 'easy_apply' ? 'linkedin_easy' : 'external_ats');
  const blocked = new Set();

  for (const [i, job] of jobs.entries()) {
    if (stopRequested()) { emit({ stage: 'apply', level: 'warn', message: 'STOP file present — halting' }); break; }

    const channel = channelOf(job);
    const gate = canApply(channel, { ignoreHours });
    if (!gate.ok) {
      // Channels have separate budgets, so one hitting its cap must not stop the
      // other. Only stop once every remaining job is on a blocked channel.
      if (!blocked.has(channel)) {
        blocked.add(channel);
        emit({ stage: 'apply', level: 'warn', message: `Holding ${channel}: ${gate.reason}` });
      }
      if (jobs.slice(i + 1).every(j => blocked.has(channelOf(j)))) break;
      continue;
    }

    // An approved job always submits, whatever the global mode.
    const shouldSubmit = mode === 'auto' || job.status === 'approved';
    stats.attempted++;
    const attemptNo = (job.apply_attempts || 0) + 1;
    updateJob(job.id, { apply_attempts: attemptNo });

    try {
      const retrySuffix = job.status === 'apply_failed' ? `, retry ${attemptNo}/${APPLY_MAX_ATTEMPTS}` : '';
      emit({
        jobId: job.id, stage: 'apply',
        message: `${shouldSubmit ? 'Applying' : 'Preparing'} — ${job.title} @ ${job.company} [${channel}] (${gate.remaining} left today${retrySuffix})`,
      });

      const answerCtx = {
        profile, countryCode: 'ZA', company: job.company,
        jobTitle: job.title, jd: job.jd_text,
        // The tailored résumé's text, so the resolver can reason from the
        // experience prose the structured profile doesn't carry. Best-effort —
        // '' if there's no readable PDF yet.
        resumeText: await resumeText(job.resume_path),
      };

      let result;
      if (job.apply_type === 'easy_apply') {
        result = await applyEasy(page, job, { ...answerCtx, ats: 'linkedin' },
          { submit: shouldSubmit, resumePath: job.resume_path });
      } else {
        if (!job.external_apply_url) {
          const resolved = await resolveExternalUrl(page, job);
          const v = detectVendor(resolved);
          updateJob(job.id, { external_apply_url: resolved, ats_vendor: v.vendor });
          job.external_apply_url = resolved;
          emit({ jobId: job.id, stage: 'apply', message: `Resolved to ${v.vendor}: ${resolved.slice(0, 90)}` });
        }

        // Two LinkedIn cards can be the same underlying posting — reposted by a
        // different agency, or listed twice by the same one. They only reveal
        // themselves as identical once the apply URL is resolved, by which point
        // both look like fresh work. In one batch, "Data Scientist @ Jobs Ai" and
        // "Data Scientist @ Hire Feed" both resolved to the same micro1.ai posting
        // and both were filled. Applying twice to one job is not persistence.
        const twin = appliedUrlOwner(job.external_apply_url, job.id);
        if (twin) {
          updateJob(job.id, { status: 'blocked', reject_reason: `duplicate of job #${twin} — same apply URL` });
          emit({
            jobId: job.id, stage: 'apply', level: 'warn',
            message: `Skipped — the same posting was already applied to as job #${twin}`,
          });
          continue;
        }
        result = await applyExternal(page, job, answerCtx,
          { submit: shouldSubmit, resumePath: job.resume_path, approved: job.status === 'approved' });
      }

      if (result.outcome === 'manual') {
        recordAttempt(job, channel, result, 'unsupported', result.reason);
        updateJob(job.id, { status: 'manual_required', ats_vendor: result.vendor, reject_reason: result.reason });
        stats.manual++;
        emit({
          jobId: job.id, stage: 'apply', level: 'warn',
          message: `Manual required (${result.vendor}) — ${result.reason}`,
        });
      } else if (result.outcome === 'parked') {
        parkQuestions(job.id, result.parked);
        recordAttempt(job, channel, result, 'abandoned', `parked: ${result.parked[0]?.question || ''} (${result.parked[0]?.reason || ''})`.slice(0, 200));
        stats.parked++;
        emit({
          jobId: job.id, stage: 'apply', level: 'warn',
          message: `Parked — ${result.parked[0].question} (${result.parked[0].reason})`,
        });
      } else if (result.outcome === 'submitted') {
        const appId = recordAttempt(job, channel, result, 'submitted');
        recordApplication(channel);
        updateJob(job.id, { status: 'submitted' });
        stats.submitted++;
        // What actually went to the employer, written where it can be read back
        // without the database — see submission-log.js.
        recordSubmission({ job, channel, applicationId: appId, result, outcome: 'submitted' });
        emit({
          jobId: job.id, stage: 'apply',
          message: `Submitted — ${job.title} @ ${job.company} · ${result.filled?.length || 0} field(s)`
            + `${job.resume_path ? ` · ${path.basename(job.resume_path)}` : ''}`
            + ` · logged to artifacts/submissions/${job.id}-${appId}.json`,
        });
        for (const f of result.filled || []) {
          emit({
            jobId: job.id, stage: 'apply', level: 'debug',
            message: `  sent [${f.tier || '?'}] ${String(f.question || '').slice(0, 60)} = ${JSON.stringify(String(f.value ?? '').slice(0, 60))}`,
          });
        }
      } else if (result.outcome === 'submitted_unconfirmed') {
        // We pressed submit and could not verify what happened. This is terminal on
        // purpose: `manual_required` is never re-selected, so the application is not
        // sent a second time on the strength of an unrecognised confirmation page.
        // It counts against the daily cap, because something did go out.
        const appId = recordAttempt(job, channel, result, 'submitted_unconfirmed');
        recordApplication(channel);
        updateJob(job.id, { status: 'manual_required', reject_reason: result.reason });
        stats.manual++;
        // Logged like a confirmed submission: something went out, and the record
        // of what is exactly as valuable when the outcome is uncertain.
        recordSubmission({ job, channel, applicationId: appId, result, outcome: 'submitted_unconfirmed' });
        emit({
          jobId: job.id, stage: 'apply', level: 'warn',
          message: `Submitted but unconfirmed — ${job.title} @ ${job.company}. ${result.reason} Check the employer's site or your inbox before re-applying.`,
        });
      } else if (job.status === 'approved') {
        // A human approved this and it still did not submit. Sending it back to
        // awaiting_review is what made approval an infinite loop: re-filling the
        // live vendor form on every cycle and never finishing. It stops here, with
        // the reason, so the operator can do it by hand rather than approve again.
        const why = result.heldForReview || 'the form could not be submitted automatically';
        recordAttempt(job, channel, result, 'needs_human', why);
        updateJob(job.id, { status: 'manual_required', reject_reason: why });
        stats.manual++;
        emit({
          jobId: job.id, stage: 'apply', level: 'warn',
          message: `Approved but not submittable — ${why}. Filled ${result.filled.length} field(s); finish this one by hand.`,
        });
      } else {
        // Filled and captured, not sent.
        recordAttempt(job, channel, result, 'held_for_review', result.heldForReview || 'mode is review — awaiting approval');
        updateJob(job.id, { status: 'awaiting_review' });
        stats.queued++;
        emit({
          jobId: job.id, stage: 'apply',
          message: `Ready for review — ${result.filled.length} fields filled across ${result.steps} step(s)`
            + (result.heldForReview ? ` — ${result.heldForReview}` : ''),
        });
      }
    } catch (err) {
      if (err instanceof ChallengeDetected) {
        bumpRate('challenges_hit');
        // Refund the attempt. A challenge says nothing about this posting — the
        // job never got its turn. Charging it burnt a third of the retry budget
        // each time LinkedIn asked us to prove we were human, and six jobs
        // reached 3 attempts that way: permanently unselectable, never actually
        // tried.
        updateJob(job.id, { status: 'tailored', apply_attempts: job.apply_attempts || 0 });
        emit({
          jobId: job.id, stage: 'apply', level: 'critical',
          message: `${err.message} — ALL APPLYING HALTED. Clear it by hand in the browser, then run: npm run resume`,
        });
        emitBoard();
        throw err;
      }
      // resolveExternalUrl reports this when the Apply button never left LinkedIn,
      // which means the posting is Easy Apply and was mis-routed at enrichment.
      // Re-label it rather than spending three retries proving the same thing:
      // classifyApply is never re-run, so nothing else would ever correct it.
      if (/may actually be Easy Apply/i.test(err.message) && job.apply_type !== 'easy_apply') {
        updateJob(job.id, { apply_type: 'easy_apply', status: 'tailored', apply_attempts: 0, reject_reason: null });
        emit({
          jobId: job.id, stage: 'apply', level: 'warn',
          message: `Re-routed to Easy Apply — the posting never left LinkedIn. It will be picked up on the next pass.`,
        });
        emitBoard();
        continue;
      }

      // A deterministic failure is already exhausted on attempt one: retrying
      // "no application form found" produces the same sentence twice more.
      const terminal = isDeterministic(err.message);
      const exhausted = terminal || attemptNo >= APPLY_MAX_ATTEMPTS;
      // `apply_failed` under the attempt cap was invisible rather than finished:
      // the selector skips it, but nothing says so, so it reads as still-queued
      // on the board. `apply_exhausted` is the honest terminal state.
      updateJob(job.id, {
        status: exhausted ? 'apply_exhausted' : 'apply_failed',
        reject_reason: err.message.slice(0, 200),
      });
      stats.failed++;
      emit({
        jobId: job.id, stage: 'apply', level: 'error',
        message: `Failed: ${err.message}` +
          (terminal ? ' — this will not change on a retry; giving up (needs a human, or the posting is gone)'
            : exhausted ? ` — giving up after ${attemptNo} attempts (won't retry automatically)`
            : ` — will retry next cycle (${attemptNo}/${APPLY_MAX_ATTEMPTS})`),
      });
    }

    emitBoard();

    // No point pacing after the final job.
    if (i < jobs.length - 1 && !noGap) {
      const gap = applicationGap(channel);
      emit({ stage: 'apply', message: `Waiting ${Math.round(gap / 1000)}s before the next application` });
      await new Promise(r => setTimeout(r, gap));
    }
  }

  emit({
    stage: 'apply',
    message: `Applications complete — ${stats.submitted} submitted, ${stats.queued} queued for review, ${stats.parked} parked, ${stats.manual} manual, ${stats.failed} failed`,
  });
  return stats;
}
