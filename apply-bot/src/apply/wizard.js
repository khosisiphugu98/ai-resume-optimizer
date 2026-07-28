/**
 * The shared multi-step form loop.
 *
 * Easy Apply, Workday and every unknown React careers site are the same machine:
 * collect the visible fields, resolve them, fill them, look for a way forward,
 * repeat until something says Submit. Only the selectors differ. This is that
 * machine, parameterised.
 *
 * Two guards matter more than the loop itself:
 *
 * - **No-progress detection.** A Next button that does nothing — because a
 *   validation error is showing, or the click landed on a disabled control — puts
 *   the loop in a spin that only MAX_STEPS ends, after eight rounds of LLM calls
 *   and screenshots. Comparing the form signature between steps catches it on the
 *   first repeat and abandons with a reason.
 *
 * - **Re-collection after filling.** "Do you require sponsorship? → Yes" reveals
 *   three more questions. Advancing without re-reading submits the step with
 *   those blank, which either fails validation or, worse, does not.
 */

export const MAX_STEPS = 8;

/** Re-reads per step, after which a form revealing endless fields is abandoned. */
export const MAX_RECOLLECTS = 3;

/**
 * Drive one multi-step form.
 *
 * The caller supplies the vendor-specific parts:
 *   collect()            → field nodes for the current step
 *   resolve(nodes)       → { resolved, parked }
 *   fill(node, value)    → applies one value, throws if it cannot
 *   findAdvance()        → a locator to move forward, or null
 *   findTerminal()       → a locator that submits, or null
 *   signature(nodes)     → a comparable identity for the step
 *   onStep({ step })     → optional; screenshots, event emission
 *   mayFinish({filled})  → optional; a reason to hold instead of pressing
 *                          submit, or null to allow it. Checked at the
 *                          terminal button, because that is the first moment
 *                          the caller knows what the form actually turned out
 *                          to be — `submit` is decided before a single field
 *                          has been seen.
 *
 * Returns { outcome, filled, parked, steps, reason }. `outcome` is one of
 * `ready` (reached submit, did not press it), `submitted`, `parked`, `stuck`.
 */
export async function runWizard({
  collect, resolve, fill, findAdvance, findTerminal, signature,
  onStep = null, beforeAdvance = null, mayFinish = null, submit = false, maxSteps = MAX_STEPS,
}) {
  const filled = [];
  // Questions this run could not answer. Collected rather than returned on sight,
  // so the step is completed and captured before the run ends — see the note at
  // the resolve() call below.
  const parkedFields = [];
  let steps = 0;
  let lastSignature = null;

  while (steps < maxSteps) {
    steps++;

    // --- fill this step, re-reading until it stops changing ----------------
    let nodes = await collect();
    let signatureNow = signature(nodes);

    for (let round = 0; round < MAX_RECOLLECTS; round++) {
      const unfilled = nodes.filter(n => !filled.some(f => f.uid && f.uid === n.uid));
      if (!unfilled.length) break;

      const { resolved, parked } = await resolve(unfilled);

      // A park is recorded and the step still gets filled.
      //
      // Returning here meant one unanswerable required field discarded the whole
      // application before a single character was typed — which is why LinkedIn
      // Easy Apply recorded thirteen attempts averaging 0.0 fields filled. The
      // answers we do have are worth keeping: they are what the review card shows,
      // what an operator corrects, and what the bank learns from. Nothing is
      // submitted while `parkedFields` holds anything; the step simply finishes its
      // work first, and the wizard stops at the end of it.
      if (parked.length) parkedFields.push(...parked);

      for (const r of resolved) {
        if (r.status !== 'ok') continue;
        const node = unfilled.find(n => n.uid === r.uid);
        if (!node) continue;

        // A board that parsed the resume may have already filled this in with the
        // same value. Rewriting it risks clobbering a better value with our own,
        // and several boards clear dependent fields when one is retyped.
        if (node.currentValue && String(node.currentValue).trim() === String(r.value).trim()) {
          filled.push({ uid: node.uid, question: r.question, value: r.value, tier: 'prefilled', kind: node.role });
          continue;
        }

        try {
          const landed = await fill(node, r.value);
          filled.push({
            uid: node.uid, question: r.question, value: landed,
            tier: r.tier, kind: node.role, probable: !!r.probable,
          });
        } catch (err) {
          // A value that will not go into the control is not an answer. Record it
          // and carry on with the rest of the step — one stubborn control must not
          // cost the fields that would have gone in cleanly.
          parkedFields.push({
            question: r.question, fieldType: r.fieldType, options: node.options,
            reason: `could not apply "${r.value}": ${err.message}`, tier: 'fill-error',
          });
        }
      }

      // Filling may have revealed more questions. If the shape did not change,
      // it did not.
      const after = await collect();
      const afterSignature = signature(after);
      if (afterSignature === signatureNow) break;
      nodes = after;
      signatureNow = afterSignature;
    }

    if (onStep) await onStep({ step: steps, nodes });

    // --- anything unanswered ends the run, now that the step is done --------
    //
    // The step has been filled as far as it could be and captured, so the review
    // card shows real work rather than an empty form. Advancing past an unanswered
    // required field would only fail validation on the next screen, and submitting
    // is out of the question — so this is where the run stops.
    if (parkedFields.length) {
      return { outcome: 'parked', parked: parkedFields, filled, steps };
    }

    // --- terminal? ---------------------------------------------------------
    const terminal = await findTerminal();
    if (terminal) {
      if (!submit) return { outcome: 'ready', filled, steps };
      const hold = mayFinish ? await mayFinish({ filled, steps }) : null;
      if (hold) return { outcome: 'ready', filled, steps, reason: hold };
      return { outcome: 'submit', terminal, filled, steps };
    }

    // --- advance -----------------------------------------------------------
    const next = await findAdvance();
    if (!next) {
      return {
        outcome: 'stuck', filled, steps,
        reason: `step ${steps} has no next, review or submit control`,
      };
    }

    // Two consecutive steps with an identical form means the button did nothing.
    // Detected here rather than after MAX_STEPS so the run does not burn eight
    // rounds of LLM calls on a form that is standing still.
    if (lastSignature !== null && signatureNow === lastSignature) {
      return {
        outcome: 'stuck', filled, steps,
        reason: `form did not advance past step ${steps - 1} — the same fields came back after clicking next`,
      };
    }
    lastSignature = signatureNow;

    if (beforeAdvance) await beforeAdvance({ step: steps });
    await next.click();
    await next.page().waitForTimeout(1800);
  }

  return { outcome: 'stuck', filled, steps, reason: `exceeded ${maxSteps} steps without reaching submit` };
}

