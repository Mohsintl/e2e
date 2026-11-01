/**
 * Pointer drags on Chromium, as Playwright's Chromium driver performs them.
 * A drag the page starts (an HTML5 `draggable` picked up) is intercepted
 * through CDP (`Input.setInterceptDrags`, reached with the mapper's
 * `goog:cdp` passthrough), and its enter, over, and drop are dispatched with
 * the drag data the page set (`Input.dispatchDragEvent`): a synthesized
 * mouse drag in headless Chromium drops without its `dataTransfer`. A drag
 * the page does not start stays plain pointer moves.
 */

import type { Input } from 'webdriver-bidi-protocol';
import type { BidiConnection } from './connection.ts';
import { callFunction } from './script.ts';

type Point = { readonly x: number; readonly y: number };

/** Records, in the page, whether the next mouse move started a drag the page did not cancel. */
const WATCH_DRAG = `() => {
  let started = Promise.resolve(false);
  let drag = null;
  const onDrag = (event) => { drag = event; };
  const onMove = () => {
    started = new Promise((resolve) => {
      window.addEventListener('dragstart', onDrag, { once: true, capture: true });
      setTimeout(() => resolve(drag !== null && !drag.defaultPrevented), 0);
    });
  };
  window.addEventListener('mousemove', onMove, { once: true, capture: true });
  Reflect.set(window, Symbol.for('e2e.drag'), async () => {
    const value = await started;
    window.removeEventListener('mousemove', onMove, { capture: true });
    window.removeEventListener('dragstart', onDrag, { capture: true });
    return value;
  });
}`;

const DRAG_STARTED = `() => { const check = Reflect.get(window, Symbol.for('e2e.drag')); return check === undefined ? false : check(); }`;

function mouse(actions: Input.PointerSourceAction[]): Input.PointerSourceActions {
  return { type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions };
}

/**
 * Presses at the path's first point, moves through the rest, and releases
 * at the last; a drag the page starts on the first move carries its data to
 * the drop. `stepMs` paces each move.
 */
export async function chromiumDrag(
  connection: BidiConnection,
  context: string,
  documents: readonly string[],
  path: readonly Point[],
  stepMs: number,
): Promise<void> {
  const [from, first, ...rest] = path;
  if (from === undefined || first === undefined) return;
  const { session } = (await connection.sendExtension('goog:cdp.getSession', { context })) as { session: string };
  const cdp = (method: string, params: object): Promise<unknown> => connection.sendExtension('goog:cdp.sendCommand', { method, params, session });
  let intercepted: (data: unknown) => void = () => undefined;
  const dragData = new Promise<unknown>((resolve) => (intercepted = resolve));
  const off = connection.onExtension('goog:cdp.Input.dragIntercepted', (event) => {
    if (event['session'] === session) intercepted((event['params'] as { data: unknown }).data);
  });
  // An extension event the spec's event names do not list.
  const extensionEvent = 'goog:cdp.Input.dragIntercepted' as 'browsingContext.load';
  const { subscription } = await connection.send('session.subscribe', { events: [extensionEvent], contexts: [context] });
  let data: unknown;
  try {
    await connection.send('input.performActions', {
      context,
      actions: [mouse([{ type: 'pointerMove', x: from.x, y: from.y, origin: 'viewport' }, { type: 'pointerDown', button: 0 }])],
    });
    // Armed after the press, so the watcher sees the move that can start the drag, not the move to the press point.
    await Promise.all(documents.map((each) => callFunction(connection, each, WATCH_DRAG).catch(() => undefined)));
    await cdp('Input.setInterceptDrags', { enabled: true });
    try {
      await connection.send('input.performActions', {
        context,
        // One discrete move, as Playwright's: an interpolated one would be checked before it passed the drag threshold.
        actions: [mouse([{ type: 'pointerMove', x: first.x, y: first.y, origin: 'viewport' }])],
      });
      const started = await Promise.all(documents.map((each) => callFunction(connection, each, DRAG_STARTED, [], { awaitPromise: true }).catch(() => false)));
      if (started.includes(true)) data = await dragData;
    } finally {
      await cdp('Input.setInterceptDrags', { enabled: false }).catch(() => undefined);
    }
    if (data === undefined) {
      await connection.send('input.performActions', {
        context,
        actions: [mouse([
          ...rest.map((point) => ({ type: 'pointerMove' as const, x: point.x, y: point.y, origin: 'viewport' as const, ...(stepMs > 0 ? { duration: stepMs } : {}) })),
          { type: 'pointerUp', button: 0 },
        ])],
      });
      return;
    }
    await cdp('Input.dispatchDragEvent', { type: 'dragEnter', x: first.x, y: first.y, data });
    for (const point of rest) await cdp('Input.dispatchDragEvent', { type: 'dragOver', x: point.x, y: point.y, data });
    const last = rest.at(-1) ?? first;
    await cdp('Input.dispatchDragEvent', { type: 'drop', x: last.x, y: last.y, data });
  } finally {
    off();
    await connection.send('session.unsubscribe', { subscriptions: [subscription] }).catch(() => undefined);
    await connection.send('input.releaseActions', { context }).catch(() => undefined);
  }
}
