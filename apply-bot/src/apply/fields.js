import { matchOptionIndex } from '../answer/options.js';

/**
 * A control that belongs to the site rather than to the application.
 *
 * It is a labelled input, so the collector sees a question and the resolver has
 * no idea it is not being asked anything. Two of these have reached production:
 * CareerJunction's "Job title, skill or company" search bar, which the model
 * answered with a keyword salad of the candidate's skills, and — after the Easy
 * Apply modal closed under it — LinkedIn's own header, which offered a "Search"
 * textbox and a "Select language" combobox as though they were screening
 * questions. Both adapters filter on this, because both have hit it.
 */
const SITE_CHROME = /^\s*(search|keywords?|job title,? ?(skill|keyword)|what (are you looking for|job)|find (a )?jobs?|search (for )?jobs?|search by|select language|language preference|skip to|feedback)/i;

export const isSiteSearch = q => SITE_CHROME.test(String(q || ''));

/**
 * Generic form-field extraction, shared by every adapter.
 *
 * Runs in the page and returns a serialisable FieldSpec[]. Label resolution
 * follows the same order a screen reader would, which is also the order that
 * survives DOM churn best: explicit <label for>, aria-label, aria-labelledby,
 * fieldset legend, then a visible preceding sibling.
 *
 * Radio groups collapse to one field keyed on `name`.
 */
