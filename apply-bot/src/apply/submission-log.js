import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';

/**
 * The record of what was actually sent to an employer.
 *
 * `applications` already stores the fill, but it is a working table: rows are
 * written for every attempt, `filled_json` is overwritten thinking, and a later
 * migration or cleanup can reshape it. Once something has gone to a real company
 * the exact payload stops being working state and becomes evidence — the thing
 * you consult when an employer replies about a detail, or when you want to know
 * what a run put out overnight. So it is also written here: one immutable JSON
 * file per submission, outside the database, never rewritten.
 *
 * Deliberately verbose. Every field, its value, and the tier that decided it, so
 * a wrong answer can be traced to whether the profile, the answer bank, an
 * operator correction or the model produced it.
 */
export const SUBMISSIONS_DIR = path.join(PATHS.artifacts, 'submissions');

/** One line per submission, for tailing. Written alongside the JSON files. */
export const SUBMISSIONS_LOG = path.join(SUBMISSIONS_DIR, 'submissions.jsonl');

/**
 * Record a submission. Best-effort by design: a logging failure must never
 * turn a successful application into a failed one, so everything here is
 * wrapped and the caller is not asked to handle errors.
 */
export function recordSubmission({ job, channel, applicationId, result, outcome }) {
  try {
    fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });

    const fields = (result.filled || []).map(f => ({
      question: f.question ?? null,
      value: f.value ?? null,
      // How this answer was decided — profile fact, stored answer, operator
      // correction, résumé, prefilled by the board, or the model.
      decidedBy: f.tier ?? null,
      control: f.kind ?? null,
      // Flagged where the value was an interpretation rather than a restatement.
      probable: !!f.probable,
    }));

    const record = {
      submittedAt: new Date().toISOString(),
      outcome,                       // submitted | submitted_unconfirmed
      job: {
        id: job.id,
        title: job.title,
        company: job.company,
        location: job.location ?? null,
        posting: job.url ?? null,
        fitScore: job.fit_score ?? null,
      },
      channel,
      applicationId,
      vendor: result.vendor ?? null,
      appliedAt: result.url ?? job.external_apply_url ?? null,
      agent: result.agent ?? null,
      steps: result.steps ?? 0,
      resume: job.resume_path ? path.basename(job.resume_path) : null,
      resumePath: job.resume_path ?? null,
      fieldCount: fields.length,
      fields,
      confirmation: result.evidence ?? null,
      screenshots: result.screenshots || [],
      note: result.reason ?? null,
    };

    fs.writeFileSync(
      path.join(SUBMISSIONS_DIR, `${job.id}-${applicationId}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    fs.appendFileSync(SUBMISSIONS_LOG, `${JSON.stringify(record)}\n`);
    return record;
  } catch {
    return null;   // never let the audit trail break the application
  }
}

/** Every recorded submission, newest first. Reads the append-only log. */
export function listSubmissions({ limit = 100 } = {}) {
  try {
    return fs.readFileSync(SUBMISSIONS_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }
}
