/**
 * Actions on the BiDi driver: one locator action on a node, one pointer
 * action at a point, and keyboard input, each after the actionability
 * checks Playwright runs, with points placed in the top-level viewport.
 */

import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Deadline,
  EngineError,
  type LocatorAction,
  type NodeRef,
  type PointerAction,
  type ViewportPoint,
  type ViewportSize,
} from 'e2e/engine';
import { CLOSED_SHADOW_ROOTS_KEY } from '../closed-shadow.ts';
import { ROOT_NODE_ID } from '../observation.ts';
import { focusTakesKeys } from '../focus.ts';
import { nearestPixel, swipeDistance, wheelDelta } from '../support.ts';
import { chromiumDrag } from './drag.ts';
import { unlessStale } from './errors.ts';
import type { NodeTarget } from './frames.ts';
import { clickSources, dragPath, dragSources, dragStepMs, moveSources, pressSource, typeSource, wheelSources, type ClickOptions } from './input.ts';
import { ACTION_POINT, CHECK_STATE, FILE_INPUT, FILL, FOCUS, NEXT_FRAME, SELECT_OPTION, type ActionPoint } from './page.ts';
import { ElementRef, type PageArgument } from './script.ts';
import type { BidiSession } from './session.ts';

/** How long a long press holds the button when the action names no duration. */
const DEFAULT_LONG_PRESS_MS = 500;
/** Pause between actionability checks of an element that is not ready yet. */
const POLL_MS = 50;

/** One action on a located or observed node; a `swipe` on the observation root is the viewport swipe at the pointer. */
export async function perform(session: BidiSession, ref: NodeRef, action: LocatorAction, timeoutMs: number): Promise<void> {
  if (action.kind === 'swipe' && ref.id === ROOT_NODE_ID) {
    await wheel(session, session.pointer, await session.viewportSize(), action.direction, action.momentum ?? 'none');
    return;
  }
  const target = session.refs.lookup(ref);
  const deadline = new Deadline(timeoutMs);
  const held = 'modifiers' in action && action.modifiers !== undefined ? { modifiers: action.modifiers } : {};
  switch (action.kind) {
    case 'tap':
      return click(session, target, deadline, held);
    case 'doubleTap':
      return click(session, target, deadline, { clicks: 2, ...held });
    case 'secondaryTap':
      return click(session, target, deadline, { button: 2, ...held });
    case 'longPress':
      return click(session, target, deadline, { holdMs: action.durationMs ?? DEFAULT_LONG_PRESS_MS });
    case 'hover': {
      const point = await actionPoint(session, target, deadline, false);
      return session.sendInput(moveSources(point.x, point.y));
    }
    case 'fill':
      return fill(session, target, action.value);
    case 'clear':
      return fill(session, target, '');
    case 'press':
      await session.call(FOCUS, [target.element], undefined, target.context);
      return session.sendInput([pressSource(action.key)]);
    case 'focus':
      await session.call(FOCUS, [target.element], undefined, target.context);
      return;
    case 'scrollIntoView':
      await actionPoint(session, target, deadline, false, false);
      return;
    case 'check':
    case 'uncheck':
      return setChecked(session, target, action.kind === 'check', deadline);
    case 'selectOption': {
      const by = typeof action.value === 'string' ? { label: action.value } : action.value;
      const problem = await session.call(SELECT_OPTION, [target.element, by as PageArgument], undefined, target.context);
      if (typeof problem === 'string') throw new EngineError('NOT_ACTIONABLE', `selectOption: ${problem}`, { retryable: false });
      return;
    }
    case 'setInputFiles':
      return setInputFiles(session, target, action.paths, deadline);
    case 'dragTo': {
      const from = await actionPoint(session, target, deadline, true);
      const to = await actionPoint(session, session.refs.lookup(action.target), deadline, false);
      return drag(session, from, to, 0);
    }
    case 'swipe': {
      const point = await actionPoint(session, target, deadline, false);
      const box = await session.read<ViewportSize>('(element) => { const r = element.getBoundingClientRect(); return { width: r.width, height: r.height }; }', [target.element], undefined, target.context);
      return wheel(session, point, box.width > 0 ? box : await session.viewportSize(), action.direction, action.momentum ?? 'none');
    }
  }
}

