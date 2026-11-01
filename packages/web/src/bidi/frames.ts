/**
 * Nested documents on the BiDi driver. An iframe's document is its own
 * browsing context, reached through the iframe element's `contentWindow`;
 * the surface remembers, for each child context it entered, the iframe
 * element that holds it, so a box measured inside the child can be placed in
 * the top-level viewport the pointer and the screenshot share.
 */

import type { BrowsingContext } from 'webdriver-bidi-protocol';
import { EngineError, type LocatorExpression, type SemanticNode } from 'e2e/engine';
import { contentBox, frameContentInset, placeRectInFrame } from '../observation.ts';
import type { BidiConnection } from './connection.ts';
import { callFunction, ElementRef, WindowRef } from './script.ts';

/** An element and the browsing context whose document holds it. */
export interface NodeTarget {
  readonly element: ElementRef;
  readonly context: string;
}

type Rect = NonNullable<SemanticNode['rect']>;

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
   * The top-level viewport box of `context`'s viewport: each holding iframe's
   * content box, nested; undefined for the top level, null when a frame on
   * the way lays out no box.
   */
  async viewportBox(connection: BidiConnection, context: string): Promise<Rect | null | undefined> {
    const boxes = await this.contentBoxes(connection, context);
    if (boxes === null) return null;
    let box: Rect | undefined;
    for (const content of boxes) {
      if (box === undefined) {
        box = content;
        continue;
      }
      const placed = placeRectInFrame(content, box);
      if (placed === undefined) return null;
      box = placed;
    }
    return box;
  }

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
    const { nodes } = await connection.send('browsingContext.locateNodes', { context, locator: selectorLocator(selector) });
    const iframes = nodes.filter((node) => node.value?.localName === 'iframe' || node.value?.localName === 'frame');
    if (iframes.length === 0) {
      throw new EngineError('FRAME_NOT_FOUND', `no frame matches ${selector}`, { retryable: true });
    }
    if (iframes.length > 1) {
      throw new EngineError('FRAME_AMBIGUOUS', `${iframes.length} frames match ${selector}`, { retryable: false });
    }
    const sharedId = iframes[0]!.sharedId;
    if (sharedId === undefined) throw new EngineError('FRAME_NOT_FOUND', `frame ${selector} has no element id`, { retryable: true });
    const frame: NodeTarget = { element: new ElementRef(sharedId), context };
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
 * the frame's and clipped to it, dropped when the frame has no box or the
 * node lies outside it, and its frame path set.
 */
export function inViewport(node: SemanticNode, frame: Rect | null | undefined, framePath: readonly string[]): SemanticNode {
  const withPath = framePath.length === 0 ? node : { ...node, framePath };
  if (frame === undefined || node.rect === undefined) return withPath;
  const { rect: _rect, ...rest } = withPath;
  const placed = frame === null ? undefined : placeRectInFrame(node.rect, frame);
  return placed === undefined ? rest : { ...rest, rect: placed };
}
