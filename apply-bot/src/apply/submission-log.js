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

/**
 * Every recorded submission, newest first, one entry per application.
 *
 * The ledger is append-only on purpose — it is evidence, so nothing in it is
 * ever rewritten — which means a corrected outcome arrives as a *new line* for
 * an application that already has one:
 *
 *   3  2026-07-28T07:36:41Z  app 87  job 2136  submitted  Famous Brands
 *   4  2026-07-28T12:09:32Z  app 87  job 2136  error      Famous Brands
 *
 * Returning every line made `npm run submissions` report five submissions where
 * there were three real ones and one retraction, and showed the retraction as
 * though it were a second application to the same company. Collapsing on
 * `applicationId` and keeping the latest record is what the file already means;
 * it was only ever read too literally.
 */
export function listSubmissions({ limit = 100, includeSuperseded = false, file = SUBMISSIONS_LOG } = {}) {
  try {
    const lines = fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    if (includeSuperseded) return lines.reverse().slice(0, limit);

    // Latest wins. Records with no applicationId cannot be collapsed onto
    // anything, so they are kept as they are rather than merged by accident.
    const latest = new Map();
    const loose = [];
    for (const r of lines) {
      if (r.applicationId == null) { loose.push(r); continue; }
      const prev = latest.get(r.applicationId);
      latest.set(r.applicationId, prev ? { ...r, corrections: (prev.corrections || 0) + 1 } : r);
    }

    return [...latest.values(), ...loose]
      .sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)))
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }
}