/** One pointer action at a viewport point with nothing resolved behind it. */
export async function performAt(session: BidiSession, point: ViewportPoint, action: PointerAction): Promise<void> {
  const at = nearestPixel(point);
  switch (action.kind) {
    case 'tap':
      return session.sendInput(clickSources(at.x, at.y));
    case 'doubleTap':
      return session.sendInput(clickSources(at.x, at.y, { clicks: 2 }));
    case 'secondaryTap':
      return session.sendInput(clickSources(at.x, at.y, { button: 2 }));
    case 'longPress':
      return session.sendInput(clickSources(at.x, at.y, { holdMs: action.durationMs ?? DEFAULT_LONG_PRESS_MS }));
    case 'hover':
      return session.sendInput(moveSources(at.x, at.y));
    case 'dragTo':
      return drag(session, at, nearestPixel(action.target), 0);
    case 'swipeTo':
      return drag(session, at, nearestPixel(action.target), action.durationMs ?? 0);
    case 'swipe':
      return wheel(session, at, await session.viewportSize(), action.direction, action.momentum ?? 'none');
  }
}

/** Types into whatever holds focus, in any document of the tab, refusing when nothing there takes keystrokes. */
export async function typeText(session: BidiSession, text: string, replace: boolean): Promise<void> {
  const documents = await session.documentContexts(session.requireContext());
  const editable = await Promise.all(documents.map((context) =>
    unlessStale(session.call(focusTakesKeys.toString(), [CLOSED_SHADOW_ROOTS_KEY], undefined, context), false)));
  if (!editable.includes(true)) {
    throw new EngineError(
      'NOT_ACTIONABLE',
      'nothing that takes keystrokes has focus: the typed text would reach no field. Tap the field first, or type into a listed input by id.',
      { retryable: false },
    );
  }
  if (replace) {
    await session.sendInput([pressSource('ControlOrMeta+a')]);
    await session.sendInput([pressSource('Delete')]);
  }
  await session.sendInput([typeSource(text)]);
}

/** Waits until the element can take a pointer action, then clicks its centre. */
async function click(session: BidiSession, target: NodeTarget, deadline: Deadline, options: ClickOptions): Promise<void> {
  const point = await actionPoint(session, target, deadline, true);
  await session.sendInput(clickSources(point.x, point.y, options));
}

/**
 * Polls the element's actionability until it is ready or the deadline
 * passes, and returns its centre in the top-level viewport: each frame
 * holding it is scrolled into view first, and the point is shifted by the
 * frames' boxes.
 */
async function actionPoint(session: BidiSession, target: NodeTarget, deadline: Deadline, enabled: boolean, hitTest = true): Promise<{ x: number; y: number }> {
  for (const frame of session.frames.chain(target.context)) {
    await session.call(ACTION_POINT, [frame.element, false, false, CLOSED_SHADOW_ROOTS_KEY], { awaitPromise: true }, frame.context);
  }
  let last: ActionPoint;
  for (;;) {
    last = await session.read<ActionPoint>(ACTION_POINT, [target.element, enabled, hitTest, CLOSED_SHADOW_ROOTS_KEY], { awaitPromise: true }, target.context);
    if (last.state === 'ok') break;
    if (last.state === 'detached') throw new EngineError('NODE_STALE', 'element is not attached to the DOM', { retryable: true });
    if (deadline.remaining() <= POLL_MS) throw new EngineError('NOT_ACTIONABLE', `element did not become actionable in time: ${blocker(last)}`, { retryable: false });
    await sleep(POLL_MS);
  }
  const box = await session.frames.viewportBox(session.connection, target.context);
  if (box === null) throw new EngineError('NOT_ACTIONABLE', 'element is in a frame that lays out no box', { retryable: false });
  return box === undefined ? { x: last.x, y: last.y } : { x: Math.round(box.x + last.x), y: Math.round(box.y + last.y) };
}

/** What kept an element from being acted on, in Playwright's words. */
function blocker(point: Exclude<ActionPoint, { state: 'ok' }>): string {
  switch (point.state) {
    case 'blocked':
      return point.blocker;
    case 'moving':
      return 'element is not stable';
    case 'hidden':
      return 'element is not visible';
    case 'disabled':
      return 'element is not enabled';
    case 'detached':
      return 'element is not attached to the DOM';
  }
}

/** Replaces the field's content with `value` in one edit, as a paste would; see `FILL`. */
async function fill(session: BidiSession, target: NodeTarget, value: string): Promise<void> {
  const problem = await session.call(FILL, [target.element, value], undefined, target.context);
  if (typeof problem === 'string') throw new EngineError('NOT_ACTIONABLE', problem, { retryable: false });
}

