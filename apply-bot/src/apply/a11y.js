/**
 * Accessibility-tree field collection — the long-tail adapter (phase 7).
 *
 * `collectFieldsInPage()` walks `input, select, textarea` and resolves labels. That
 * covers forms built from native controls, which is most vendor boards. It finds
 * nothing on a React careers site built from `div[role="textbox"]`, a
 * button-plus-listbox combobox, or a form inside a web component — and those are
 * exactly the sites nobody has written an adapter for.
 *
 * This collector is the fallback, not the replacement: the DOM one is faster and
 * deterministic, so it runs first and this runs only when it comes up short.
 *
 * The crux is getting a name *and* a usable locator out of the same pass.
 * `page.accessibility.snapshot()` gives a tree with no element handles and
 * `ariaSnapshot()` gives YAML, so neither can fill anything. Instead the
 * accessible name is computed in-page and the element is tagged with
 * `data-bot-a11y`, which Playwright's CSS engine can find again — including
 * inside open shadow roots, which `document.querySelector` cannot.
 */

/**
 * Runs in the page. Returns a serialisable node per fillable control.
 *
 * Existing `data-bot-a11y` tags are reused rather than regenerated, so collecting
 * the same DOM twice yields the same uids. The wizard depends on that: it is how
 * a conditionally revealed field is told apart from a form that is not advancing.
 */
