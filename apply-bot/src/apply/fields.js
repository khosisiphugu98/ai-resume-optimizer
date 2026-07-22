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
  const root = document.querySelector(rootSelector) || document.body;
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
      const group = el.name;
      if (!group || seenRadioGroups.has(group)) continue;
      seenRadioGroups.add(group);
      const radios = [...root.querySelectorAll(`input[type="radio"][name="${CSS.escape(group)}"]`)];
      const fieldsetLegend = el.closest('fieldset')?.querySelector('legend')?.innerText.trim();
      out.push({
        kind: 'radio',
        selector: `input[type="radio"][name="${CSS.escape(group)}"]`,
        name: group,
        question: (fieldsetLegend || question || group).replace(/\s+/g, ' ').trim(),
        fieldType: 'radio',
        options: radios.map(r => (labelFor(r) || r.value || '').trim()).filter(Boolean),
        values: radios.map(r => r.value),
        required: el.required || el.getAttribute('aria-required') === 'true',
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

/** Apply one resolved value. Returns what actually landed in the DOM. */
export async function fillField(scope, field, value) {
  switch (field.kind) {
    case 'radio': {
      const idx = field.options.findIndex(o => o.toLowerCase().trim() === String(value).toLowerCase().trim());
      if (idx === -1) throw new Error(`"${value}" is not one of: ${field.options.join(' | ')}`);
      const radios = scope.locator(field.selector);
      await radios.nth(idx).check({ force: true });
      return field.options[idx];
    }
    case 'select': {
      const idx = field.options.findIndex(o => o.toLowerCase().trim() === String(value).toLowerCase().trim());
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