/**
 * Clicks a checkable once when its state differs, then polls until it
 * reads `checked`. A control gone after the click took it: the app replaced
 * it on change.
 */
async function setChecked(session: BidiSession, target: NodeTarget, checked: boolean, deadline: Deadline): Promise<void> {
  const read = (): Promise<{ checked: boolean | null; radio: boolean } | undefined> =>
    session.read(CHECK_STATE, [target.element], undefined, target.context);
  const before = await read();
  if (before?.checked == null) throw new EngineError('NOT_ACTIONABLE', 'element is not a checkbox or radio button', { retryable: false });
  if (before.checked === checked) return;
  if (!checked && before.radio) {
    throw new EngineError('NOT_ACTIONABLE', 'uncheck cannot clear a radio button; select another radio in its group', { retryable: false });
  }
  await click(session, target, deadline, {});
  for (;;) {
    const after = await unlessStale(read(), undefined);
    if (after === undefined || after.checked === checked) return;
    if (deadline.remaining() <= POLL_MS) {
      throw new EngineError('NOT_ACTIONABLE', `${checked ? 'check' : 'uncheck'} clicked the control but its checked state did not change`, { retryable: false });
    }
    await sleep(POLL_MS);
  }
}

/**
 * Attaches files to a file input or one a `<label>` names directly; any
 * other control is clicked with the file chooser awaited
 * (`input.fileDialogOpened`), and the input that chooser serves takes the
 * files. A control that opens no chooser by the deadline fails, as
 * Playwright's upload does.
 */
async function setInputFiles(session: BidiSession, target: NodeTarget, paths: readonly string[], deadline: Deadline): Promise<void> {
  const connection = session.connection;
  const files = paths.map((file) => path.resolve(session.settings.projectRoot, file));
  const input = await session.call(FILE_INPUT, [target.element], undefined, target.context);
  if (input instanceof ElementRef) {
    await connection.send('input.setFiles', { context: target.context, element: { sharedId: input.sharedId }, files });
    return;
  }
  const timer = new AbortController();
  let off: () => void = () => undefined;
  const opened = new Promise<{ context: string; element?: { sharedId: string } } | undefined>((resolve) => {
    off = connection.on('input.fileDialogOpened', (info) => {
      if (session.owns(info.context)) resolve(info);
    });
    timer.signal.addEventListener('abort', () => resolve(undefined));
  });
  try {
    await click(session, target, deadline, {});
    const timeout = setTimeout(() => timer.abort(), Math.max(1, deadline.remaining()));
    const chooser = await opened.finally(() => clearTimeout(timeout));
    if (chooser?.element === undefined) {
      throw new EngineError('NOT_ACTIONABLE', 'upload clicked the control but it opened no file chooser', { retryable: false });
    }
    await connection.send('input.setFiles', { context: chooser.context, element: { sharedId: chooser.element.sharedId }, files });
  } finally {
    off();
  }
}

/**
 * Presses at `from`, moves to `to` over `durationMs`, and releases there.
 * On Chromium a drag the page starts carries its data to the drop
 * (`chromiumDrag`). Firefox's remote agent synthesizes no drop
 * (https://bugzilla.mozilla.org/show_bug.cgi?id=1515879), so there the
 * pointer moves alone.
 */
async function drag(session: BidiSession, from: ViewportPoint, to: ViewportPoint, durationMs: number): Promise<void> {
  if (session.settings.browser !== 'chromium') {
    await session.sendInput(dragSources(from, to, durationMs));
    return;
  }
  const context = session.requireContext();
  await chromiumDrag(session.connection, context, await session.documentContexts(context), dragPath(from, to), dragStepMs(durationMs));
  session.pointer = { x: to.x, y: to.y };
}

/** Wheels at a viewport point by a swipe of `extent`'s size, then waits for the frame that renders it. */
async function wheel(
  session: BidiSession,
  at: ViewportPoint,
  extent: ViewportSize,
  direction: Parameters<typeof wheelDelta>[0],
  momentum: Parameters<typeof swipeDistance>[1],
): Promise<void> {
  const distance = swipeDistance(direction === 'up' || direction === 'down' ? extent.height : extent.width, momentum);
  const [deltaX, deltaY] = wheelDelta(direction, distance);
  const point = nearestPixel(at);
  await session.sendInput(wheelSources(point.x, point.y, deltaX, deltaY));
  await session.call(NEXT_FRAME, [], { awaitPromise: true });
}