export const collectA11yInPage = (rootSelector) => {
  const root = (rootSelector && document.querySelector(rootSelector)) || document.body;

  // 1. Deep query — pierce open shadow roots, which querySelectorAll will not.
  const deepQueryAll = (node, out = []) => {
    for (const el of node.querySelectorAll('*')) {
      out.push(el);
      if (el.shadowRoot) deepQueryAll(el.shadowRoot, out);
    }
    return out;
  };

  // 2. Implicit + explicit role.
  const roleOf = el => {
    const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      return { checkbox: 'checkbox', radio: 'radio', file: 'file', submit: 'button',
               button: 'button', reset: 'button', image: 'button', hidden: null,
               range: 'slider', number: 'spinbutton' }[type] || 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return null;
  };

  // ids resolve within the element's own tree — an aria-labelledby inside a
  // shadow root points at an id in that shadow root, not in the document.
  const byId = (el, id) => {
    const tree = el.getRootNode();
    return (tree.getElementById && tree.getElementById(id)) || document.getElementById(id);
  };
  const textOfIds = (el, ids) => ids.split(/\s+/)
    .map(id => byId(el, id)?.innerText || '').join(' ').replace(/\s+/g, ' ').trim();

  const clean = s => String(s || '').replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 200);

  // accname's "name from content" roles. A container role such as radiogroup is
  // deliberately absent — naming it from its contents would concatenate every
  // option into the question.
  const NAME_FROM_CONTENT = new Set([
    'option', 'radio', 'checkbox', 'button', 'switch', 'tab',
    'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem', 'link',
  ]);

  // 3. Accessible name, in spec order (a practical subset of accname).
  const nameOf = el => {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = textOfIds(el, labelledby);
      if (text) return clean(text);
    }
    const arialabel = el.getAttribute('aria-label');
    if (arialabel && arialabel.trim()) return clean(arialabel);

    // A fieldset is named by its legend. Without this the radio group falls
    // through to the visual heuristic and takes the label of the field above it,
    // which is how "are you authorised to work here" becomes "LinkedIn Profile".
    if (el.tagName === 'FIELDSET') {
      const legend = el.querySelector('legend');
      if (legend && legend.innerText.trim()) return clean(legend.innerText);
    }

    if (el.id) {
      const tree = el.getRootNode();
      const scope = tree.querySelector ? tree : document;
      const l = scope.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && l.innerText.trim()) return clean(l.innerText);
    }

    const wrap = el.closest('label');
    if (wrap && wrap.innerText.trim()) return clean(wrap.innerText);

    // Roles that take their name from their own contents. Without this rule a
    // `<div role="option">Cape Town</div>` has no label to find, falls through to
    // the visual heuristic, and is named after whatever element sits above the
    // list — so every option in a custom dropdown comes back shifted by one.
    if (NAME_FROM_CONTENT.has(roleOf(el))) {
      const own = (el.innerText || el.textContent || '').trim();
      if (own) return clean(own);
    }

    if (el.title && el.title.trim()) return clean(el.title);
    // Last resort only — a placeholder disappears as soon as anything is typed,
    // so it is the weakest evidence of what a field is asking for.
    if (el.placeholder && el.placeholder.trim()) return clean(el.placeholder);

    // Visual-only labelling: the nearest preceding text in an enclosing block.
    // Restricted to preceding elements so help text *below* a field is not
    // mistaken for the question.
    let n = el.parentElement;
    for (let i = 0; n && i < 4; i++, n = n.parentElement) {
      const cand = [...n.children]
        .filter(c => !c.contains(el) &&
          (el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_PRECEDING))
        .map(c => (c.innerText || '').trim())
        .filter(text => text && text.length < 200);
      if (cand.length) return clean(cand.at(-1));
    }
    return '';
  };

  // 4. Description — often carries the real constraint ("numbers only").
  const descOf = el => {
    const d = el.getAttribute('aria-describedby');
    return d ? clean(textOfIds(el, d)) : '';
  };

  const groupOf = el => {
    const fs = el.closest('fieldset');
    const legend = fs?.querySelector('legend');
    if (legend?.innerText.trim()) return clean(legend.innerText);
    const g = el.closest('[role="group"]');
    return g ? clean(nameOf(g)) : '';
  };

  const visible = el => {
    if ((el.type || '').toLowerCase() === 'file') return true;   // routinely offscreen
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const disabledOf = el => !!el.disabled || el.getAttribute('aria-disabled') === 'true';
  const requiredOf = el => !!el.required || el.getAttribute('aria-required') === 'true';

  const tag = el => {
    let uid = el.getAttribute('data-bot-a11y');
    if (!uid) {
      uid = 'a11y-' + Math.random().toString(36).slice(2, 10);
      el.setAttribute('data-bot-a11y', uid);
    }
    return uid;
  };

  const optionLabel = el => clean(nameOf(el) || el.value || el.innerText);

  // A custom combobox usually owns a listbox that may not exist until it is
  // opened. An empty options list is reported honestly so the filler knows to
  // open the control and read them then, rather than treating it as free text.
  const listboxFor = el => {
    const owned = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    if (owned) {
      const target = byId(el, owned.split(/\s+/)[0]);
      if (target) return target;
    }
    if ((el.getAttribute('role') || '').toLowerCase() === 'listbox') return el;
    return el.querySelector('[role="listbox"]') || el.parentElement?.querySelector('[role="listbox"]') || null;
  };

  const out = [];
  const seenRadioGroups = new Set();
  const all = deepQueryAll(root);

  for (const el of all) {
    const role = roleOf(el);
    if (!role || role === 'button') continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    if (disabledOf(el)) continue;
    if (!visible(el)) continue;

    const base = () => ({
      uid: tag(el),
      name: nameOf(el),
      description: descOf(el),
      required: requiredOf(el),
      group: groupOf(el),
      disabled: false,
    });

    // --- radios collapse to one node per group -----------------------------
    if (role === 'radio') {
      const native = el.tagName === 'INPUT';
      const container = el.closest('[role="radiogroup"]') || el.closest('fieldset');
      const key = native && el.name ? `name:${el.name}` : (container ? tag(container) : tag(el));
      if (seenRadioGroups.has(key)) continue;
      seenRadioGroups.add(key);

      const peers = native && el.name
        ? all.filter(x => x.tagName === 'INPUT' && (x.type || '').toLowerCase() === 'radio' && x.name === el.name)
        : (container ? [...container.querySelectorAll('[role="radio"]')] : [el]);

      const groupName = container ? clean(nameOf(container) || groupOf(el)) : '';
      out.push({
        ...base(),
        uid: container ? tag(container) : tag(el),
        role: 'radiogroup',
        native: native ? 'radio' : null,
        name: groupName || nameOf(el),
        options: peers.map(optionLabel),
        optionUids: peers.map(tag),
        value: peers.find(p => p.checked || p.getAttribute('aria-checked') === 'true')
          ? optionLabel(peers.find(p => p.checked || p.getAttribute('aria-checked') === 'true')) : '',
      });
      continue;
    }

    if (role === 'checkbox') {
      out.push({
        ...base(), role: 'checkbox',
        native: el.tagName === 'INPUT' ? 'checkbox' : null,
        options: ['Yes', 'No'],
        value: (el.checked || el.getAttribute('aria-checked') === 'true') ? 'Yes' : 'No',
      });
      continue;
    }

    if (role === 'file') {
      out.push({ ...base(), role: 'file', native: 'file', name: base().name || 'Resume', required: false, value: '' });
      continue;
    }

    if (role === 'combobox' || role === 'listbox') {
      const isSelect = el.tagName === 'SELECT';
      const opts = isSelect
        ? [...el.options].map(o => clean(o.text)).filter(text => text && !/^select( an option)?\W*$/i.test(text))
        : (listboxFor(el) ? [...listboxFor(el).querySelectorAll('[role="option"]')] : []);
      out.push({
        ...base(), role,
        native: isSelect ? 'select' : null,
        options: isSelect ? opts : opts.map(optionLabel),
        optionUids: isSelect ? null : opts.map(tag),
        // No options in the DOM yet means the popup is built on open, not that
        // the control takes free text.
        optionsDeferred: !isSelect && opts.length === 0,
        value: isSelect ? clean(el.selectedOptions?.[0]?.text) : clean(el.innerText || el.value),
      });
      continue;
    }

    if (role === 'textbox' || role === 'spinbutton' || role === 'searchbox') {
      const native = el.tagName === 'INPUT' ? 'input' : el.tagName === 'TEXTAREA' ? 'textarea' : null;
      out.push({
        ...base(), role: 'textbox',
        native,
        contentEditable: !native && el.isContentEditable,
        multiline: el.tagName === 'TEXTAREA' || role === 'textbox' && !native,
        numeric: role === 'spinbutton' || (el.type || '').toLowerCase() === 'number',
        options: null,
        value: native ? el.value : clean(el.innerText),
      });
      continue;
    }
  }

  return out;
};

