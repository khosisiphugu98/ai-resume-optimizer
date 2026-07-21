import { db, updateJob, parkQuestions, bumpRate } from '../db.js';
import { emit, emitBoard } from '../bus.js';
import { getContext, attachScreencast, stopRequested, ChallengeDetected } from '../browser.js';
import { loadProfile } from '../profile.js';
import { applyEasy } from './linkedin-easy.js';
import { canApply, recordApplication, currentMode, applicationGap } from './rate.js';

/** Persist an attempt so the dashboard can show exactly what was filled. */
function recordAttempt(job, channel, result, outcome) {
  const info = db.prepare(`
    INSERT INTO applications (job_id, channel, resume_path, ats_vendor, adapter_used,
                              submitted_at, confirmation_evidence, outcome,
                              filled_json, screenshots_json, step_count)
    VALUES (@job_id, @channel, @resume_path, @ats_vendor, @adapter, @submitted_at,
            @evidence, @outcome, @filled, @shots, @steps)`).run({
    job_id: job.id,
    channel,
    resume_path: job.resume_path || null,
    ats_vendor: job.ats_vendor || null,
    adapter: 'linkedin-easy',
    submitted_at: outcome === 'submitted' ? new Date().toISOString() : null,
    evidence: result.evidence || null,
    outcome,
    filled: JSON.stringify(result.filled || []),
    shots: JSON.stringify(result.screenshots || []),
    steps: result.steps || 0,
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
export async function runApplications({ limit = 5, mode = currentMode(), ignoreHours = false } = {}) {
  if (mode === 'observe') {
    emit({ stage: 'apply', level: 'warn', message: 'Mode is observe — not applying to anything. Switch to review or auto.' });
    return { attempted: 0, submitted: 0, queued: 0, parked: 0, failed: 0 };
  }

  const profile = loadProfile();
  const ctx = await getContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  await attachScreencast(page);

  // Approved-for-submit first, then freshly tailored.
  const jobs = db.prepare(`
    SELECT * FROM jobs
    WHERE apply_type = 'easy_apply' AND status IN ('approved', 'tailored')
    ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END, fit_score DESC, id
    LIMIT ?`).all(limit);

  if (!jobs.length) {
    emit({ stage: 'apply', message: 'No Easy Apply jobs ready — tailor some first' });
    return { attempted: 0, submitted: 0, queued: 0, parked: 0, failed: 0 };
  }

  const stats = { attempted: 0, submitted: 0, queued: 0, parked: 0, failed: 0 };

  for (const job of jobs) {
    if (stopRequested()) { emit({ stage: 'apply', level: 'warn', message: 'STOP file present — halting' }); break; }

    const gate = canApply('linkedin_easy', { ignoreHours });
    if (!gate.ok) {
      emit({ stage: 'apply', level: 'warn', message: `Holding: ${gate.reason}` });
      break;
    }

    // An approved job always submits, whatever the global mode.
    const shouldSubmit = mode === 'auto' || job.status === 'approved';
    stats.attempted++;

    try {
      emit({
        jobId: job.id, stage: 'apply',
        message: `${shouldSubmit ? 'Applying' : 'Preparing'} — ${job.title} @ ${job.company} (${gate.remaining} left today)`,
      });

      const result = await applyEasy(page, job, {
        profile, countryCode: 'ZA', company: job.company, ats: 'linkedin',
        jobTitle: job.title, jd: job.jd_text,
      }, { submit: shouldSubmit, resumePath: job.resume_path });

      if (result.outcome === 'parked') {
        parkQuestions(job.id, result.parked);
        recordAttempt(job, 'linkedin_easy', result, 'abandoned');
        stats.parked++;
        emit({
          jobId: job.id, stage: 'apply', level: 'warn',
          message: `Parked — ${result.parked[0].question} (${result.parked[0].reason})`,
        });
      } else if (result.outcome === 'submitted') {
        recordAttempt(job, 'linkedin_easy', result, 'submitted');
        recordApplication('linkedin_easy');
        updateJob(job.id, { status: 'submitted' });
        stats.submitted++;
        emit({ jobId: job.id, stage: 'apply', message: `Submitted — ${job.title} @ ${job.company}` });
      } else {
        // Filled and captured, not sent.
        recordAttempt(job, 'linkedin_easy', result, 'blocked');
        updateJob(job.id, { status: 'awaiting_review' });
        stats.queued++;
        emit({
          jobId: job.id, stage: 'apply',
          message: `Ready for review — ${result.filled.length} fields filled across ${result.steps} step(s)`,
        });
      }
    } catch (err) {
      if (err instanceof ChallengeDetected) {
        bumpRate('challenges_hit');
        updateJob(job.id, { status: 'tailored' });
        emit({
          jobId: job.id, stage: 'apply', level: 'critical',
          message: `${err.message} — ALL APPLYING HALTED. Clear it by hand in the browser, then run: npm run resume`,
        });
        emitBoard();
        throw err;
      }
      updateJob(job.id, { status: 'apply_failed', reject_reason: err.message.slice(0, 200) });
      stats.failed++;
      emit({ jobId: job.id, stage: 'apply', level: 'error', message: `Failed: ${err.message}` });
    }

    emitBoard();

    const gap = applicationGap();
    emit({ stage: 'apply', message: `Waiting ${Math.round(gap / 1000)}s before the next application` });
    await new Promise(r => setTimeout(r, gap));
  }

  emit({
    stage: 'apply',
    message: `Applications complete — ${stats.submitted} submitted, ${stats.queued} queued for review, ${stats.parked} parked, ${stats.failed} failed`,
  });
  return stats;
}
