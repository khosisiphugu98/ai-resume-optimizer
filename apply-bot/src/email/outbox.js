import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';
import {
  db, updateJob, queueEmail, outboxDue, markEmailSent, markEmailFailed, parkQuestions,
} from '../db.js';
import { emit, emitBoard } from '../bus.js';
import { loadProfile } from '../profile.js';
import { canApply, recordApplication } from '../apply/rate.js';
import { extractEmailApplication, missingAttachments, buildSubject, looksLikeEmailApplication } from './extract.js';
import { composeCoverEmail } from './compose.js';
import { normaliseQuestion } from '../answer/bank.js';
import * as gmail from './gmail.js';

/** Minutes a draft sits visible before it sends itself. 0 disables the hold. */
export const HOLD_MINUTES = Number(process.env.OUTBOX_HOLD_MINUTES ?? 15);

/**
 * Draft an email application and put it in the outbox.
 *
 * Nothing here sends. Sending happens on flush, after the hold, which is the one
 * deliberate delay left in autonomous mode: email cannot be unsent, the recipient
 * is a named human, and a malformed send is a first impression you cannot retract.
 */
export async function draftEmailApplication(job, profile) {
  if (!job.jd_text) throw new Error('No job description to extract an address from');

  const spec = await extractEmailApplication(job);
  if (!spec.to) throw new Error('No application email address found in the posting');

  // Documents we do not have. Sending an incomplete application is worse than
  // parking it, and we will not fabricate a transcript.
  const missing = missingAttachments(spec.requiredAttachments);
  if (missing.length) {
    return {
      outcome: 'parked',
      parked: [{
        question: `This posting requires: ${missing.join(', ')}. Where are these files?`,
        questionNorm: normaliseQuestion(`attachment ${missing.join(' ')}`),
        fieldType: 'file',
        reason: `posting demands ${missing.join(', ')}, which the bot cannot produce`,
        tier: 'attachment',
      }],
    };
  }

  if (!job.resume_path || !fs.existsSync(job.resume_path)) {
    throw new Error('No tailored resume on disk for this job');
  }

  const subject = buildSubject(spec, job, profile);
  const body = await composeCoverEmail(job, profile, spec);

  const sendAfter = new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString();
  const id = queueEmail({
    jobId: job.id,
    to: spec.to,
    cc: spec.cc,
    subject,
    body,
    attachments: [job.resume_path],
    referenceNumber: spec.referenceNumber,
    sendAfter,
  });

  // Keep a copy on disk — useful when Gmail is not connected yet.
  const dir = path.join(PATHS.artifacts, 'emails');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${job.id}-${id}.txt`),
    `To: ${spec.to}\nSubject: ${subject}\nAttachment: ${path.basename(job.resume_path)}\n\n${body}\n`
  );

  return {
    outcome: 'queued', outboxId: id, to: spec.to, subject, sendAfter,
    referenceNumber: spec.referenceNumber, degraded: !!spec.degraded,
    correctedRecipient: !!spec.correctedRecipient,
  };
}

/** Send everything past its hold. Called on a timer by the dashboard server. */
export async function flushOutbox({ force = false } = {}) {
  const due = force
    ? db.prepare(`SELECT * FROM outbox WHERE status = 'held' ORDER BY send_after`).all()
    : outboxDue();

  if (!due.length) return { sent: 0, failed: 0, skipped: 0 };

  if (!gmail.isConfigured()) {
    emit({
      stage: 'email', level: 'warn',
      message: `${due.length} email(s) ready but Gmail is not connected — drafts are in artifacts/emails/. Run: npm run gmail:auth`,
    });
    return { sent: 0, failed: 0, skipped: due.length };
  }

  let sent = 0, failed = 0, skipped = 0;

  for (const row of due) {
    const gate = canApply('email');
    if (!gate.ok) {
      emit({ stage: 'email', level: 'warn', message: `Holding email: ${gate.reason}` });
      skipped += due.length - sent - failed;
      break;
    }

    try {
      const res = await gmail.sendEmail({
        to: row.to_addr,
        cc: row.cc_addr ? row.cc_addr.split(',').map(s => s.trim()).filter(Boolean) : [],
        subject: row.subject,
        body: row.body,
        attachments: JSON.parse(row.attachments_json || '[]'),
      });
      markEmailSent(row.id, res);
      recordApplication('email');
      updateJob(row.job_id, { status: 'submitted' });
      sent++;
      emit({ jobId: row.job_id, stage: 'email', message: `Sent to ${row.to_addr} — "${row.subject}"` });
    } catch (err) {
      markEmailFailed(row.id, err.message);
      updateJob(row.job_id, { status: 'apply_failed', reject_reason: `email send failed: ${err.message}`.slice(0, 200) });
      failed++;
      emit({ jobId: row.job_id, stage: 'email', level: 'error', message: `Send failed: ${err.message}` });
    }
    emitBoard();
  }

  return { sent, failed, skipped };
}

/** Run the email channel over jobs routed to it. */
export async function runEmailApplications({ limit = 10 } = {}) {
  const profile = loadProfile();
  const jobs = db.prepare(`
    SELECT * FROM jobs
    WHERE apply_type = 'email' AND status = 'tailored'
    ORDER BY fit_score DESC, id LIMIT ?`).all(limit);

  if (!jobs.length) {
    emit({ stage: 'email', message: 'No email applications ready — tailor some first' });
    return { queued: 0, parked: 0, failed: 0 };
  }

  const stats = { queued: 0, parked: 0, failed: 0 };

  for (const job of jobs) {
    const gate = canApply('email');
    if (!gate.ok) { emit({ stage: 'email', level: 'warn', message: `Holding: ${gate.reason}` }); break; }

    try {
      const r = await draftEmailApplication(job, profile);
      if (r.outcome === 'parked') {
        parkQuestions(job.id, r.parked);
        stats.parked++;
        emit({ jobId: job.id, stage: 'email', level: 'warn', message: `Parked — ${r.parked[0].reason}` });
      } else {
        updateJob(job.id, { status: 'outbox' });
        stats.queued++;
        emit({
          jobId: job.id, stage: 'email',
          message: `Drafted to ${r.to}${r.referenceNumber ? ` (ref ${r.referenceNumber})` : ''} — sends in ${HOLD_MINUTES} min unless cancelled`,
        });
        if (r.correctedRecipient) {
          emit({ jobId: job.id, stage: 'email', level: 'warn', message: 'Model suggested an address not in the posting — used the one that appears in the text instead' });
        }
      }
    } catch (err) {
      updateJob(job.id, { status: 'apply_failed', reject_reason: err.message.slice(0, 200) });
      stats.failed++;
      emit({ jobId: job.id, stage: 'email', level: 'error', message: `Email draft failed: ${err.message}` });
    }
    emitBoard();
  }

  emit({ stage: 'email', message: `Email drafting complete — ${stats.queued} queued, ${stats.parked} parked, ${stats.failed} failed` });
  return stats;
}

/** Poll sent threads for replies — the only automatic outcome signal we get. */
export async function checkReplies() {
  if (!gmail.isConfigured()) return { checked: 0, replies: 0 };

  const rows = db.prepare(
    `SELECT * FROM outbox WHERE status = 'sent' AND gmail_thread_id IS NOT NULL AND reply_state IS NULL`).all();
  if (!rows.length) return { checked: 0, replies: 0 };

  const me = await gmail.profileAddress();
  let replies = 0;

  for (const row of rows) {
    try {
      const r = await gmail.checkThread(row.gmail_thread_id, me);
      if (!r.replied) continue;
      db.prepare(`UPDATE outbox SET reply_state = ? WHERE id = ?`).run(r.state, row.id);
      replies++;
      emit({
        jobId: row.job_id, stage: 'email',
        level: r.state === 'interview' ? 'info' : 'warn',
        message: `Reply (${r.state}) from ${row.to_addr}: ${r.snippet.slice(0, 120)}`,
      });
    } catch { /* a single unreadable thread should not stop the sweep */ }
  }

  emitBoard();
  return { checked: rows.length, replies };
}

export { looksLikeEmailApplication };