/**
 * The shape the answer resolver already consumes, so a11y nodes travel through
 * `resolveForm()` unchanged and get the same ladder, guards and parking.
 */
export function toFieldSpec(node) {
  const fieldType =
    node.role === 'radiogroup' ? 'radio'
    : node.role === 'checkbox' ? 'checkbox'
    : node.role === 'combobox' || node.role === 'listbox' ? 'select'
    : node.numeric ? 'number'
    : node.multiline ? 'textarea'
    : 'text';

  return {
    kind: 'a11y',
    uid: node.uid,
    selector: `[data-bot-a11y="${node.uid}"]`,
    question: [node.name, node.description].filter(Boolean).join(' — ').trim(),
    fieldType,
    options: node.options && node.options.length ? node.options : null,
    required: node.required,
    currentValue: node.value || null,
    node,
  };
}

const loc = (scope, node) => scope.locator(`[data-bot-a11y="${node.uid}"]`).first();

/** Case-insensitive, whitespace-tolerant option match. */
const matchIndex = (options, value) => {
  const want = String(value).toLowerCase().trim();
  const exact = options.findIndex(o => String(o).toLowerCase().trim() === want);
  if (exact !== -1) return exact;
  return options.findIndex(o => String(o).toLowerCase().trim().replace(/\s+/g, ' ') === want.replace(/\s+/g, ' '));
};

/**
 * Apply one resolved value to a custom control. Returns what actually landed.
 *
 * Every path throws rather than half-succeeding: a silently-ignored
 * `selectOption()` on a button-plus-listbox combobox would leave a required
 * field blank and the application would submit incomplete.
 */
export async function fillA11yField(scope, node, value) {
  const target = loc(scope, node);

  switch (node.role) {
    case 'radiogroup': {
      const idx = matchIndex(node.options, value);
      if (idx === -1) throw new Error(`"${value}" is not one of: ${node.options.join(' | ')}`);
      const option = scope.locator(`[data-bot-a11y="${node.optionUids[idx]}"]`).first();
      if (node.native === 'radio') await option.check({ force: true });
      else await option.click({ force: true });
      return node.options[idx];
    }

    case 'checkbox': {
      const on = /^(yes|true|1|checked)$/i.test(String(value).trim());
      if (node.native === 'checkbox') {
        on ? await target.check({ force: true }) : await target.uncheck({ force: true });
      } else {
        const checked = (await target.getAttribute('aria-checked')) === 'true';
        if (checked !== on) await target.click({ force: true });
      }
      return on ? 'Yes' : 'No';
    }

    case 'file':
      await target.setInputFiles(value);
      return value;

    case 'combobox':
    case 'listbox': {
      if (node.native === 'select') {
        const idx = matchIndex(node.options, value);
        if (idx === -1) throw new Error(`"${value}" is not one of: ${node.options.join(' | ')}`);
        await target.selectOption({ label: node.options[idx] });
        return node.options[idx];
      }

      // Custom combobox: click to open, then click the option whose text matches.
      // selectOption() would resolve nothing here and report success.
      await target.click();
      await target.page().waitForTimeout(300);   // let the popup build

      if (node.optionUids?.length) {
        const idx = matchIndex(node.options, value);
        if (idx === -1) throw new Error(`"${value}" is not one of: ${node.options.join(' | ')}`);
        await scope.locator(`[data-bot-a11y="${node.optionUids[idx]}"]`).first().click({ force: true });
        return node.options[idx];
      }

      // Options were built on open, so they are only readable now.
      const opened = scope.locator('[role="option"]');
      const count = await opened.count();
      if (!count) throw new Error(`combobox "${node.name}" offered no options when opened`);
      const texts = [];
      for (let i = 0; i < count; i++) texts.push(((await opened.nth(i).innerText()) || '').trim());
      const idx = matchIndex(texts, value);
      if (idx === -1) throw new Error(`"${value}" is not one of: ${texts.join(' | ')}`);
      await opened.nth(idx).click();
      return texts[idx];
    }

    default: {
      if (node.native) {
        await target.fill(String(value));
        return String(value);
      }
      // contenteditable, or a div[role=textbox] that only accepts keystrokes.
      if (node.contentEditable) {
        await target.fill(String(value));
        return String(value);
      }
      await target.click();
      await target.press('Control+a').catch(() => {});
      await target.type(String(value));
      return String(value);
    }
  }
}
