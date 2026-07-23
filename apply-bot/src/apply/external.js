import fs from 'node:fs';
import path from 'node:path';
import { PATHS, SELECTORS } from '../config.js';
import { bumpRate } from '../db.js';
import { assertNoChallenge, ChallengeDetected } from '../browser.js';
import { collectFieldsInPage, fillField, fromDomField } from './fields.js';
import { collectA11yInPage, toFieldSpec, fillA11yField } from './a11y.js';
import { runWizard, buttonByName, stepSignature, firstVisible, waitForFirstVisible, captureFailureContext, ADVANCE_NAME, TERMINAL_NAME } from './wizard.js';
import { resolveFormBatch } from '../answer/resolver.js';
import { normaliseQuestion } from '../answer/bank.js';
import { detectVendor } from './adapters/index.js';

async function shot(page, jobId, label) {
  const dir = path.join(PATHS.artifacts, 'screenshots', String(jobId));
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${Date.now()}-${label}.png`);
  await page.screenshot({ path: p, fullPage: true }).catch(() => {});
  return p;
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
 * Where the form is when `formScope` cannot see it — a form built from
 * `div[role="textbox"]`, or one inside a web component, contains no native
 * controls at all, so counting inputs finds nothing.
 *
 * Picks the frame with the most accessible form controls rather than the first
 * with any, because a page often carries a stray search box in the header.
 */
export async function a11yScope(page) {
  let best = null;
  for (const frame of page.frames()) {
    const nodes = await frame.evaluate(collectA11yInPage, 'body').catch(() => []);
    const fillable = nodes.filter(n => n.role !== 'file' && n.name);
    if (fillable.length && (!best || fillable.length > best.count)) {
      best = { frame, rootSelector: 'body', count: fillable.length };
    }
  }
  return best;
}

const fromA11y = n => ({ ...toFieldSpec(n), collector: 'a11y', role: n.role });

/**
 * Collect the current step's fields.
 *
 * The DOM collector runs first: it is faster, deterministic, and right for the
 * native-control forms that make up most vendor boards. The a11y collector is the
 * fallback for everything else, and finding fewer than two fillable fields is the
 * signal that the form is not made of native controls at all.
 */
export async function collectFields(frame, rootSelector, vendor) {
  if (!vendor.a11y) {
    const dom = await frame.evaluate(collectFieldsInPage, rootSelector).catch(() => []);
    const fillable = dom.filter(f => f.kind !== 'file' && f.question);
    if (fillable.length >= 2) return { mode: 'dom', items: dom.map(fromDomField) };
  }
  const nodes = await frame.evaluate(collectA11yInPage, rootSelector).catch(() => []);
  const items = nodes.filter(n => n.name || n.role === 'file').map(fromA11y);
  if (items.length) return { mode: 'a11y', items };

  // Nothing from either collector — report the DOM result so the caller's error
  // describes an empty form rather than an a11y miss.
  const dom = await frame.evaluate(collectFieldsInPage, rootSelector).catch(() => []);
  return { mode: 'dom', items: dom.map(fromDomField) };
}

/** Apply one value, whichever collector found the control. */
export function fillCollected(frame, item, value) {
  return item.collector === 'a11y'
    ? fillA11yField(frame, item.node, value)
    : fillField(frame, item.field, value);
}

/**
 * Follow LinkedIn's Apply button out to the real ATS. It usually opens a new tab
 * behind a redirect shim, so we wait for the popup and let it settle on its final
 * URL rather than trusting the first href.
 */
export async function resolveExternalUrl(page, job) {
  if (job.external_apply_url) return job.external_apply_url;

  await page.goto(job.url, { waitUntil: 'domcontentloaded' });
  // A signed-in posting view, and therefore chargeable against the pageview cap
  // that keeps the account under LinkedIn's radar. Counting it here matters
  // because a board full of unresolved external jobs spends one of these each.
  bumpRate('linkedin_pageviews');
  await assertNoChallenge(page);

  // Must come from SELECTORS: the new server-driven UI ships hashed class names,
  // so `.jobs-apply-button` matches nothing on a rolled-out account and every
  // external job would fail here as "posting may have closed". Poll rather than
  // check once — the top card (and its Apply button) hydrates after first paint,
  // so a single check moments after navigation loses the race on an open posting.
  const applyBtn = await waitForFirstVisible(page, SELECTORS.detailApplyBtn, { timeout: 10_000 });
  if (!applyBtn) {
    const ctx = await captureFailureContext(page, shot, job.id, 'no-apply-button');
    throw new Error(
      `No apply button after 10s — posting may have closed, or the selector broke. ` +
      `url=${ctx.url} title="${ctx.title}" buttons=[${ctx.buttons.join(' | ')}]`);
  }

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

  const url = job.external_apply_url;
  if (!url) throw new Error('No resolved external apply URL');

  const vendor = detectVendor(url);
  if (vendor.deferred) {
    return { outcome: 'manual', vendor: vendor.vendor, reason: vendor.why, url, filled: [], screenshots };
  }

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  screenshots.push(await shot(page, job.id, `${vendor.vendor}-open`));

  // A form with no native controls is invisible to formScope's input count, so
  // falling back to the accessibility tree is what makes an unknown React
  // careers site reachable at all.
  const scope = (await formScope(page, vendor)) || (await a11yScope(page));
  if (!scope) throw new Error(`No application form found on ${vendor.vendor} page`);

  const { frame, rootSelector } = scope;
  const answerCtx = { ...ctx, ats: vendor.vendor };

  const first = await collectFields(frame, rootSelector, vendor);
  if (!first.items.length) throw new Error(`Form on ${vendor.vendor} had no fillable fields`);

  // Uploads are handled here rather than through the answer resolver, and inside
  // collect rather than once up front — a wizard can put an attachment slot on
  // any step, and several boards parse the resume and prefill the rest of the
  // form from it, which is worth having happen before anything is resolved.
  const uploaded = [];
  const uploadedUids = new Set();

  const collect = async () => {
    const { items } = await collectFields(frame, rootSelector, vendor);

    for (const item of items) {
      if (item.role !== 'file' || !resumePath || uploadedUids.has(item.uid)) continue;
      uploadedUids.add(item.uid);
      try {
        await fillCollected(frame, item, resumePath);
        uploaded.push({
          uid: item.uid, question: item.question || 'Resume',
          value: path.basename(resumePath), tier: 'resume', kind: 'file',
        });
        await page.waitForTimeout(2500);
      } catch { /* optional attachment slots are common */ }
    }

    return items.filter(i => i.role !== 'file' && i.question);
  };

  const result = await runWizard({
    submit: submit && !vendor.requiresReview,
    collect,

    resolve: items => resolveFormBatch(items, answerCtx),
    fill: (item, value) => fillCollected(frame, item, value),

    // A button named "Submit" ends the form. A button named "Continue" never
    // does, whatever its type — on a multi-step form the Next button is usually
    // `type=submit` as well, and the vendor's submit selector would match it and
    // file a half-finished application as though it were complete.
    findTerminal: async () => {
      const named = await buttonByName(frame, TERMINAL_NAME);
      if (named) return named;
      if (await buttonByName(frame, ADVANCE_NAME)) return null;
      return firstVisible(frame, vendor.submit);
    },
    findAdvance: () => buttonByName(frame, ADVANCE_NAME),
    signature: stepSignature,
    onStep: async ({ step }) => {
      screenshots.push(await shot(page, job.id, `${vendor.vendor}-step-${step}`));
    },
  });

  const filled = [...uploaded, ...result.filled];

  if (result.outcome === 'parked') {
    return {
      outcome: 'parked', vendor: vendor.vendor, url, filled, screenshots, steps: result.steps,
      parked: result.parked.map(p => ({
        question: p.question, questionNorm: normaliseQuestion(p.question),
        fieldType: p.fieldType, options: p.options, reason: p.reason, tier: p.tier,
      })),
    };
  }

  if (result.outcome === 'stuck') throw new Error(result.reason);

  // An unknown form is never auto-submitted, whatever the mode.
  if (result.outcome === 'ready') {
    return {
      outcome: 'ready', vendor: vendor.vendor, url, filled, screenshots, steps: result.steps,
      heldForReview: vendor.requiresReview && submit ? 'generic adapter never auto-submits' : null,
    };
  }

  const before = page.url();
  await result.terminal.click();
  await page.waitForTimeout(5000);

  const evidence = await shot(page, job.id, `${vendor.vendor}-submitted`);
  screenshots.push(evidence);

  const body = await page.locator('body').innerText().catch(() => '');
  const confirmed = vendor.success.some(re => re.test(body)) || page.url() !== before;
  if (!confirmed) throw new Error('Clicked submit but saw no confirmation');

  return { outcome: 'submitted', vendor: vendor.vendor, url, filled, screenshots, steps: result.steps, evidence };
}

export { ChallengeDetected };
