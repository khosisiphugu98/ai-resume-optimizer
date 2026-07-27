import fs from 'node:fs';
import path from 'node:path';
import { PATHS, SELECTORS } from '../config.js';
import { bumpRate, getSetting } from '../db.js';
import { assertNoChallenge, ChallengeDetected } from '../browser.js';
import { collectFieldsInPage, fillField, fromDomField } from './fields.js';
import { collectA11yInPage, toFieldSpec, fillA11yField } from './a11y.js';
import { runWizard, buttonByName, stepSignature, firstVisible, waitForFirstVisible, captureFailureContext, ADVANCE_NAME, TERMINAL_NAME } from './wizard.js';
import { resolveFormBatch } from '../answer/resolver.js';
import { normaliseQuestion } from '../answer/bank.js';
import { detectVendor } from './adapters/index.js';
import { captureUnsolvedPage } from './agent/capture.js';
import { runAgent } from './agent/index.js';

/**
 * Map an adaptive-agent result into the standard applyExternal return. The agent
 * is fill-only, so a solved page comes back as 'ready' (held for review) or
 * 'parked' — never 'submitted'.
 */
function agentReturn(a, { vendor, url, screenshots }) {
  const base = {
    vendor: vendor.vendor, url, filled: a.filled, screenshots, steps: a.steps,
    agent: { kind: a.planKind, fingerprint: a.fingerprint },
  };
  if (a.outcome === 'submitted') {
    return { outcome: 'submitted', ...base, evidence: a.evidence || null };
  }
  if (a.outcome === 'parked') {
    return {
      outcome: 'parked', ...base,
      parked: (a.parked || []).map(p => ({
        question: p.question, questionNorm: normaliseQuestion(p.question),
        fieldType: p.fieldType, options: p.options, reason: p.reason, tier: p.tier,
      })),
    };
  }
  return { outcome: 'ready', ...base };
}

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
export async function applyExternal(page, job, ctx, { submit = false, resumePath = null, approved = false } = {}) {
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

  // A sign-in page is not an application form.
  //
  // Postings whose apply link points at a Google Doc, or at a board that requires
  // an account, land on an identity provider. The collector sees a text input and
  // a Next button and treats it as step one of a form: it typed the candidate's
  // email into Google's sign-in, failed to advance, escalated to the agent, and
  // burned a retry — three of the seventeen captured "unsolved forms" in the
  // database are accounts.google.com, the single most common shape. Nothing good
  // is reachable from here without credentials, so it stops being an error and
  // becomes an honest hand-off.
  const wall = await loginWall(page);
  if (wall) {
    return { outcome: 'manual', vendor: vendor.vendor, reason: wall, url, filled: [], screenshots };
  }

  // A form with no native controls is invisible to formScope's input count, so
  // falling back to the accessibility tree is what makes an unknown React
  // careers site reachable at all.
  const scope = (await formScope(page, vendor)) || (await a11yScope(page));
  if (!scope) {
    const agent = await runAgent(page, {
      job, ctx: { ...ctx, ats: vendor.vendor }, resumePath, submit,
      stage: 'no-form', reason: `No application form found on ${vendor.vendor} page`,
    });
    if (agent) return agentReturn(agent, { vendor, url, screenshots });
    await captureUnsolvedPage(page, { job, vendor: vendor.vendor, stage: 'no-form',
      reason: `No application form found on ${vendor.vendor} page` });
    throw new Error(`No application form found on ${vendor.vendor} page`);
  }

  const { frame, rootSelector } = scope;
  const answerCtx = { ...ctx, ats: vendor.vendor };

  const first = await collectFields(frame, rootSelector, vendor);
  if (!first.items.length) {
    const agent = await runAgent(page, {
      job, ctx: answerCtx, resumePath, submit,
      stage: 'no-fields', reason: `Form on ${vendor.vendor} had no fillable fields`,
    });
    if (agent) return agentReturn(agent, { vendor, url, screenshots });
    await captureUnsolvedPage(page, { job, vendor: vendor.vendor, stage: 'no-fields',
      reason: `Form on ${vendor.vendor} had no fillable fields` });
    throw new Error(`Form on ${vendor.vendor} had no fillable fields`);
  }

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

  // `requiresReview` is a policy about unrecognised forms, not a law of physics.
  //
  // It was an unconditional constant, so for the 80% of external postings that
  // resolve to no known vendor the submit intent was discarded before the wizard
  // started — in every mode, and even for a job a human had explicitly approved.
  // Approving one re-filled the form and flipped it back to awaiting_review, on
  // every cycle, forever. Two ways past it now, both requiring a person: an
  // explicit approval of this job, or an operator who has turned the setting on
  // with their eyes open. Neither is the default.
  const override = approved || genericAutoSubmitAllowed();
  const maySubmit = submit && (!vendor.requiresReview || override);

  const result = await runWizard({
    submit: maySubmit,
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

  if (result.outcome === 'stuck') {
    const agent = await runAgent(page, {
      job, ctx: answerCtx, resumePath, submit, stage: 'stuck', reason: result.reason,
    });
    if (agent) return agentReturn(agent, { vendor, url, screenshots });
    await captureUnsolvedPage(page, { job, vendor: vendor.vendor, stage: 'stuck', reason: result.reason });
    throw new Error(result.reason);
  }

  // Reached the end of the form without pressing submit.
  if (result.outcome === 'ready') {
    return {
      outcome: 'ready', vendor: vendor.vendor, url, filled, screenshots, steps: result.steps,
      // Why, in words the operator can act on. This string was already being built
      // and then dropped on the floor by run.js, so "Ready for review" in auto mode
      // looked like a bug rather than a policy.
      heldForReview: !maySubmit && submit
        ? `the ${vendor.vendor} adapter does not auto-submit — approve this application, or turn on generic auto-submit in settings`
        : null,
    };
  }

  const before = page.url();
  await result.terminal.click();
  await page.waitForTimeout(5000);

  const evidence = await shot(page, job.id, `${vendor.vendor}-submitted`);
  screenshots.push(evidence);

  const confirmed = await sawConfirmation(page, vendor, before);

  // Never throw here. Throwing marked the job apply_failed, and apply_failed is
  // re-selected on the next cycle — so a submission that actually went through but
  // confirmed in a way we did not recognise was silently sent again. To a recruiter
  // that is a duplicate application; to us it looked like a retry of a failure.
  // An unverified click is its own outcome, terminal, and a person decides.
  if (!confirmed) {
    return {
      outcome: 'submitted_unconfirmed', vendor: vendor.vendor, url, filled, screenshots,
      steps: result.steps, evidence,
      reason: 'clicked submit but saw no confirmation — it may have gone through, so it will not be retried automatically',
    };
  }

  return { outcome: 'submitted', vendor: vendor.vendor, url, filled, screenshots, steps: result.steps, evidence };
}

/**
 * Whether the operator has allowed unrecognised forms to submit themselves.
 *
 * Off unless explicitly turned on. An unrecognised form is one nobody has read the
 * shape of, so auto-submitting it is a genuine risk decision — it belongs to a
 * person, taken once, deliberately, and reversible from the same place.
 */
export function genericAutoSubmitAllowed() {
  return getSetting('allow_generic_autosubmit') === '1';
}

/** Identity providers an apply link can bounce through. */
const IDENTITY_HOSTS = /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|.*\.okta\.com|.*\.auth0\.com|signin\.aws\.amazon\.com|github\.com\/login|appleid\.apple\.com)/i;

/** Why this page is a login wall rather than an application, or null. */
async function loginWall(page) {
  const url = page.url();
  try {
    const host = new URL(url).host;
    if (IDENTITY_HOSTS.test(host) || IDENTITY_HOSTS.test(`${host}${new URL(url).pathname}`)) {
      return `the apply link lands on a sign-in page (${host}) — this needs an account, so it cannot be completed unattended`;
    }
  } catch { /* an unparseable URL is not a login wall */ }

  // A password box is the giveaway on a site with its own account system. Checked
  // across frames, since these are often embedded.
  for (const frame of page.frames()) {
    const pw = await frame.locator('input[type="password"]:visible').count().catch(() => 0);
    if (pw > 0) {
      return 'the application page asks for a password — it needs an account, so it cannot be completed unattended';
    }
  }
  return null;
}

/**
 * Did the page acknowledge the submission?
 *
 * Two changes from the original single-expression check. The confirmation text is
 * read from every frame, not just the main one: these forms routinely live in an
 * iframe — `formScope` walks frames precisely because of that — and a board that
 * confirms inside the same iframe left `page.locator('body')` reading the host
 * page and finding nothing. And a bare URL change is no longer sufficient on its
 * own; an SPA route change, an appended tracking parameter or a redirect to a
 * login wall all changed the URL without anything being submitted. A URL change
 * now counts only alongside the form having actually gone away.
 */
async function sawConfirmation(page, vendor, urlBefore) {
  const texts = await Promise.all(
    page.frames().map(f => f.locator('body').innerText().catch(() => '')),
  );
  if (texts.some(t => vendor.success.some(re => re.test(t)))) return true;

  if (page.url() === urlBefore) return false;

  // The URL moved. Treat that as confirmation only if the form we just submitted
  // is no longer on the page — a redirect that still shows the form is a failure
  // or a login wall, not an acknowledgement.
  const scope = await formScope(page).catch(() => null);
  if (!scope) return true;
  const stillThere = await scope.locator('input, select, textarea').count().catch(() => 0);
  return stillThere === 0;
}

export { ChallengeDetected };
