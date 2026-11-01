/**
 * Page functions the BiDi surface calls with `script.callFunction`. Each is a
 * self-contained function serialized with `toString()`, so none closes over
 * module scope; the tree reader is embedded from its own source.
 */

import { readSemanticsFunction } from '../in-page/read-semantics.ts';
import { frameContentInset } from '../observation.ts';
import type { RawNodeData, RawObservedNode } from '../read-node.ts';

/** Reads the document's semantic tree: the walk's metadata as JSON when the page left `JSON` native, and the walked elements. */
export const READ_TREE = `(options, structured) => {
  const read = (${readSemanticsFunction.toString()});
  const observation = read(document.documentElement, options);
  const data = { nodes: observation.nodes, ids: observation.ids, truncated: observation.truncated };
  const native = typeof JSON.stringify === 'function' &&
    /^function stringify\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}$/.test(Function.prototype.toString.call(JSON.stringify)) &&
    !('toJSON' in Object.prototype) && !('toJSON' in Array.prototype);
  if (structured) return [data, observation.elements];
  return [native ? JSON.stringify(data) : null, observation.elements];
}`;

/**
 * Reads the elements a locate could match, in document order through open
 * and recorded closed shadow roots, with the reader's node projection (the
 * full locator-read surface), all under one reader. `wants` lists the
 * expression's queries: an element is read when some query could match it,
 * a superset test on what that query compares (its role, then its name; an
 * attribute; its text), case-insensitive with whitespace removed, so the
 * contract's resolver, which runs on the reads, stays the one judge. A
 * pattern is no prefilter. A shadow host is always read, since its text is
 * in its shadow tree. Skipped elements leave their read descendants under
 * the nearest read ancestor, which keeps every containment a scope or
 * filter asks about. Iframe documents are not entered.
 */
export const LOCATE_READ = `(options, wants, key) => {
  const read = (${readSemanticsFunction.toString()});
  const recorded = Reflect.get(globalThis, Symbol.for(key));
  const skip = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base']);
  const labelable = 'input, select, textarea, button, meter, output, progress, [aria-label], [aria-labelledby], [contenteditable], [role]';
  const squash = (text) => text.replace(/\\s+/g, '').toLowerCase();
  const may = (actual, pattern) => pattern === undefined || pattern === null || pattern.kind !== 'string' || (actual !== null && actual !== undefined && squash(String(actual)).includes(squash(pattern.value)));
  const all = [];
  const parentOf = [];
  const hosts = new Set();
  const visit = (element, parent) => {
    if (skip.has(element.localName)) return;
    const index = all.length;
    all.push(element);
    parentOf.push(parent);
    const shadow = element.shadowRoot ?? recorded?.get(element);
    if (shadow) {
      hosts.add(index);
      for (const child of shadow.children) visit(child, index);
    }
    for (const child of element.children) visit(child, index);
  };
  visit(document.documentElement, -1);
  const base = { testIdAttribute: options.testIdAttribute, secureFieldSelector: options.secureFieldSelector };
  const keep = all.map(() => wants.all);
  if (!wants.all) {
    const roleQueries = wants.queries.filter((query) => query.kind === 'role');
    if (roleQueries.length > 0) {
      const roles = read(document.documentElement, { ...base, mode: { kind: 'roles', elements: all } });
      const named = [];
      all.forEach((element, index) => {
        for (const query of roleQueries) {
          if (roles[index] !== query.role) continue;
          if (query.name === undefined || query.name.kind !== 'string') keep[index] = true;
          else named.push(index);
          return;
        }
      });
      const names = named.length === 0 ? [] : read(document.documentElement, { ...base, mode: { kind: 'names', elements: named.map((index) => all[index]) } });
      named.forEach((index, at) => {
        const name = names[at];
        // A nameless element may still match by a label the resolver reads; only a known name can rule it out.
        if (roleQueries.some((query) => query.role === roles[index] && (name === null || may(name, query.name)))) keep[index] = true;
      });
    }
    all.forEach((element, index) => {
      if (keep[index]) return;
      if (wants.hasText && (element.textContent.trim() !== '' || hosts.has(index))) {
        keep[index] = true;
        return;
      }
      for (const query of wants.queries) {
        switch (query.kind) {
          case 'testId': {
            const value = element.getAttribute(options.testIdAttribute);
            if (value !== null && may(value, query.value)) keep[index] = true;
            break;
          }
          case 'placeholder': {
            const value = element.getAttribute('placeholder');
            if (value !== null && may(value, query.value)) keep[index] = true;
            break;
          }
          case 'displayValue':
            if (element.localName === 'select' || (/^(input|textarea)$/.test(element.localName) && may(element.value, query.value))) keep[index] = true;
            break;
          case 'label':
            if (element.matches(labelable)) keep[index] = true;
            break;
          case 'text':
            if (hosts.has(index) || element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby') || element.hasAttribute('alt') ||
                element.hasAttribute('title') || element.hasAttribute('value') || may(element.textContent, query.value)) keep[index] = true;
            break;
        }
        if (keep[index]) return;
      }
    });
  }
  const nearest = new Array(all.length).fill(-1);
  const elements = [];
  const parents = [];
  all.forEach((element, index) => {
    const above = parentOf[index] >= 0 ? nearest[parentOf[index]] : -1;
    if (keep[index]) {
      nearest[index] = elements.length;
      parents.push(above);
      elements.push(element);
    } else {
      nearest[index] = above;
    }
  });
  const nodes = read(document.documentElement, { ...base, mode: { kind: 'nodes', elements } });
  return [JSON.stringify({ nodes, parents }), elements];
}`;