export const collectFieldsInPage = (rootSelector) => {
  // A root that is not there is not the whole page.
  //
  // Falling back to document.body meant that whenever the container went away
  // between being chosen and being read — an Easy Apply modal closing, a step
  // re-rendering — the collector quietly widened to everything the site ships.
  // Job 453 came back with LinkedIn's own navigation as the application form:
  // a "Search" textbox, a "Select language" combobox, another "Search". That is
  // the same shape as the CareerJunction search bar the external path was fixed
  // for. An empty list says "the form is gone", which is true and safe; the
  // page's chrome says something false. Callers that genuinely want the whole
  // document pass 'body', which always matches.
  const root = rootSelector ? document.querySelector(rootSelector) : document.body;
  if (!root) return [];
  const out = [];
  const seenRadioGroups = new Set();

  const visible = el => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return el.type === 'file' || (r.width > 0 && r.height > 0);
  };

  const labelFor = el => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l?.innerText.trim()) return l.innerText.trim();
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();

    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ').trim();
      if (text) return text;
    }

    const wrapLabel = el.closest('label');
    if (wrapLabel?.innerText.trim()) return wrapLabel.innerText.trim();

    const fs = el.closest('fieldset');
    if (fs) {
      const legend = fs.querySelector('legend');
      if (legend?.innerText.trim()) return legend.innerText.trim();
    }

    // LinkedIn often puts the question in a sibling span above the control.
    let node = el.closest('[data-test-form-element], .fb-dash-form-element, .jobs-easy-apply-form-element') || el.parentElement;
    for (let i = 0; node && i < 4; i++, node = node.parentElement) {
      const cand = node.querySelector('label, legend, .t-14, [data-test-form-builder-radio-button-form-component__title]');
      if (cand && cand.innerText.trim() && !cand.contains(el)) return cand.innerText.trim();
    }
    return el.name || el.id || '';
  };

  const selectorFor = el => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
    // Last resort: tag it so the filler can find it again. Reuse an existing tag —
    // the wizard re-collects fields each round and matches them by uid, so minting a
    // fresh key on every collect would make an anonymous field look new and get
    // re-resolved and re-filled every round (mirrors a11y.js's data-bot-a11y reuse).
    const existing = el.getAttribute('data-bot-field');
    if (existing) return `[data-bot-field="${existing}"]`;
    const key = 'bot-' + Math.random().toString(36).slice(2, 10);
    el.setAttribute('data-bot-field', key);
    return `[data-bot-field="${key}"]`;
  };

  for (const el of root.querySelectorAll('input, select, textarea')) {
    if (el.disabled || el.type === 'hidden' || el.type === 'submit' || el.type === 'button') continue;
    if (el.type !== 'file' && !visible(el)) continue;

    const question = labelFor(el)
      .replace(/\s*\*\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (el.type === 'radio') {
      // What makes two radios the same question.
      //
      // The `name` attribute is the HTML answer and was the only one accepted
      // here, so a group without one was skipped outright — `if (!group)
      // continue`. LinkedIn's current form builder does exactly that: it renders
      // each question as a <fieldset role="radiogroup"> whose inputs share a
      // `urn:li:` id prefix and carry no name at all. Three required questions
      // on job 280 were therefore never collected, the step was submitted with
      // them blank, LinkedIn answered "This field is required" and re-rendered
      // the same step, and the wizard reported "form did not advance past step
      // 3". That is the largest single cause of this channel's 0/14 — not the
      // answer layer, which had already filled every box it could see.
      //
      // So the group is the container when there is no name: the enclosing
      // fieldset or [role=radiogroup]. It is tagged on first sight so the key is
      // stable across re-collects, the same way selectorFor() reuses its tag —
      // the wizard matches fields by uid between rounds and a fresh key would
      // make an answered question look like a new one.
      const container = el.closest('fieldset,[role="radiogroup"]');
      let groupSelector;
      let group = el.name;

      if (group) {
        groupSelector = `input[type="radio"][name="${CSS.escape(group)}"]`;
      } else if (container) {
        let key = container.getAttribute('data-bot-radiogroup');
        if (!key) {
          key = 'rg-' + Math.random().toString(36).slice(2, 10);
          container.setAttribute('data-bot-radiogroup', key);
        }
        group = key;
        groupSelector = `[data-bot-radiogroup="${key}"] input[type="radio"]`;
      } else {
        // No name and no container: nothing groups these, so the safest reading
        // is one control on its own rather than a guess at its siblings.
        group = selectorFor(el);
        groupSelector = group;
      }

      if (seenRadioGroups.has(group)) continue;
      seenRadioGroups.add(group);

      const radios = [...root.querySelectorAll(groupSelector)];
      // The question sits in a legend on a classic fieldset and in a titled div
      // on the form builder's. Both are the group's label, not the option's.
      const groupLabel = container?.querySelector('legend, [data-test-form-builder-radio-button-form-component__title]')
        ?.innerText.trim();
      out.push({
        kind: 'radio',
        selector: groupSelector,
        name: group,
        question: (groupLabel || question || group).replace(/\s+/g, ' ').trim(),
        fieldType: 'radio',
        options: radios.map(r => (labelFor(r) || r.value || '').trim()).filter(Boolean),
        values: radios.map(r => r.value),
        required: el.required || el.getAttribute('aria-required') === 'true'
          || container?.getAttribute('aria-required') === 'true',
        currentValue: radios.find(r => r.checked)?.value ?? null,
      });
      continue;
    }

    if (el.tagName === 'SELECT') {
      const options = [...el.options].map(o => o.text.trim()).filter(t => t && !/^select an option$/i.test(t));
      out.push({
        kind: 'select', selector: selectorFor(el), question, fieldType: 'select',
        options, values: [...el.options].map(o => o.value),
        required: el.required || el.getAttribute('aria-required') === 'true',
        currentValue: el.value || null,
      });
      continue;
    }

    if (el.type === 'checkbox') {
      out.push({
        kind: 'checkbox', selector: selectorFor(el), question, fieldType: 'checkbox',
        options: ['Yes', 'No'], required: el.required, currentValue: el.checked ? 'Yes' : 'No',
      });
      continue;
    }

    if (el.type === 'file') {
      out.push({ kind: 'file', selector: selectorFor(el), question: question || 'Resume', fieldType: 'file', required: false });
      continue;
    }

    out.push({
      kind: 'input',
      selector: selectorFor(el),
      question,
      fieldType: el.type === 'number' ? 'number' : (el.tagName === 'TEXTAREA' ? 'textarea' : 'text'),
      required: el.required || el.getAttribute('aria-required') === 'true',
      currentValue: el.value || null,
    });
  }

  return out;
};