/**
 * A step's identity, for telling "this revealed new questions" apart from "this
 * form is not advancing".
 *
 * Deliberately role+question rather than uid: a SPA that re-renders the same step
 * produces fresh DOM nodes and therefore fresh uids, and comparing those would
 * report progress where there is none.
 */
export function stepSignature(items) {
  return items.map(i => `${i.role}|${i.question}`).sort().join('\n');
}

/** Accessible-name patterns for moving forward and for finishing. */
export const ADVANCE_NAME = /^\s*(next|continue|save and continue|proceed|review)/i;
export const TERMINAL_NAME = /^\s*(submit|send application|finish|complete)/i;

/**
 * Find a button by accessible name. Uses Playwright's role engine rather than the
 * in-page accname computation, because it already implements the full spec and
 * pierces open shadow roots.
 */
export async function buttonByName(scope, pattern) {
  const byRole = scope.getByRole('button', { name: pattern }).first();
  if (await byRole.count().catch(() => 0) && await byRole.isVisible().catch(() => false)) return byRole;

  // Some sites label a submit control with an <input type=submit> value, which
  // the role engine matches but a text query does not.
  const bySubmit = scope.locator('input[type=submit]').first();
  if (await bySubmit.count().catch(() => 0)) {
    const value = await bySubmit.getAttribute('value').catch(() => '');
    if (pattern.test(value || '') && await bySubmit.isVisible().catch(() => false)) return bySubmit;
  }
  return null;
}

/** First selector in the list that is present and visible. */
export async function firstVisible(scope, selectors) {
  for (const sel of selectors) {
    const loc = scope.locator(sel).first();
    if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

/**
 * Like firstVisible, but polls until something shows or the timeout elapses.
 *
 * LinkedIn's server-driven UI hydrates the top card — including the Apply button —
 * after the initial paint, so a single check a fixed moment after navigation is a
 * race the runner keeps losing: the button is simply not there yet, and the run
 * dies as "posting may have closed" on a posting that is perfectly open.
 */
export async function waitForFirstVisible(scope, selectors, { timeout = 10_000, interval = 400 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hit = await firstVisible(scope, selectors);
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, interval));
  }
}

/**
 * A screenshot plus the page's own account of itself, for when an expected
 * control never appears. A bare "no apply button" says nothing about whether the
 * posting closed, the selector broke, or a login wall came up — this captures
 * enough to tell those apart without a live session.
 */
export async function captureFailureContext(page, shot, jobId, label) {
  const [screenshot, url, title, buttons] = await Promise.all([
    shot(page, jobId, label).catch(() => null),
    Promise.resolve(page.url()),
    page.title().catch(() => ''),
    page.evaluate(() => Array.from(document.querySelectorAll('button, a[role="button"], [aria-label*="pply" i]'))
      .map(b => (b.getAttribute('aria-label') || b.textContent || '').trim())
      .filter(Boolean).slice(0, 12)).catch(() => []),
  ]);
  return { screenshot, url, title, buttons };
}