/** An iframe element's content box inset, in its own document; see `frameContentInset`. */
export const FRAME_INSET = `(element) => (${frameContentInset.toString()})(element)`;

/** What `LOCATE_READ` reports beside the elements: each read and the index of its nearest read ancestor. */
export interface LocateMetadata {
  readonly nodes: RawNodeData[];
  readonly parents: number[];
}

/** The walk's metadata, as `READ_TREE` reports it. */
export interface TreeMetadata {
  readonly nodes: RawObservedNode[];
  readonly ids: string[];
  readonly truncated: boolean;
}

/** Where an action can land on an element, or why it cannot yet. */
export type ActionPoint =
  | { readonly state: 'ok'; readonly x: number; readonly y: number }
  | { readonly state: 'detached' | 'hidden' | 'disabled' | 'moving' }
  | { readonly state: 'blocked'; readonly blocker: string };

/**
 * Scrolls an element into view when it is not, waits one frame to see it
 * hold still, and hit-tests its centre: the checks Playwright runs before a
 * pointer action (visible, stable, enabled, receives events), descending
 * through open and recorded closed shadow roots to the element actually hit.
 * `enabled` skips the disabled check for a hover; `hitTest` false stops
 * after the scroll, for a `scrollIntoView`; `key` names the closed-roots
 * registry.
 */
export const ACTION_POINT = `async (element, enabled, hitTest, key) => {
  const recorded = Reflect.get(globalThis, Symbol.for(key));
  if (!element.isConnected) return { state: 'detached' };
  const box = () => element.getBoundingClientRect();
  let rect = box();
  const style = getComputedStyle(element);
  if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden') return { state: 'hidden' };
  if (enabled && (element.disabled === true || element.closest('[aria-disabled="true"], fieldset[disabled]') !== null)) return { state: 'disabled' };
  const inView = rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth;
  if (!inView) element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  rect = box();
  if (!hitTest) return { state: 'ok', x: 0, y: 0 };
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const after = box();
  if (after.x !== rect.x || after.y !== rect.y || after.width !== rect.width || after.height !== rect.height) return { state: 'moving' };
  const x = Math.round(after.left + after.width / 2);
  const y = Math.round(after.top + after.height / 2);
  let hit = document.elementFromPoint(x, y);
  for (let root = hit?.shadowRoot ?? recorded?.get(hit); hit !== null && root; root = hit.shadowRoot ?? recorded?.get(hit)) {
    const inner = root.elementFromPoint(x, y);
    if (inner === null || inner === hit) break;
    hit = inner;
  }
  const contains = (node) => {
    for (let at = node; at !== null; at = at.parentNode ?? (at instanceof ShadowRoot ? at.host : null)) if (at === element) return true;
    return false;
  };
  if (hit !== null && !contains(hit)) {
    const id = hit.id ? '#' + hit.id : '';
    return { state: 'blocked', blocker: '<' + hit.localName + id + '> intercepts pointer events' };
  }
  return { state: 'ok', x, y };
}`;

/** The viewport's size in CSS pixels. */
export const VIEWPORT_SIZE = `() => ({ width: innerWidth, height: innerHeight })`;

