/**
 * Nested documents on the BiDi driver. An iframe's document is its own
 * browsing context, reached through the iframe element's `contentWindow`;
 * the surface remembers, for each child context it entered, the iframe
 * element that holds it, so a box measured inside the child can be placed in
 * the top-level viewport the pointer and the screenshot share.
 */

import type { BrowsingContext } from 'webdriver-bidi-protocol';
import { EngineError, TestError, type LocatorExpression, type SemanticNode } from 'e2e/engine';
import { message } from '../support.ts';
import { contentBox, frameContentInset } from '../observation.ts';
import { BidiError, type BidiConnection } from './connection.ts';
import { callFunction, ElementRef, WindowRef } from './script.ts';

/** An element and the browsing context whose document holds it. */
export interface NodeTarget {
  readonly element: ElementRef;
  readonly context: string;
}

type Rect = NonNullable<SemanticNode['rect']>;

/** A frame's viewport in the top-level one: where its coordinates start, and the part of it its holders show. */
export interface FrameView {
  readonly origin: { readonly x: number; readonly y: number };
  readonly clip: Rect;
}

/** `rect` cut to `bounds`; undefined when nothing of it is inside. */
function clipTo(rect: Rect, bounds: Rect): Rect | undefined {
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const width = Math.min(rect.x + rect.width, bounds.x + bounds.width) - x;
  const height = Math.min(rect.y + rect.height, bounds.y + bounds.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

/** An iframe element's window, which serializes as its browsing context. Runs in the page. */
function contentWindow(element: HTMLIFrameElement): Window | null {
  return element.contentWindow;
}

/** The child browsing context of an iframe element, or undefined when it has no document. */
export async function contentContext(connection: BidiConnection, frame: NodeTarget): Promise<string | undefined> {
  const window = await callFunction(connection, frame.context, contentWindow, [frame.element]);
  return window instanceof WindowRef ? window.context : undefined;
}

/**
 * A selector as a `browsingContext.locateNodes` locator, read as Playwright
 * reads one: an `xpath=` or `css=` prefix names its engine, and an
 * unprefixed one is XPath when it starts with `/`, `..`, or a parenthesized
 * path such as `(//li)[2]`, else CSS.
 */
export function selectorLocator(selector: string): BrowsingContext.Locator {
  if (selector.startsWith('xpath=')) return { type: 'xpath', value: selector.slice('xpath='.length) };
  if (selector.startsWith('css=')) return { type: 'css', value: selector.slice('css='.length) };
  return /^\(*(\/|\.\.)/.test(selector) ? { type: 'xpath', value: selector } : { type: 'css', value: selector };
}

/** One element a selector matched, and its tag name. */
export interface SelectedElement {
  readonly element: ElementRef;
  readonly localName: string;
}

/**
 * The elements of `selector` in document order, through open shadow roots
 * for CSS (`querySelectorAll` in the document and in each open root), as
 * Playwright's CSS engine reaches into them; a selector the page cannot
 * parse is `INVALID_LOCATOR`. Runs in the page.
 */
function cssSelectAll(selector: string): { element: Element; localName: string }[] | string {
  const out: { element: Element; localName: string }[] = [];
  const roots: ParentNode[] = [document];
  try {
    for (let index = 0; index < roots.length; index += 1) {
      for (const element of roots[index]!.querySelectorAll(selector)) out.push({ element, localName: element.localName });
      for (const element of roots[index]!.querySelectorAll('*')) if (element.shadowRoot !== null) roots.push(element.shadowRoot);
    }
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  return out;
}

/**
 * The elements `selector` matches in `context`'s document (see
 * `selectorLocator`): CSS through open shadow roots, as Playwright reads it,
 * XPath through `browsingContext.locateNodes`, which stays in the light DOM
 * as Playwright's XPath does.
 */
export async function selectElements(connection: BidiConnection, context: string, selector: string): Promise<SelectedElement[]> {
  const locator = selectorLocator(selector);
  if (locator.type === 'css') {
    const found = await callFunction(connection, context, cssSelectAll, [locator.value], { maxObjectDepth: null });
    if (typeof found === 'string') throw new TestError('INVALID_LOCATOR', `selector ${selector} is not a CSS or XPath selector: ${found}`);
    if (!isSelection(found)) throw new EngineError('ENGINE_FAILURE', `selector ${selector} read an unexpected value`, { retryable: false });
    return found;
  }
  try {
    const { nodes } = await connection.send('browsingContext.locateNodes', { context, locator });
    return nodes.flatMap((node) => (node.sharedId === undefined ? [] : [{ element: new ElementRef(node.sharedId), localName: node.value?.localName ?? '' }]));
  } catch (cause) {
    if (cause instanceof BidiError && cause.error === 'invalid selector') {
      throw new TestError('INVALID_LOCATOR', `selector ${selector} is not a CSS or XPath selector: ${message(cause)}`);
    }
    throw cause;
  }
}

/** True for what `cssSelectAll` returns once its elements crossed the wire. */
function isSelection(value: unknown): value is SelectedElement[] {
  return Array.isArray(value) && value.every((each: unknown) =>
    typeof each === 'object' && each !== null && Reflect.get(each, 'element') instanceof ElementRef && typeof Reflect.get(each, 'localName') === 'string');
}

/** The iframe that holds each child context the surface entered, by child context. */
export class FrameRegistry {
  private readonly holders = new Map<string, NodeTarget>();

  /** Records that `child` is the document of `frame`. */
  enter(child: string, frame: NodeTarget): void {
    this.holders.set(child, frame);
  }

  /** The iframes from the top-level document down to `context`, outermost first; empty for the top level. */
  chain(context: string): NodeTarget[] {
    const chain: NodeTarget[] = [];
    for (let holder = this.holders.get(context); holder !== undefined; holder = this.holders.get(holder.context)) {
      chain.unshift(holder);
    }
    return chain;
  }

  /**
   * Each iframe's content box in the document that holds it, outermost
   * first: the offsets a point in `context`'s viewport passes through on its
   * way to the top-level one. Null when a frame on the way lays out no box.
   */
  async contentBoxes(connection: BidiConnection, context: string): Promise<Rect[] | null> {
    const boxes: Rect[] = [];
    for (const frame of this.chain(context)) {
      const measured = await callFunction(connection, frame.context, FRAME_BOX, [frame.element]);
      if (!isFrameBox(measured)) return null;
      boxes.push(contentBox(measured.border, measured.inset));
    }
    return boxes;
  }

  /**
   * Where `context`'s viewport sits in the top-level one: `origin`, its
   * content box's corner with every holding iframe's offset added, and
   * `clip`, the part of it every holding iframe shows. Undefined for the top
   * level, null when a frame on the way lays out no box or shows none of it.
   */
  async viewportBox(connection: BidiConnection, context: string): Promise<FrameView | null | undefined> {
    const boxes = await this.contentBoxes(connection, context);
    if (boxes === null) return null;
    let view: FrameView | undefined;
    for (const content of boxes) {
      if (view === undefined) {
        view = { origin: { x: content.x, y: content.y }, clip: content };
        continue;
      }
      const origin = { x: view.origin.x + content.x, y: view.origin.y + content.y };
      const clip = clipTo({ ...origin, width: content.width, height: content.height }, view.clip);
      if (clip === undefined) return null;
      view = { origin, clip };
    }
    return view;
  }

  /** Forgets every frame, when the documents that held them are gone. */
  clear(): void {
    this.holders.clear();
  }
}

/** True for what `FRAME_BOX` reports for a frame with a box. */
function isFrameBox(value: unknown): value is { border: Rect; inset: Rect } {
  return typeof value === 'object' && value !== null && 'border' in value && 'inset' in value;
}

/** An iframe's border box in its own document's viewport, and where its content box sits inside it. */
const FRAME_BOX = `(element) => {
  const inset = (${frameContentInset.toString()})(element);
  if (element.getClientRects().length === 0) return null;
  const rect = element.getBoundingClientRect();
  return { border: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, inset };
}`;

/**
 * The browsing context the innermost frame of `selectors` shows, each
 * selector matched in the document of the one before it: `FRAME_NOT_FOUND`
 * (retryable, a frame loads) when one matches nothing or has no document
 * yet, `FRAME_AMBIGUOUS` when one matches more than one iframe. Every frame
 * on the way is recorded in `frames`.
 */
export async function resolveFrames(
  connection: BidiConnection,
  top: string,
  selectors: readonly string[],
  frames: FrameRegistry,
): Promise<string> {
  let context = top;
  for (const selector of selectors) {
    const iframes = (await selectElements(connection, context, selector)).filter((found) => found.localName === 'iframe' || found.localName === 'frame');
    if (iframes.length === 0) {
      throw new EngineError('FRAME_NOT_FOUND', `no frame matches ${selector}`, { retryable: true });
    }
    if (iframes.length > 1) {
      throw new EngineError('FRAME_AMBIGUOUS', `${iframes.length} frames match ${selector}`, { retryable: false });
    }
    const frame: NodeTarget = { element: iframes[0]!.element, context };
    const child = await contentContext(connection, frame);
    if (child === undefined) throw new EngineError('FRAME_NOT_FOUND', `frame ${selector} has no document yet`, { retryable: true });
    frames.enter(child, frame);
    context = child;
  }
  return context;
}

/**
 * The expression a frame's document answers: the same expression with its
 * `frame` steps removed, since the caller already resolved the frame chain
 * they name (`frameSelectors` checks every branch names the same chain).
 */
export function withinFrame(expression: LocatorExpression): LocatorExpression {
  switch (expression.kind) {
    case 'frame':
      return withinFrame(expression.source);
    case 'query':
      return expression.scope === undefined ? expression : { ...expression, scope: withinFrame(expression.scope) };
    case 'filter':
      return {
        ...expression,
        source: withinFrame(expression.source),
        ...(expression.has === undefined ? {} : { has: withinFrame(expression.has) }),
        ...(expression.hasNot === undefined ? {} : { hasNot: withinFrame(expression.hasNot) }),
      };
    case 'index':
      return { ...expression, source: withinFrame(expression.source) };
    case 'union':
      return { ...expression, left: withinFrame(expression.left), right: withinFrame(expression.right) };
    case 'selector':
      return expression;
  }
}

/**
 * A node read inside a frame, in the top-level viewport: its box shifted by
 * the frame's origin and clipped to what the frame shows, dropped when the
 * frame has no box or the node lies outside it, and its frame path set.
 */
export function inViewport(node: SemanticNode, frame: FrameView | null | undefined, framePath: readonly string[]): SemanticNode {
  const withPath = framePath.length === 0 ? node : { ...node, framePath };
  if (frame === undefined || node.rect === undefined) return withPath;
  const { rect: _rect, ...rest } = withPath;
  const placed = frame === null ? undefined : clipTo({ ...node.rect, x: node.rect.x + frame.origin.x, y: node.rect.y + frame.origin.y }, frame.clip);
  return placed === undefined ? rest : { ...rest, rect: placed };
}
