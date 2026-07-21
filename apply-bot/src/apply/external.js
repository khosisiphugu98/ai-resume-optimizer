import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';
import { assertNoChallenge, ChallengeDetected } from '../browser.js';
import { collectFieldsInPage, fillField } from './fields.js';
import { resolveForm } from '../answer/resolver.js';
import { normaliseQuestion } from '../answer/bank.js';
import { detectVendor } from './adapters/index.js';

async function shot(page, jobId, label) {
  const dir = path.join(PATHS.artifacts, 'screenshots', String(jobId));
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${Date.now()}-${label}.png`);
  await page.screenshot({ path: p, fullPage: true }).catch(() => {});
  return p;
}

async function firstVisible(scope, selectors) {
  for (const sel of selectors) {
    const loc = scope.locator(sel).first();
    if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

/**
 * These boards are frequently embedded in an iframe on the company's own careers
 * domain, so the form is not in the main frame. Pick whichever frame actually
 * contains form controls.
 */
export async function formScope(page, vendor) {
  for (const frame of page.frames()) {
    for (const sel of vendor.formRoot) {
      const n = await frame.locator(sel).count().catch(() => 0);
      if (!n) continue;
      const inputs = await frame.locator(`${sel} input, ${sel} select, ${sel} textarea`).count().catch(() => 0);
      if (inputs > 0) return { frame, rootSelector: sel };
    }
  }
  return null;
}

/**
 * Follow LinkedIn's Apply button out to the real ATS. It usually opens a new tab
 * behind a redirect shim, so we wait for the popup and let it settle on its final
 * URL rather than trusting the first href.
 */
export async function resolveExternalUrl(page, job) {
  if (job.external_apply_url) return job.external_apply_url;

  await page.goto(job.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await assertNoChallenge(page);

  const applyBtn = await firstVisible(page, ['.jobs-apply-button', 'button.jobs-apply-button--top-card']);
  if (!applyBtn) throw new Error('No apply button — posting may have closed');

  const ctx = page.context();
  const popupPromise = ctx.waitForEvent('page', { timeout: 20_000 }).catch(() => null);
  await applyBtn.click();

  const popup = await popupPromise;
  if (!popup) {
    await page.waitForTimeout(2500);
    const url = page.url();
    if (/linkedin\.com/i.test(url)) throw new Error('Apply did not leave LinkedIn — may actually be Easy Apply');
    return url;
  }

  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  await popup.waitForTimeout(3000);   // let redirect shims settle
  const finalUrl = popup.url();
  await popup.close().catch(() => {});
  return finalUrl;
}

/**
 * Apply on an external ATS.
 *
 * Identical shape to the Easy Apply adapter so the pipeline treats them the same:
 * fill everything, park rather than guess, and never submit in review mode.
 */
export async function applyExternal(page, job, ctx, { submit = false, resumePath = null } = {}) {
  const screenshots = [];
  const filled = [];

  const url = job.external_apply_url;
  if (!url) throw new Error('No resolved external apply URL');

  const vendor = detectVendor(url);
  if (vendor.deferred) {
    return { outcome: 'manual', vendor: vendor.vendor, reason: vendor.why, url, filled, screenshots };
  }

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  screenshots.push(await shot(page, job.id, `${vendor.vendor}-open`));

  const scope = await formScope(page, vendor);
  if (!scope) throw new Error(`No application form found on ${vendor.vendor} page`);

  const { frame, rootSelector } = scope;
  const fields = await frame.evaluate(collectFieldsInPage, rootSelector);

  const fileFields = fields.filter(f => f.kind === 'file');
  const formFields = fields.filter(f => f.kind !== 'file' && f.question);

  if (!formFields.length && !fileFields.length) {
    throw new Error(`Form on ${vendor.vendor} had no fillable fields`);
  }

  // Resume upload first — several boards parse it and prefill the rest.
  for (const f of fileFields) {
    if (!resumePath) continue;
    try {
      await fillField(frame, f, resumePath);
      filled.push({ question: f.question || 'Resume', value: path.basename(resumePath), tier: 'resume', kind: 'file' });
      await page.waitForTimeout(2500);
    } catch { /* optional attachment slots are common */ }
  }

  // Re-read fields — an autofilled form has different values, and some boards
  // reveal extra questions only after the resume is parsed.
  const refreshed = await frame.evaluate(collectFieldsInPage, rootSelector);
  const toResolve = refreshed.filter(f => f.kind !== 'file' && f.question);

  const { resolved, parked } = await resolveForm(toResolve, { ...ctx, ats: vendor.vendor });

  if (parked.length) {
    return {
      outcome: 'parked', vendor: vendor.vendor, url, filled, screenshots,
      parked: parked.map(p => ({
        question: p.question, questionNorm: normaliseQuestion(p.question),
        fieldType: p.fieldType, options: p.options, reason: p.reason, tier: p.tier,
      })),
    };
  }

  for (const r of resolved) {
    if (r.status !== 'ok') continue;
    const field = toResolve.find(f => f.question === r.question);
    if (!field) continue;
    // Don't clobber a value the board autofilled correctly from the resume.
    if (field.currentValue && String(field.currentValue).trim() === String(r.value).trim()) {
      filled.push({ question: r.question, value: r.value, tier: 'prefilled', kind: field.kind });
      continue;
    }
    try {
      const landed = await fillField(frame, field, r.value);
      filled.push({ question: r.question, value: landed, tier: r.tier, kind: field.kind, probable: !!r.probable });
    } catch (err) {
      return {
        outcome: 'parked', vendor: vendor.vendor, url, filled, screenshots,
        parked: [{
          question: r.question, questionNorm: normaliseQuestion(r.question),
          fieldType: r.fieldType, options: field.options,
          reason: `could not apply "${r.value}": ${err.message}`, tier: 'fill-error',
        }],
      };
    }
  }

  screenshots.push(await shot(page, job.id, `${vendor.vendor}-filled`));

  // An unknown form is never auto-submitted, whatever the mode.
  if (!submit || vendor.requiresReview) {
    return {
      outcome: 'ready', vendor: vendor.vendor, url, filled, screenshots,
      heldForReview: vendor.requiresReview && submit ? 'generic adapter never auto-submits' : null,
    };
  }

  const submitBtn = await firstVisible(frame, vendor.submit);
  if (!submitBtn) throw new Error(`No submit button found on ${vendor.vendor}`);

  const before = page.url();
  await submitBtn.click();
  await page.waitForTimeout(5000);

  const evidence = await shot(page, job.id, `${vendor.vendor}-submitted`);
  screenshots.push(evidence);

  const body = await page.locator('body').innerText().catch(() => '');
  const confirmed = vendor.success.some(re => re.test(body)) || page.url() !== before;
  if (!confirmed) throw new Error('Clicked submit but saw no confirmation');

  return { outcome: 'submitted', vendor: vendor.vendor, url, filled, screenshots, evidence };
}

export { ChallengeDetected };
