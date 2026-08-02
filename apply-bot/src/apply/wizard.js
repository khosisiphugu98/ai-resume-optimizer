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
 * How long a step gets to produce a way forward before it is called stuck.
 *
 * Only ever spent on the path that was about to abandon the application, so it
 * costs nothing on a form that is working.
 */
export const CONTROL_RENDER_TIMEOUT = 6000;

/** The terminal control if there is one, otherwise the way onward. */
async function wayForward(findTerminal, findAdvance) {
  const terminal = await findTerminal();
  if (terminal) return { terminal, next: null };
  return { terminal: null, next: await findAdvance() };
}

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
 *   verify(node)         → optional; the control's current value, read back out
 *                          of the page. See the ledger note below.
 *   mayFinish({filled})  → optional; a reason to hold instead of pressing
 *                          submit, or null to allow it. Checked at the
 *                          terminal button, because that is the first moment
 *                          the caller knows what the form actually turned out
 *                          to be — `submit` is decided before a single field
 *                          has been seen.
 *
 * Returns { outcome, filled, parked, ledger, steps, reason }. `outcome` is one of
 * `ready` (reached submit, did not press it), `submitted`, `parked`, `stuck`.
 */
export async function runWizard({
  collect, resolve, fill, findAdvance, findTerminal, signature,
  onStep = null, beforeAdvance = null, mayFinish = null, verify = null,
  submit = false, maxSteps = MAX_STEPS,
}) {
  const filled = [];
  /**
   * Every control this run saw, and what became of it.
   *
   * `filled` is a record of successes: it holds the questions that got an answer
   * and says nothing whatever about the ones that did not. So a form with eleven
   * fields where four were answered recorded exactly the same thing as a form
   * with four — and the operator watching the browser fill in half a page had no
   * way to show it, because the system's own account of the attempt agreed with
   * itself and mentioned nothing missing.
   *
   * The ledger is the other half: one row per control per step, carrying its
   * disposition and, where the page could be read back, proof that the value is
   * actually in the DOM. `required` travels with it, because a required control
   * that ended up empty is the single most useful line in the whole record.
   */
  const ledger = [];
  const note = (step, node, disposition, extra = {}) => {
    ledger.push({
      step,
      uid: node?.uid ?? null,
      question: String(node?.question ?? '').slice(0, 200),
      role: node?.role ?? node?.fieldType ?? null,
      required: !!node?.required,
      disposition,
      ...extra,
    });
  };
  // Questions this run could not answer. Collected rather than returned on sight,
  // so the step is completed and captured before the run ends — see the note at
  // the resolve() call below.
  const parkedFields = [];
  // Every control this run has already dealt with — filled, prefilled, parked or
  // refused. Kept apart from `filled` because a question asked in two places is
  // recorded once and applied twice, so the record and the set of handled
  // controls are no longer the same list.
  const handled = new Set();
  let steps = 0;
  let lastSignature = null;

  while (steps < maxSteps) {
    steps++;

    // --- fill this step, re-reading until it stops changing ----------------
    // `signature` may be async: an adapter can only tell two field-less steps
    // apart by reading the page, and reading the page is asynchronous.
    let nodes = await collect();
    let signatureNow = await signature(nodes);

    for (let round = 0; round < MAX_RECOLLECTS; round++) {
      const unfilled = nodes.filter(n => n.uid && !handled.has(n.uid));
      if (!unfilled.length) break;

      // One question, however many controls carry it.
      //
      // The Agoda submission recorded 31 fields for 18 unique questions — 13
      // asked twice and answered twice, identically, because the form root held
      // two copies of the control set. Resolving each copy separately doubled
      // the model spend on every such application and made every field count in
      // the system wrong.
      //
      // So the question is resolved once and the answer applied to every control
      // that asks it. That is what already happened in practice; it just cost
      // twice as much and was recorded as though it were twice as much work.
      const groups = new Map();
      for (const n of unfilled) {
        const key = fieldIdentity(n);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(n);
      }
      // Keyed by the uid of the control actually asked about, because that is
      // what comes back on the result. Re-deriving the identity from a resolver
      // result would not work: a result carries `fieldType` where a node carries
      // `role`, and those use different words for the same control.
      const byRepresentative = new Map([...groups.values()].map(g => [g[0].uid, g]));
      const askAbout = [...byRepresentative.values()].map(g => g[0]);

      const { resolved, parked } = await resolve(askAbout);

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
      // A question that parked is settled for this step — asking again on the
      // next re-collect would spend another model call to reach the same answer.
      for (const p of parked) {
        const group = byRepresentative.get(p.uid) || [];
        note(steps, group[0] || p, 'parked', { reason: p.reason ?? null, tier: p.tier ?? null });
        for (const n of group) handled.add(n.uid);
      }

      for (const r of resolved) {
        const group = byRepresentative.get(r.uid) || [];
        const node = group[0];
        if (!node) continue;
        for (const n of group) handled.add(n.uid);
        if (r.status !== 'ok') {
          // The resolver looked at it and produced nothing. Not a park and not a
          // failure — but it is a control that will reach the employer empty, so
          // it belongs in the record rather than nowhere.
          note(steps, node, 'no-answer', { reason: r.reason ?? r.status ?? null });
          continue;
        }

        // Last line before anything is typed. The resolver rejects refusal words
        // at their two model paths, but this is the only point every value from
        // every tier and adapter passes through — and the cost of being wrong
        // here is a word like "unanswerable" sitting in an employer's ATS under
        // the candidate's name. Cheap to check, so it is checked again.
        if (NON_ANSWER_VALUE.test(String(r.value ?? ''))) {
          const reason = `refused to type "${String(r.value).trim()}" — a non-answer reached the fill layer at tier ${r.tier}`;
          parkedFields.push({
            question: r.question, fieldType: r.fieldType, options: node.options,
            reason,
            tier: 'sentinel-blocked',
          });
          note(steps, node, 'refused', { reason, tier: 'sentinel-blocked' });
          continue;
        }

        // The answer goes into every control that asked the question, and is
        // recorded once. `copies` says how many controls took it, so a form that
        // renders itself twice is visible as that rather than as twice the work.
        let landed = null;
        let applied = 0;
        let lastError = null;

        for (const n of group) {
          // A board that parsed the resume may have already filled this in with
          // the same value. Rewriting it risks clobbering a better value with our
          // own, and several boards clear dependent fields when one is retyped.
          if (n.currentValue && String(n.currentValue).trim() === String(r.value).trim()) {
            landed ??= r.value;
            applied++;
            continue;
          }
          try {
            landed = await fill(n, r.value);
            applied++;
          } catch (err) {
            lastError = err;
          }
        }

        if (!applied) {
          // A value that will not go into the control is not an answer. Record it
          // and carry on with the rest of the step — one stubborn control must not
          // cost the fields that would have gone in cleanly.
          const reason = `could not apply "${r.value}": ${lastError?.message || 'no control accepted it'}`;
          parkedFields.push({
            question: r.question, fieldType: r.fieldType, options: node.options,
            reason,
            tier: 'fill-error',
          });
          note(steps, node, 'fill-error', { intended: String(r.value ?? '').slice(0, 120), reason });
          continue;
        }

        const prefilled = landed === r.value && node.currentValue
          && String(node.currentValue).trim() === String(r.value).trim();

        // Did it actually stick?
        //
        // Everything above this line trusts the filler's own word. That word is
        // `String(value)` on a text input — returned whether or not the page kept
        // it — so a controlled component that reverts on its next render reports a
        // clean fill and leaves the box empty. Reading the control back is the only
        // way to tell those apart, and it is the difference between a log that says
        // what was sent and a log that says what was attempted.
        //
        // An unreadable control is not a failed one: `verify` returns null when
        // there is nothing to read, and that is recorded as unverified, never as a
        // revert. Only a control that reads back *differently* is a defect.
        let verified = null;
        let readBack = null;
        if (verify) {
          readBack = await verify(node).catch(() => null);
          if (readBack != null) {
            verified = sameValue(readBack, landed) || sameValue(readBack, r.value);
          }
        }

        note(steps, node, verified === false ? 'reverted' : (prefilled ? 'prefilled' : 'filled'), {
          value: String(landed ?? '').slice(0, 120),
          tier: prefilled ? 'prefilled' : r.tier,
          copies: applied,
          verified,
          ...(verified === false ? { readBack: String(readBack ?? '').slice(0, 120) } : {}),
        });

        // The options travel with the value. Without them a later reader — the
        // pre-send check, or a person looking at the submission record — sees
        // "South Africa +27" against a profile that says "+27 82 820 4538" and
        // cannot tell a correct answer fitted onto a dropdown from a wrong one.
        filled.push({
          uid: node.uid, question: r.question, value: landed,
          tier: prefilled ? 'prefilled' : r.tier,
          kind: node.role, probable: !prefilled && !!r.probable,
          options: node.options || null,
          // Carried onto the record the review card and the submission log read,
          // so "17 fields filled" can be told apart from "17 fields attempted".
          ...(verified === null ? {} : { verified }),
          ...(verified === false ? { readBack: readBack ?? '' } : {}),
          ...(applied > 1 ? { copies: applied } : {}),
        });
      }

      // Filling may have revealed more questions. If the shape did not change,
      // it did not.
      const after = await collect();
      const afterSignature = await signature(after);
      if (afterSignature === signatureNow) break;
      nodes = after;
      signatureNow = afterSignature;
    }

    // Controls that were on the page when the step finished and were never dealt
    // with. Two ways to get here: a node the collector found without a usable uid,
    // and a node revealed on the last re-collect after MAX_RECOLLECTS was spent.
    // Both leave a live control untouched, and neither said so anywhere before.
    for (const n of nodes) {
      if (!n.uid) { note(steps, n, 'no-handle'); continue; }
      if (!handled.has(n.uid)) note(steps, n, 'not-reached');
    }

    if (onStep) await onStep({ step: steps, nodes, ledger });

    // --- anything unanswered ends the run, now that the step is done --------
    //
    // The step has been filled as far as it could be and captured, so the review
    // card shows real work rather than an empty form. Advancing past an unanswered
    // required field would only fail validation on the next screen, and submitting
    // is out of the question — so this is where the run stops.
    if (parkedFields.length) {
      return { outcome: 'parked', parked: parkedFields, filled, ledger, steps };
    }

    // --- a way forward, once the step has finished rendering ----------------
    //
    // Both controls are looked for together, and the absence of both is checked
    // rather than assumed. These forms mount their body before their footer: one
    // live attempt screenshotted the Easy Apply modal 152ms after opening, still
    // showing its loading spinner, and a single check concluded "step 1 has no
    // next, review or submit control" on a form that rendered fine a moment
    // later. That reason accounts for 18 failures on the board, and this is the
    // one path where waiting is free — it only runs when the step was about to
    // be abandoned anyway.
    let { terminal, next } = await wayForward(findTerminal, findAdvance);
    if (!terminal && !next) {
      const deadline = Date.now() + CONTROL_RENDER_TIMEOUT;
      while (Date.now() < deadline && !terminal && !next) {
        await new Promise(r => setTimeout(r, 400));
        ({ terminal, next } = await wayForward(findTerminal, findAdvance));
      }
    }

    if (terminal) {
      if (!submit) return { outcome: 'ready', filled, ledger, steps };
      const hold = mayFinish ? await mayFinish({ filled, steps }) : null;
      if (hold) return { outcome: 'ready', filled, ledger, steps, reason: hold };
      return { outcome: 'submit', terminal, filled, ledger, steps };
    }

    if (!next) {
      return {
        outcome: 'stuck', filled, ledger, steps,
        reason: `step ${steps} has no next, review or submit control`
          + ` (still none after ${CONTROL_RENDER_TIMEOUT / 1000}s)`,
      };
    }

    // Two consecutive steps with an identical form means the button did nothing.
    // Detected here rather than after MAX_STEPS so the run does not burn eight
    // rounds of LLM calls on a form that is standing still.
    //
    // An empty signature is not evidence of that. Easy Apply's later steps are
    // review screens — the imported work history, the résumé preview — which
    // carry no fillable control at all, so `stepSignature` returns "" for each
    // of them and two different screens compare equal. Job 453 advanced from
    // step 3 to step 4 correctly and was abandoned as "form did not advance past
    // step 3" on that basis. When the adapter cannot describe the step, the loop
    // falls back to MAX_STEPS to bound itself, which costs nothing here: a step
    // with no fields resolves no fields and calls no model.
    if (lastSignature !== null && signatureNow !== '' && signatureNow === lastSignature) {
      return {
        outcome: 'stuck', filled, ledger, steps,
        reason: `form did not advance past step ${steps - 1} — the same fields came back after clicking next`,
      };
    }
    lastSignature = signatureNow;

    if (beforeAdvance) await beforeAdvance({ step: steps });
    await next.click();
    await next.page().waitForTimeout(1800);
  }

  return { outcome: 'stuck', filled, ledger, steps, reason: `exceeded ${maxSteps} steps without reaching submit` };
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

/**
 * Is what the page holds the same answer we put there?
 *
 * Deliberately forgiving about form and unforgiving about content. A control
 * normalises what it is given — a phone box strips spaces, a select returns its
 * label where we sent its value, a rich text box trims — and calling any of that
 * a reverted field would fill the log with false alarms and teach the operator to
 * ignore it. What it will not forgive is an empty box where a value was typed,
 * which is the only case this check exists to catch.
 */
export function sameValue(a, b) {
  const norm = v => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  if (!x || !y) return false;
  // A select showing "South Africa +27" for a value of "South Africa", or a
  // number box showing "5" for "5 years".
  if (x.includes(y) || y.includes(x)) return true;
  // Punctuation and separators differ far more often than content does.
  const bare = v => v.replace(/[^a-z0-9]/g, '');
  return !!bare(x) && bare(x) === bare(y);
}

/**
 * What makes two controls the same question.
 *
 * Role, label and offered choices — everything that decides what the answer is,
 * and nothing that decides where it goes. A form rendering one question twice
 * (a responsive duplicate, nested copies of a control set) produces two nodes
 * with different uids and identical identities, and resolving both asks a model
 * the same question twice to get the same answer.
 *
 * Deliberately includes the options: two selects labelled "Country" offering
 * different lists are two questions, however alike they read.
 */
export function fieldIdentity(item) {
  const question = String(item?.question ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const options = (item?.options || []).map(o => String(o).trim().toLowerCase()).join('');
  return `${item?.role || item?.fieldType || ''}|${question}|${options}`;
}

/** Accessible-name patterns for moving forward and for finishing. */
/**
 * A refusal, written out as if it were an answer.
 *
 * The resolver rejects these at both of its model paths, but this module is the
 * only point every value from every tier and adapter passes through before it is
 * typed — and on 28 July the literal string "unanswerable" went into a live form
 * and was submitted to an employer, because the field was free text and so had
 * no option list to fail against. Kept here, next to the other patterns, rather
 * than imported: this file is a parameterised machine and owns no dependencies.
 *
 * Narrow on purpose — `N/A` and `None` are real answers to real questions and
 * are not listed. See the matching note in answer/resolver.js.
 */
export const NON_ANSWER_VALUE = /^\s*(unanswerable|unknown|no answer|not specified|not provided|not available in (the )?profile|i (don'?t|do not) know|null|undefined|nil)\s*[.!]?\s*$/i;

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
