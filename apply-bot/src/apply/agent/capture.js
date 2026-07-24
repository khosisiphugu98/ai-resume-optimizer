import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS } from '../../config.js';
import { emit } from '../../bus.js';
import { upsertPageCapture, setCapturePaths } from '../../db.js';
import { collectA11yInPage } from '../a11y.js';
import { collectFieldsInPage } from '../fields.js';

// Snapshots co-locate with whichever database is active — real runs write under
// data/ (gitignored, so page content and any prefilled PII stay local), and the
// test suite's temp APPLY_BOT_DB puts them in a temp dir it can clean up.
const snapshotsDir = () => path.join(path.dirname(PATHS.db), 'agent-snapshots');

const normaliseName = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function safeHost(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * Group two pages by "same shape": the vendor/company host, plus a stable
 * signature of the fillable controls (role + accessible name). Job-specific
 * prose is not a control, so one vendor template hashes the same across
 * postings. A no-form page has no controls, so its fingerprint collapses to the
 * host — exactly one "this host shows no reachable form" example per site.
 *
 * This is the Phase-1 *grouping/dedupe* key only. The stricter *reuse* key that
 * decides when a cached plan may be replayed is a Phase-3 decision.
 */
export function fingerprintOf(host, controls) {
  const sig = (controls || [])
    .map(c => `${c.role}:${normaliseName(c.name)}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(`${host}|${sig}`).digest('hex');
}

/** A tag histogram + landmark inventory — structure without the full HTML. */
function pageOutline() {
  const tags = {};
  for (const el of document.querySelectorAll('*')) {
    const t = el.tagName.toLowerCase();
    tags[t] = (tags[t] || 0) + 1;
  }
  const landmarks = Array.from(
    document.querySelectorAll('main, form, [role="dialog"], [role="form"], iframe, [role="main"]'),
  ).map(el => el.tagName.toLowerCase() + (el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''));
  return { tags, landmarks, bodyChars: (document.body?.innerText || '').length };
}

/** Walk every frame, gathering the controls both collectors can see. */
export async function buildSnapshot(page) {
  const frames = [];
  const controls = [];
  for (const frame of page.frames()) {
    const a11y = await frame.evaluate(collectA11yInPage, 'body').catch(() => []);
    const dom = await frame.evaluate(collectFieldsInPage, 'body').catch(() => []);
    const fillable = a11y.filter(n => n.name || n.role === 'file');
    frames.push({ url: frame.url(), a11yControls: fillable.length, domFields: dom.length });
    for (const n of fillable) controls.push({ role: n.role, name: n.name });
  }
  const outline = await page.evaluate(pageOutline).catch(() => null);
  return { frames, controls, outline };
}

/**
 * Record an unknown application page that defeated the deterministic flow, just
 * before the caller throws. Best-effort by contract: it must never change the
 * apply outcome or throw — any failure is swallowed and logged as a warning.
 *
 * @returns the capture row id, or null if capture failed.
 */
export async function captureUnsolvedPage(page, { job = null, vendor = null, stage, reason = '' } = {}) {
  try {
    const url = page.url();
    const host = safeHost(url);
    const title = await page.title().catch(() => '');
    const snapshot = await buildSnapshot(page);
    const fingerprint = fingerprintOf(host, snapshot.controls);

    const id = upsertPageCapture({
      jobId: job?.id ?? null, vendor, host, url, title, fingerprint,
      failureStage: stage, failureReason: String(reason || '').slice(0, 300),
      controlCount: snapshot.controls.length,
    });

    const dir = path.join(snapshotsDir(), fingerprint.slice(0, 8));
    fs.mkdirSync(dir, { recursive: true });
    const snapshotPath = path.join(dir, `${id}.json`);
    const screenshotPath = path.join(dir, `${id}.png`);
    fs.writeFileSync(snapshotPath, JSON.stringify(
      { capturedAt: new Date().toISOString(), url, host, title, vendor, stage, reason, ...snapshot },
      null, 2,
    ));
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    setCapturePaths(id, snapshotPath, screenshotPath);

    emit({
      jobId: job?.id, stage: 'apply', level: 'info',
      message: `Captured unsolved page (${stage}) — ${host}, ${snapshot.controls.length} control(s) [${fingerprint.slice(0, 8)}]`,
    });
    return id;
  } catch (err) {
    emit({ stage: 'apply', level: 'warn', message: `Page capture failed (non-fatal): ${err.message}` });
    return null;
  }
}