/** Resolves once the document is past `loading`, or after `timeoutMs`. */
export const DOM_READY = `(timeoutMs) => new Promise((resolve) => {
  if (document.readyState !== 'loading') return resolve(true);
  const timer = setTimeout(() => resolve(false), timeoutMs);
  document.addEventListener('DOMContentLoaded', () => { clearTimeout(timer); resolve(true); }, { once: true });
})`;

/** Resolves after the next rendered frame, or at once in a hidden document. */
export const NEXT_FRAME = `() => document.visibilityState === 'hidden'
  ? undefined
  : new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))`;

/** Focuses an element. */
export const FOCUS = `(element) => { element.focus(); }`;

/** A checkable's state and kind: `checked` is null for an element with no checked state. */
export const CHECK_STATE = `(element) => {
  const radio = (element instanceof HTMLInputElement && element.type === 'radio') || element.getAttribute('role') === 'radio';
  if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) return { checked: element.checked, radio };
  const aria = element.getAttribute('aria-checked');
  return { checked: aria === 'true' ? true : aria === 'false' ? false : null, radio };
}`;

/**
 * Fills an element as Playwright's `fill` does, with no key events: a text
 * field or editing host is focused, its content selected, and the value
 * inserted as one `insertText` edit (a delete for an empty value), so the app
 * sees the trusted `beforeinput` and `input` an edit fires. A date, color,
 * range, or similar input takes the value directly, with `input` and
 * `change`. Returns null once filled, else why the element cannot be.
 */
export const FILL = `(element, value) => {
  const typed = ['', 'text', 'password', 'search', 'email', 'tel', 'url', 'number'];
  const fired = () => {
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (element instanceof HTMLInputElement && !typed.includes(element.type)) {
    if (['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image'].includes(element.type)) return 'input of type "' + element.type + '" cannot be filled';
    element.focus();
    element.value = value;
    if (element.value !== value) return 'malformed value for input of type "' + element.type + '"';
    fired();
    return null;
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element.disabled || element.readOnly) return 'element is not editable';
    element.focus();
    element.select();
  } else if (element instanceof HTMLElement && element.isContentEditable) {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    return 'element is not an <input>, <textarea> or [contenteditable] element';
  }
  const edited = value === '' ? document.execCommand('delete') : document.execCommand('insertText', false, value);
  if (!edited && 'value' in element) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set;
    setter.call(element, value);
    fired();
  }
  return null;
}`;

/**
 * Selects the option of a `<select>` matching `by` (a label, a value, or an
 * index) and fires `input` and `change`, as Playwright's `selectOption` does.
 */
export const SELECT_OPTION = `(element, by) => {
  if (!(element instanceof HTMLSelectElement)) return 'element is not a <select> element';
  if (element.disabled) return 'element is not enabled';
  const options = [...element.options];
  const option = by.index !== undefined ? options[by.index]
    : by.value !== undefined ? options.find((o) => o.value === by.value)
    : options.find((o) => o.label === by.label || o.textContent.trim() === by.label);
  if (option === undefined) return 'no option matches';
  element.focus();
  for (const o of options) o.selected = o === option;
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return null;
}`;

/** The file input an element is or labels; null for anything else. */
export const FILE_INPUT = `(element) => {
  const control = element instanceof HTMLInputElement ? element : element.closest('label')?.control;
  return control instanceof HTMLInputElement && control.type === 'file' ? control : null;
}`;

/**
 * Covers every secure field in the document with an opaque box and hides the
 * caret, for one screenshot; returns how many fields it covered. `UNMASK`
 * takes both away.
 */
export const MASK = `(selector, key) => {
  const recorded = Reflect.get(globalThis, Symbol.for(key));
  const roots = [document];
  const fields = [];
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    fields.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll('*')) {
      const shadow = element.shadowRoot ?? recorded?.get(element);
      if (shadow) roots.push(shadow);
    }
  }
  const layer = document.createElement('div');
  layer.setAttribute('data-e2e-mask', '');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  for (const field of fields) {
    const rect = field.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;background:#000;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px';
    layer.appendChild(box);
  }
  const caret = new CSSStyleSheet();
  caret.replaceSync('*, *::before, *::after { caret-color: transparent !important; }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, caret];
  Reflect.set(globalThis, Symbol.for('e2e.bidi.caret'), caret);
  document.documentElement.appendChild(layer);
  return fields.length;
}`;

/** Removes what `MASK` added. */
export const UNMASK = `() => {
  for (const layer of document.querySelectorAll('[data-e2e-mask]')) layer.remove();
  const caret = Reflect.get(globalThis, Symbol.for('e2e.bidi.caret'));
  if (caret) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== caret);
}`;