/**
 * Lift a FieldSpec into the shape the wizard works in, which is also the shape
 * `a11y.js` produces. One vocabulary means the loop, the no-progress detector and
 * the `filled` rows in the dashboard do not care which collector found a field.
 */
export const fromDomField = f => ({
  collector: 'dom',
  uid: f.selector,
  role: f.kind,
  question: f.question,
  fieldType: f.fieldType,
  options: f.options || null,
  required: f.required,
  currentValue: f.currentValue,
  field: f,
});

/**
 * Read a control back out of the page.
 *
 * `fillField` returns what it *meant* to put in, not what is there afterwards,
 * and on a controlled React input those are routinely different: Playwright's
 * `fill()` sets the value and dispatches an input event, the component's state
 * has not changed, and the next render puts the old value back. Nothing threw,
 * the field is empty, and the application went out with a blank where the
 * candidate's phone number should have been. That is exactly what an operator
 * sees when they watch the browser and say "some fields don't get filled in" —
 * and until now nothing in the system disagreed with the claim that they had.
 *
 * Returns the control's current value in the same vocabulary `fillField`
 * returns, or null when it cannot be read — which is not the same as empty and
 * is never treated as a failure.
 */
export async function readFieldValue(scope, field) {
  const one = scope.locator(field.selector).first();
  switch (field.kind) {
    case 'radio': {
      const radios = scope.locator(field.selector);
      const n = await radios.count().catch(() => 0);
      // A re-render between filling and reading can change the group's size, and
      // an index into a list that is no longer the same list is worse than no
      // reading at all.
      if (!n || n !== (field.options || []).length) return null;
      for (let i = 0; i < n; i++) {
        if (await radios.nth(i).isChecked().catch(() => false)) return field.options[i] ?? null;
      }
      return null;
    }
    case 'select':
      // The selected option's text, not its index. `options` is filtered of the
      // "Select an option" placeholder and `values` is not, so the two lists do
      // not align and an index would read the wrong label off a form that filled
      // perfectly well.
      return one.evaluate(el => el.selectedOptions?.[0]?.text?.trim() || el.value || null).catch(() => null);
    case 'checkbox': {
      const on = await one.isChecked().catch(() => null);
      return on == null ? null : (on ? 'Yes' : 'No');
    }
    case 'file': {
      const n = await one.evaluate(el => el.files?.length ?? 0).catch(() => null);
      return n == null ? null : (n > 0 ? `${n} file(s)` : '');
    }
    default:
      return one.inputValue().catch(() => null);
  }
}

/**
 * Apply one resolved value. Returns what actually landed in the DOM.
 *
 * Option matching here is the safe half of the ladder only — restatements of the
 * value, never reinterpretations. The resolver has already fitted the answer to
 * this control's options and flagged anything it had to interpret; a second,
 * looser pass at fill time would silently undo that review.
 */
export async function fillField(scope, field, value) {
  switch (field.kind) {
    case 'radio': {
      const idx = matchOptionIndex(value, field.options);
      if (idx === -1) throw new Error(`"${value}" is not one of: ${field.options.join(' | ')}`);
      const radios = scope.locator(field.selector);
      await radios.nth(idx).check({ force: true });
      return field.options[idx];
    }
    case 'select': {
      const idx = matchOptionIndex(value, field.options);
      if (idx === -1) throw new Error(`"${value}" is not one of: ${field.options.join(' | ')}`);
      await scope.locator(field.selector).selectOption({ label: field.options[idx] });
      return field.options[idx];
    }
    case 'checkbox': {
      const on = /^(yes|true|1)$/i.test(String(value));
      const box = scope.locator(field.selector);
      on ? await box.check({ force: true }) : await box.uncheck({ force: true });
      return on ? 'Yes' : 'No';
    }
    case 'file': {
      await scope.locator(field.selector).setInputFiles(value);
      return value;
    }
    default: {
      await scope.locator(field.selector).fill(String(value));
      return String(value);
    }
  }
}
