/**
 * Page functions the BiDi surface calls with `script.callFunction`. Each is a
 * self-contained function serialized with `toString()`, so none closes over
 * module scope; the tree reader is embedded from its own source.
 */

import { readSemanticsFunction } from '../in-page/read-semantics.ts';
import type { RawNodeData, RawObservedNode } from '../read-node.ts';

/**
 * Whether the page left `JSON.stringify` native and added no `toJSON` a
 * read's metadata would go through, so the metadata can cross as one string;
 * else it crosses as a structured value.
 */
const NATIVE_JSON = `typeof JSON.stringify === 'function' &&
    /^function stringify\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}$/.test(Function.prototype.toString.call(JSON.stringify)) &&
    !('toJSON' in Object.prototype) && !('toJSON' in Array.prototype)`;

/** Reads the document's semantic tree: the walk's metadata (see `NATIVE_JSON`), and the walked elements. */
export const READ_TREE = `(options, structured) => {
  const read = (${readSemanticsFunction.toString()});
  const observation = read(document.documentElement, options);
  const data = { nodes: observation.nodes, ids: observation.ids, truncated: observation.truncated };
  if (structured) return [data, observation.elements];
  return [${NATIVE_JSON} ? JSON.stringify(data) : null, observation.elements];
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
export const LOCATE_READ = `(options, wants, key, structured) => {
  const read = (${readSemanticsFunction.toString()});
  const recorded = Reflect.get(globalThis, Symbol.for(key));
  const labelable = 'input, select, textarea, button, meter, output, progress, [aria-label], [aria-labelledby], [contenteditable], [role]';
  const squash = (text) => text.replace(/\\s+/g, '').toLowerCase();
  const may = (actual, pattern) => pattern === undefined || pattern === null || pattern.kind !== 'string' || (actual !== null && actual !== undefined && squash(String(actual)).includes(squash(pattern.value)));
  const all = [];
  const parentOf = [];
  const hosts = new Set();
  const visit = (element, parent) => {
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
  if (structured) return [{ nodes, parents }, elements];
  return [${NATIVE_JSON} ? JSON.stringify({ nodes, parents }) : null, elements];
}`;


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
  | { readonly state: 'detached' | 'hidden' | 'disabled' | 'moving' | 'outside' };

/**
 * What `actionPoint` checks: `enabled` for an action a disabled control
 * refuses, `scroll` to bring the element into view first, `key` the
 * closed-roots registry. `ariaDisabledRoles` are the roles an inherited
 * `aria-disabled` reaches, as the shared reader reads it.
 */
export interface ActionPointOptions {
  readonly enabled: boolean;
  readonly ariaDisabledRoles: readonly string[];
  readonly scroll: boolean;
  readonly key: string;
}

/**
 * The checks Playwright runs before a pointer action, but the hit test:
 * attached, visible, enabled (`:disabled`, or the nearest `aria-disabled`
 * across shadow hosts on the element itself or on a widget, as the shared
 * reader decides), scrolled into view when its centre is clipped
 * by the viewport or a scrolling ancestor, and holding still for a frame.
 * The point is the centre of the element's visible part, in its document's
 * viewport.
 */
export async function actionPoint(element: Element, options: ActionPointOptions): Promise<ActionPoint> {
  if (!element.isConnected) return { state: 'detached' };
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') return { state: 'hidden' };
  if (options.enabled) {
    const widget = ['button', 'a', 'input', 'select', 'textarea', 'option'].includes(element.localName) || options.ariaDisabledRoles.includes(element.getAttribute('role') ?? '');
    let inherited = false;
    for (let at: Element | null = element; at !== null; at = at.parentElement ?? (at.getRootNode() instanceof ShadowRoot ? (at.getRootNode() as ShadowRoot).host : null)) {
      const aria = (at.getAttribute('aria-disabled') ?? '').toLowerCase();
      if (aria === 'false') break;
      if (aria === 'true') {
        inherited = at === element || widget;
        break;
      }
    }
    if (element.matches(':disabled') || inherited) return { state: 'disabled' };
  }
  const visible = (): { left: number; top: number; right: number; bottom: number } | null => {
    const rect = element.getBoundingClientRect();
    let left = Math.max(rect.left, 0);
    let top = Math.max(rect.top, 0);
    let right = Math.min(rect.right, innerWidth);
    let bottom = Math.min(rect.bottom, innerHeight);
    let at: Element | null = element;
    while (at !== null && getComputedStyle(at).position !== 'fixed') {
      const parent: Node | null = at.parentNode;
      at = parent instanceof ShadowRoot ? parent.host : parent instanceof Element ? parent : null;
      if (at === null || at === document.documentElement) break;
      const clip = getComputedStyle(at);
      const bounds = at.getBoundingClientRect();
      if (clip.overflowX !== 'visible') {
        left = Math.max(left, bounds.left);
        right = Math.min(right, bounds.right);
      }
      if (clip.overflowY !== 'visible') {
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
    }
    return right > left && bottom > top ? { left, top, right, bottom } : null;
  };
  const centred = (area: { left: number; top: number; right: number; bottom: number } | null): boolean => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return area !== null && x >= area.left && x <= area.right && y >= area.top && y <= area.bottom;
  };
  if (options.scroll && !centred(visible())) element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const before = element.getBoundingClientRect();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const after = element.getBoundingClientRect();
  if (after.x !== before.x || after.y !== before.y || after.width !== before.width || after.height !== before.height) return { state: 'moving' };
  const area = visible();
  if (area === null) return { state: 'outside' };
  return { state: 'ok', x: Math.round((area.left + area.right) / 2), y: Math.round((area.top + area.bottom) / 2) };
}

/**
 * Why a pointer event at `x`, `y` of the element's document would not reach
 * the element, descending through open and recorded closed shadow roots to
 * the element actually hit; null when it would.
 */
export function hitBlocker(element: Element, x: number, y: number, key: string): string | null {
  const recorded = Reflect.get(globalThis, Symbol.for(key)) as WeakMap<Element, ShadowRoot> | undefined;
  let hit = document.elementFromPoint(x, y);
  for (let root = hit?.shadowRoot ?? recorded?.get(hit!); hit !== null && root !== undefined && root !== null; root = hit.shadowRoot ?? recorded?.get(hit)) {
    const inner = root.elementFromPoint(x, y);
    if (inner === null || inner === hit) break;
    hit = inner;
  }
  if (hit === null) return 'no element receives pointer events at the action point';
  for (let at: Node | null = hit; at !== null; at = at.parentNode ?? (at instanceof ShadowRoot ? at.host : null)) {
    if (at === element) return null;
  }
  return `<${hit.localName}${hit.id === '' ? '' : `#${hit.id}`}> intercepts pointer events`;
}

/** The viewport's size in CSS pixels. */
export function viewportSize(): { width: number; height: number } {
  return { width: innerWidth, height: innerHeight };
}

/** Resolves once the document is past `loading`, or after `timeoutMs`. */
export function domReady(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (document.readyState !== 'loading') return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    document.addEventListener('DOMContentLoaded', () => {
      clearTimeout(timer);
      resolve(true);
    }, { once: true });
  });
}

/** Resolves after the next rendered frame, or at once in a hidden document. */
export function nextFrame(): Promise<void> | undefined {
  if (document.visibilityState === 'hidden') return undefined;
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/**
 * Focuses an element; returns whether focus landed on it, or on the editing
 * host that holds it, followed through open and recorded closed shadow roots.
 */
export function focus(element: Element, key: string): boolean {
  const recorded = Reflect.get(globalThis, Symbol.for(key)) as WeakMap<Element, ShadowRoot> | undefined;
  (element as HTMLElement).focus();
  let active = document.activeElement;
  for (let inner = active && (active.shadowRoot ?? recorded?.get(active))?.activeElement; inner; inner = (inner.shadowRoot ?? recorded?.get(inner))?.activeElement) active = inner;
  return active === element || ((element as HTMLElement).isContentEditable && active !== null && active.contains(element));
}

/** A checkable's state and kind: `checked` is null for an element with no checked state. */
export function checkState(element: Element): { checked: boolean | null; radio: boolean } {
  const radio = (element instanceof HTMLInputElement && element.type === 'radio') || element.getAttribute('role') === 'radio';
  if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) return { checked: element.checked, radio };
  const aria = element.getAttribute('aria-checked');
  return { checked: aria === 'true' ? true : aria === 'false' ? false : null, radio };
}

/**
 * Fills an element as Playwright's `fill` does, with no key events: a text
 * field or editing host is focused, its content selected, and the value
 * inserted as one `insertText` edit (a delete for an empty value), so the app
 * sees the trusted `beforeinput` and `input` an edit fires. A date, color,
 * range, or similar input takes the value directly, with `input` and
 * `change`. Nothing changes until the element proved editable and took
 * focus. Returns null once filled, else why the element cannot be.
 */
export function fill(element: Element, value: string, key: string): string | null {
  const typed = ['', 'text', 'password', 'search', 'email', 'tel', 'url', 'number'];
  const recorded = Reflect.get(globalThis, Symbol.for(key)) as WeakMap<Element, ShadowRoot> | undefined;
  const focused = (): boolean => {
    (element as HTMLElement).focus();
    let active = document.activeElement;
    for (let inner = active && (active.shadowRoot ?? recorded?.get(active))?.activeElement; inner; inner = (inner.shadowRoot ?? recorded?.get(inner))?.activeElement) active = inner;
    return active === element || ((element as HTMLElement).isContentEditable && active !== null && active.contains(element));
  };
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element instanceof HTMLInputElement && ['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image'].includes(element.type)) {
      return `input of type "${element.type}" cannot be filled`;
    }
    if (element.disabled || element.readOnly) return 'element is not editable';
    if (element instanceof HTMLInputElement && element.type === 'number' && Number.isNaN(Number(value))) return 'cannot type text into input[type=number]';
    if (!focused()) return 'element could not be focused';
    if (element instanceof HTMLInputElement && !typed.includes(element.type)) {
      element.value = value;
      if (element.value !== value) return `malformed value for input of type "${element.type}"`;
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return null;
    }
    element.select();
  } else if (element instanceof HTMLElement && element.isContentEditable) {
    if (!focused()) return 'element could not be focused';
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } else {
    return 'element is not an <input>, <textarea> or [contenteditable] element';
  }
  const edited = value === '' ? document.execCommand('delete') : document.execCommand('insertText', false, value);
  const number = element instanceof HTMLInputElement && element.type === 'number';
  if ((!edited || (number && (element as HTMLInputElement).value !== value)) && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (number && (element as HTMLInputElement).value !== value) return 'malformed value for input of type "number"';
  return null;
}

/** Which option `selectOption` picks: by its label, value, or index. */
export interface OptionChoice {
  readonly label?: string;
  readonly value?: string;
  readonly index?: number;
}

/**
 * Selects the option of a `<select>` matching `by` and fires `input` and
 * `change`, as Playwright's `selectOption` does. Returns null once selected,
 * else why it cannot be.
 */
export function selectOption(element: Element, by: OptionChoice): string | null {
  if (!(element instanceof HTMLSelectElement)) return 'element is not a <select> element';
  if (element.disabled) return 'element is not enabled';
  const options = [...element.options];
  const option = by.index !== undefined ? options[by.index]
    : by.value !== undefined ? options.find((each) => each.value === by.value)
    : options.find((each) => each.label === by.label || each.textContent?.trim() === by.label);
  if (option === undefined) return 'no option matches';
  element.focus();
  for (const each of options) each.selected = each === option;
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return null;
}

/** The file input an element is or labels; null for anything else. */
export function fileInput(element: Element): HTMLInputElement | null {
  const control = element instanceof HTMLInputElement ? element : element.closest('label')?.control;
  return control instanceof HTMLInputElement && control.type === 'file' ? control : null;
}

/** An element's box size, which a swipe on it spans. */
export function boxSize(element: Element): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

/**
 * Covers every secure field of the document, through open and recorded
 * closed shadow roots, with an opaque box, and hides the caret, for one
 * screenshot; returns how many fields it covered. The boxes sit in a manual
 * popover, so they paint in the top layer above a modal dialog or popover
 * the app shows, inside a closed shadow root of a host whose every style is
 * set inline as `!important`, so no page rule reaches them. `token` names
 * this masking for `unmaskSecureFields`.
 */
export function maskSecureFields(selector: string, key: string, token: string): number {
  const recorded = Reflect.get(globalThis, Symbol.for(key)) as WeakMap<Element, ShadowRoot> | undefined;
  const fields: Element[] = [];
  const roots: ParentNode[] = [document];
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index]!;
    fields.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll('*')) {
      const shadow = element.shadowRoot ?? recorded?.get(element);
      if (shadow) roots.push(shadow);
    }
  }
  const pin = (element: HTMLElement, styles: Record<string, string>): void => {
    element.style.setProperty('all', 'initial', 'important');
    for (const [name, value] of Object.entries(styles)) element.style.setProperty(name, value, 'important');
  };
  const host = document.createElement('e2e-mask');
  host.popover = 'manual';
  pin(host, {
    display: 'block', position: 'fixed', inset: '0', width: '100vw', height: '100vh', margin: '0', padding: '0', border: '0',
    opacity: '1', visibility: 'visible', overflow: 'visible', background: 'transparent', 'pointer-events': 'none', 'z-index': '2147483647',
  });
  const layer = host.attachShadow({ mode: 'closed' });
  const boxes: { field: Element; rect: DOMRect; box: HTMLElement }[] = [];
  for (const field of fields) {
    const rect = field.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const box = document.createElement('div');
    pin(box, {
      display: 'block', position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
      background: '#000', opacity: '1', visibility: 'visible',
    });
    layer.append(box);
    boxes.push({ field, rect, box });
  }
  const caret = new CSSStyleSheet();
  caret.replaceSync('*, *::before, *::after { caret-color: transparent !important; }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, caret];
  document.documentElement.append(host);
  host.showPopover();
  Reflect.set(globalThis, Symbol.for('e2e.bidi.mask'), { token, host, caret, boxes, selector, key });
  return boxes.length;
}

/**
 * Removes what `maskSecureFields` added. Returns whether the screenshot taken
 * between the two showed no secure field: this document is the one masked
 * under `token`, every box still painted opaque in the top layer, every
 * covered field where its box was, and no visible secure field appeared
 * that no box covers.
 */
export function unmaskSecureFields(token: string): boolean {
  const mask = Reflect.get(globalThis, Symbol.for('e2e.bidi.mask')) as
    | { token: string; host: HTMLElement; caret: CSSStyleSheet; boxes: { field: Element; rect: DOMRect; box: HTMLElement }[]; selector: string; key: string }
    | undefined;
  if (mask === undefined) return false;
  Reflect.deleteProperty(globalThis, Symbol.for('e2e.bidi.mask'));
  const painted = (element: HTMLElement): boolean => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility === 'visible' && style.opacity === '1';
  };
  const shown = mask.host.matches(':popover-open') && painted(mask.host) && mask.boxes.every(({ box }) => painted(box));
  mask.host.remove();
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== mask.caret);
  if (mask.token !== token || !shown) return false;
  const still = mask.boxes.every(({ field, rect }) => {
    const now = field.getBoundingClientRect();
    return now.x === rect.x && now.y === rect.y && now.width === rect.width && now.height === rect.height;
  });
  const covered = new Set(mask.boxes.map(({ field }) => field));
  const recorded = Reflect.get(globalThis, Symbol.for(mask.key)) as WeakMap<Element, ShadowRoot> | undefined;
  const roots: ParentNode[] = [document];
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index]!;
    for (const field of root.querySelectorAll(mask.selector)) {
      const rect = field.getBoundingClientRect();
      if (!covered.has(field) && rect.width > 0 && rect.height > 0) return false;
    }
    for (const element of root.querySelectorAll('*')) {
      const shadow = element.shadowRoot ?? recorded?.get(element);
      if (shadow) roots.push(shadow);
    }
  }
  return still;
}

/**
 * The history entry the document shows once it reads complete, null while
 * it loads: the Navigation API's entry key, else its URL and state.
 */
export function historyEntry(): string | null {
  if (document.readyState !== 'complete') return null;
  const key = (globalThis as { navigation?: { currentEntry?: { key?: string } | null } }).navigation?.currentEntry?.key;
  return key ?? `${location.href} ${JSON.stringify(history.state)}`;
}

/** The document's title. */
export function documentTitle(): string {
  return document.title;
}
