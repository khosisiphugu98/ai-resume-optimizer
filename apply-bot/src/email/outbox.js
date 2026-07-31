import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';
import {
  db, updateJob, queueEmail, outboxDue, markEmailSent, markEmailFailed, parkQuestions,
  recordEmailApplication, setOutcome, getSetting, setSetting,
} from '../db.js';
import { emit, emitBoard } from '../bus.js';
import { loadProfile } from '../profile.js';
import { canApply, recordApplication } from '../apply/rate.js';
import { extractEmailApplication, missingAttachments, buildSubject, looksLikeEmailApplication } from './extract.js';
import { composeCoverEmail } from './compose.js';
import { preflight } from '../apply/preflight.js';
import { unmeetableRequirements } from '../discover/jd-instructions.js';
import { normaliseQuestion } from '../answer/bank.js';
import * as gmail from './gmail.js';

/** Minutes a draft sits visible before it sends itself. 0 disables the hold. */
export const HOLD_MINUTES = Number(process.env.OUTBOX_HOLD_MINUTES ?? 15);

/** Reply classification → the ordinal outcome scale in db.js. */
const REPLY_TO_OUTCOME = { rejected: 'rejected', interview: 'interview', replied: 'screen' };

/**
 * A disconnected Gmail is a standing condition, not an event.
 *
 * Between 29 and 31 July the refresh token was dead and the pipeline logged
 * `replies failed: invalid_grant` 144 times — once per cycle, identically, for
 * three days. That is not a log, it is noise that buries every other error in the
 * same window. Report it once a day, say what to do about it, and let the stage
 * return quietly the rest of the time.
 *
 * Returns true when the caller should stop.
 */
function noteGmailDisconnected(stage, err) {
  const today = new Date().toISOString().slice(0, 10);
  if (getSetting('gmail_disconnected_alerted') !== today) {
    setSetting('gmail_disconnected_alerted', today);
    emit({
      stage, level: 'error',
      message: `Gmail is disconnected — ${err.message}. The email channel and reply `
        + 'tracking are both stopped until it is reconnected.',
    });
  }
  return true;
}

