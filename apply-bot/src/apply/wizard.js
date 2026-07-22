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
 *
 * Returns { outcome, filled, parked, steps, reason }. `outcome` is one of
 * `ready` (reached submit, did not press it), `submitted`, `parked`, `stuck`.
 */
export async function runWizard({
  collect, resolve, fill, findAdvance, findTerminal, signature,
  onStep = null, beforeAdvance = null, submit = false, maxSteps = MAX_STEPS,
}) {
  const filled = [];
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
      if (parked.length) return { outcome: 'parked', parked, filled, steps };

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
          // A value that will not go into the control is not an answer. Park it
          // rather than submitting the form with the field blank.
          return {
            outcome: 'parked', filled, steps,
            parked: [{
              question: r.question, fieldType: r.fieldType, options: node.options,
              reason: `could not apply "${r.value}": ${err.message}`, tier: 'fill-error',
            }],
          };
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

    // --- terminal? ---------------------------------------------------------
    const terminal = await findTerminal();
    if (terminal) {
      if (!submit) return { outcome: 'ready', filled, steps };
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