/** True when Gmail is usable at all. Also the seam the disconnect alert hangs off. */
function gmailReady(stage) {
  if (gmail.isConfigured()) return true;
  noteGmailDisconnected(stage, new Error('no saved connection — run: npm run gmail:auth'));
  return false;
}

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

  // What the posting literally instructed, read at enrich time. It outranks the
  // model's reading of the same text: a reference code and a dictated subject
  // line are things the description says in words, and a recruiter filtering on
  // one will never see an email that paraphrases it.
  const instructions = job.jd_instructions ? JSON.parse(job.jd_instructions) : {};
  if (instructions.referenceNumber) spec.referenceNumber = instructions.referenceNumber;
  if (instructions.subjectLine) spec.instructedSubject = instructions.subjectLine;

  // 13.4% of postings ask for a portfolio and nothing in this pipeline ever read
  // that. An application that silently omits an artefact the posting demanded is
  // a wasted send — worse than one not made, because it looks like an answer.
  const unmeetable = unmeetableRequirements(instructions, profile);
  if (unmeetable.length) {
    return {
      outcome: 'parked',
      parked: unmeetable.map(why => ({
        question: `${why}. Send this one by hand, or fill the gap in the profile.`,
        questionNorm: normaliseQuestion(`jd requirement ${why}`),
        fieldType: 'text', reason: why, tier: 'jd-instruction',
      })),
    };
  }

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

  const profile = loadProfile();
  const jobFor = id => db.prepare('SELECT id, title, company FROM jobs WHERE id = ?').get(id) || null;

  // Once a day, not once a flush. This runs on a timer, so on a disconnected
  // Gmail it repeated every ninety seconds — the same noise as the 144 replies
  // failures, from the other end of the same channel.
  if (!gmail.isConfigured()) {
    noteGmailDisconnected('email', new Error(
      `${due.length} email(s) are ready to send but there is no saved connection — `
      + 'drafts are in artifacts/emails/. Run: npm run gmail:auth'));
    return { sent: 0, failed: 0, skipped: due.length, disconnected: true };
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
      // Last look, on the thing that is about to leave. Email is the channel
      // where being wrong costs most: it cannot be unsent, the recipient is a
      // named human, and the covering letter is the document they read first.
      // The evidence gate in compose.js already checked the letter for invented
      // claims when it was written; this reads the finished message — subject,
      // body and all — the way a person would before pressing send.
      const check = await preflight({
        profile, job: jobFor(row.job_id), channel: 'email',
        subject: row.subject, body: row.body,
      });
      if (!check.ok) {
        markEmailFailed(row.id, check.reason);
        updateJob(row.job_id, { status: 'manual_required', reject_reason: check.reason.slice(0, 200) });
        failed++;
        emit({
          jobId: row.job_id, stage: 'email', level: 'warn',
          message: `Not sent — ${check.reason} Rewrite it by hand, or fix the profile and re-draft.`,
        });
        emitBoard();
        continue;
      }

      const res = await gmail.sendEmail({
        to: row.to_addr,
        cc: row.cc_addr ? row.cc_addr.split(',').map(s => s.trim()).filter(Boolean) : [],
        subject: row.subject,
        body: row.body,
        attachments: JSON.parse(row.attachments_json || '[]'),
      });
      markEmailSent(row.id, res);
      recordApplication('email');
      // Gives the email channel an application row like every other channel, so
      // its outcomes are captured and it appears in the calibration report.
      recordEmailApplication({
        jobId: row.job_id,
        resumePath: JSON.parse(row.attachments_json || '[]')[0] || null,
        to: row.to_addr,
        outboxId: row.id,
      });
      updateJob(row.job_id, { status: 'submitted' });
      sent++;
      emit({ jobId: row.job_id, stage: 'email', message: `Sent to ${row.to_addr} — "${row.subject}"` });
    } catch (err) {
      // A dead grant says nothing about this message. Burning the draft and
      // flipping the job to apply_failed — which is what happened to two rows on
      // 29 July — throws away work over a credential problem. Leave it held and
      // stop the flush; it will send itself once Gmail is reconnected.
      if (err?.code === 'gmail_disconnected') {
        noteGmailDisconnected('email', err);
        skipped += due.length - sent - failed;
        break;
      }
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
  if (!gmailReady('replies')) return { checked: 0, replies: 0, disconnected: true };

  const rows = db.prepare(
    `SELECT * FROM outbox WHERE status = 'sent' AND gmail_thread_id IS NOT NULL AND reply_state IS NULL`).all();
  if (!rows.length) return { checked: 0, replies: 0 };

  // The first call is what discovers a dead token, and it must not propagate: an
  // expired grant is a standing condition the operator has to clear, not a stage
  // crash to re-raise every fifteen minutes.
  let me;
  try {
    me = await gmail.profileAddress();
  } catch (err) {
    if (err?.code === 'gmail_disconnected') {
      noteGmailDisconnected('replies', err);
      return { checked: 0, replies: 0, disconnected: true };
    }
    throw err;
  }
  let replies = 0;

  for (const row of rows) {
    try {
      const r = await gmail.checkThread(row.gmail_thread_id, me);
      if (!r.replied) continue;
      db.prepare(`UPDATE outbox SET reply_state = ? WHERE id = ?`).run(r.state, row.id);

      // The one outcome signal that arrives without the operator doing anything.
      // "replied" is a human engaging without saying which way, which is a screen
      // in the ordinal scale — above a rejection, below a booked interview.
      const app = db.prepare(
        `SELECT id FROM applications WHERE job_id = ? AND channel = 'email' ORDER BY id DESC LIMIT 1`)
        .get(row.job_id);
      if (app) {
        setOutcome(app.id, {
          state: REPLY_TO_OUTCOME[r.state] || 'screen',
          source: 'email',
          note: r.snippet.slice(0, 200),
        });
      }
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
