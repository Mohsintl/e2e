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
import { actionPoint as readActionPoint, boxSize, checkState, fileInput, fill as fillElement, focus, hitBlocker, nextFrame, selectOption, type ActionPoint } from './page.ts';
import { ElementRef } from './script.ts';
import type { BidiSession } from './session.ts';

/** How long a long press holds the button when the action names no duration. */
const DEFAULT_LONG_PRESS_MS = 500;
/** Pause between actionability checks of an element that is not ready yet. */
const POLL_MS = 50;
/** The roles an inherited `aria-disabled` reaches: the shared reader's list (`read-semantics.ts`), which lives inside its serialized function. */
const ARIA_DISABLED_ROLES = [
  'application', 'button', 'composite', 'gridcell', 'group', 'input', 'link', 'menuitem', 'scrollbar',
  'separator', 'tab', 'checkbox', 'columnheader', 'combobox', 'grid', 'listbox', 'menu', 'menubar',
  'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'radiogroup', 'row', 'rowheader', 'searchbox',
  'select', 'slider', 'spinbutton', 'switch', 'tablist', 'textbox', 'toolbar', 'tree', 'treegrid', 'treeitem',
];
/** What the page's `fill` and `selectOption` refuse for now but may take once the app catches up, polled until the deadline. */
const NOT_YET = new Set(['element is not editable', 'element is not enabled', 'no option matches']);

/** One action on a located or observed node; a `swipe` on the observation root is the viewport swipe at the pointer. */
export async function perform(session: BidiSession, ref: NodeRef, action: LocatorAction, timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (action.kind === 'swipe' && ref.id === ROOT_NODE_ID) {
    await wheel(session, session.pointer, await session.viewportSize(), action.direction, action.momentum ?? 'none', signal);
    return;
  }
  const target = session.refs.lookup(ref);
  const deadline = new Deadline(timeoutMs);
  const held = 'modifiers' in action && action.modifiers !== undefined ? { modifiers: action.modifiers } : {};
  switch (action.kind) {
    case 'tap':
      return click(session, target, deadline, held, signal);
    case 'doubleTap':
      return click(session, target, deadline, { clicks: 2, ...held }, signal);
    case 'secondaryTap':
      return click(session, target, deadline, { button: 2, ...held }, signal);
    case 'longPress':
      return click(session, target, deadline, { holdMs: action.durationMs ?? DEFAULT_LONG_PRESS_MS }, signal);
    case 'hover': {
      const point = await pointerPoint(session, target, deadline, false, signal);
      return session.sendInput(moveSources(point.x, point.y), signal);
    }
    case 'fill':
      return fill(session, target, action.value, deadline, signal);
    case 'clear':
      return fill(session, target, '', deadline, signal);
    case 'press':
      await focusOn(session, target, signal);
      return session.sendInput([pressSource(action.key)], signal);
    case 'focus':
      return focusOn(session, target, signal);
    case 'scrollIntoView':
      await settledPoint(session, target, deadline, { enabled: false, scroll: true }, signal);
      return;
    case 'check':
    case 'uncheck':
      return setChecked(session, target, action.kind === 'check', deadline, signal);
    case 'selectOption': {
      const by = typeof action.value === 'string' ? { label: action.value } : action.value;
      await settledPoint(session, target, deadline, { enabled: true, scroll: true }, signal);
      return mutateWhenReady(session, deadline, signal, 'selectOption: ', () => session.run(selectOption, [target.element, by], target.context));
    }
    case 'setInputFiles':
      return setInputFiles(session, target, action.paths, deadline, signal);
    case 'dragTo':
      return dragTo(session, target, session.refs.lookup(action.target), deadline, signal);
    case 'swipe': {
      const point = await pointerPoint(session, target, deadline, false, signal);
      const box = await session.run(boxSize, [target.element], target.context);
      return wheel(session, point, box.width > 0 ? box : await session.viewportSize(), action.direction, action.momentum ?? 'none', signal);
    }
  }
}

/** One pointer action at a viewport point with nothing resolved behind it. */
export async function performAt(session: BidiSession, point: ViewportPoint, action: PointerAction, signal: AbortSignal): Promise<void> {
  const at = nearestPixel(point);
  switch (action.kind) {
    case 'tap':
      return session.sendInput(clickSources(at.x, at.y), signal);
    case 'doubleTap':
      return session.sendInput(clickSources(at.x, at.y, { clicks: 2 }), signal);
    case 'secondaryTap':
      return session.sendInput(clickSources(at.x, at.y, { button: 2 }), signal);
    case 'longPress':
      return session.sendInput(clickSources(at.x, at.y, { holdMs: action.durationMs ?? DEFAULT_LONG_PRESS_MS }), signal);
    case 'hover':
      return session.sendInput(moveSources(at.x, at.y), signal);
    case 'dragTo':
      return drag(session, at, nearestPixel(action.target), 0, signal);
    case 'swipeTo':
      return drag(session, at, nearestPixel(action.target), action.durationMs ?? 0, signal);
    case 'swipe':
      return wheel(session, at, await session.viewportSize(), action.direction, action.momentum ?? 'none', signal);
  }
}

/** Types into whatever holds focus, in any document of the tab, refusing when nothing there takes keystrokes. */
export async function typeText(session: BidiSession, text: string, replace: boolean, signal: AbortSignal): Promise<void> {
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
    await session.sendInput([pressSource('ControlOrMeta+a')], signal);
    await session.sendInput([pressSource('Delete')], signal);
  }
  await session.sendInput([typeSource(text)], signal);
}

/** Waits until the element can take a pointer action, then clicks it. */
async function click(session: BidiSession, target: NodeTarget, deadline: Deadline, options: ClickOptions, signal: AbortSignal): Promise<void> {
  const point = await pointerPoint(session, target, deadline, true, signal);
  await session.sendInput(clickSources(point.x, point.y, options), signal);
}

/** Focuses the element, a page change its focus handlers may make, refusing when focus does not land on it. */
async function focusOn(session: BidiSession, target: NodeTarget, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  session.mutated();
  if (!(await session.run(focus, [target.element, CLOSED_SHADOW_ROOTS_KEY], target.context))) throw new EngineError('NOT_ACTIONABLE', 'element could not be focused', { retryable: false });
}

/**
 * Polls the element's actionability (`actionPoint`) until it is ready or the
 * deadline passes, each frame holding it settled into view first, and
 * returns the point in its own document's viewport.
 */
async function settledPoint(
  session: BidiSession,
  target: NodeTarget,
  deadline: Deadline,
  checks: { enabled: boolean; scroll: boolean },
  signal: AbortSignal,
): Promise<{ x: number; y: number }> {
  if (checks.scroll) {
    for (const frame of session.frames.chain(target.context)) {
      await session.run(readActionPoint, [frame.element, { enabled: false, scroll: true, key: CLOSED_SHADOW_ROOTS_KEY, ariaDisabledRoles: ARIA_DISABLED_ROLES }], frame.context);
    }
  }
  for (;;) {
    signal.throwIfAborted();
    const point = await session.run(readActionPoint, [target.element, { ...checks, key: CLOSED_SHADOW_ROOTS_KEY, ariaDisabledRoles: ARIA_DISABLED_ROLES }], target.context);
    if (point.state === 'ok') return point;
    if (point.state === 'detached') throw new EngineError('NODE_STALE', 'element is not attached to the DOM', { retryable: true });
    if (deadline.remaining() <= POLL_MS) throw new EngineError('NOT_ACTIONABLE', `element did not become actionable in time: ${blocker(point)}`, { retryable: false });
    await sleep(POLL_MS, undefined, { signal });
  }
}

/**
 * The element's actionable point in the top-level viewport, once a pointer
 * event there reaches it: the element itself is hit in its document, and
 * every iframe holding it is hit at the same point in its parent's. Polls a
 * covered element until the deadline, as Playwright does.
 */
async function pointerPoint(session: BidiSession, target: NodeTarget, deadline: Deadline, enabled: boolean, signal: AbortSignal): Promise<{ x: number; y: number }> {
  for (;;) {
    const local = await settledPoint(session, target, deadline, { enabled, scroll: true }, signal);
    const chain = session.frames.chain(target.context);
    const boxes = await session.frames.contentBoxes(session.connection, target.context);
    if (boxes === null) throw new EngineError('NOT_ACTIONABLE', 'element is in a frame that lays out no box', { retryable: false });
    const offsets = boxes.map((_, index) => boxes.slice(index).reduce((sum, box) => ({ x: sum.x + box.x, y: sum.y + box.y }), { x: 0, y: 0 }));
    const checks = [
      session.run(hitBlocker, [target.element, local.x, local.y, CLOSED_SHADOW_ROOTS_KEY], target.context),
      ...chain.map((frame, index) =>
        session.run(hitBlocker, [frame.element, Math.round(local.x + offsets[index]!.x), Math.round(local.y + offsets[index]!.y), CLOSED_SHADOW_ROOTS_KEY], frame.context)),
    ];
    const blocked = (await Promise.all(checks)).find((reason) => reason !== null);
    const top = offsets[0] ?? { x: 0, y: 0 };
    if (blocked === undefined) return { x: Math.round(local.x + top.x), y: Math.round(local.y + top.y) };
    if (deadline.remaining() <= POLL_MS) throw new EngineError('NOT_ACTIONABLE', `element did not become actionable in time: ${blocked}`, { retryable: false });
    await sleep(POLL_MS, undefined, { signal });
  }
}

/** What kept an element from being acted on, in Playwright's words. */
function blocker(point: Exclude<ActionPoint, { state: 'ok' }>): string {
  switch (point.state) {
    case 'moving':
      return 'element is not stable';
    case 'hidden':
      return 'element is not visible';
    case 'outside':
      return 'element is outside of the viewport';
    case 'disabled':
      return 'element is not enabled';
    case 'detached':
      return 'element is not attached to the DOM';
  }
}

/** Replaces the field's content with `value` in one edit, as a paste would, once it is visible, enabled, and editable; see the page's `fill`. */
async function fill(session: BidiSession, target: NodeTarget, value: string, deadline: Deadline, signal: AbortSignal): Promise<void> {
  await settledPoint(session, target, deadline, { enabled: true, scroll: true }, signal);
  return mutateWhenReady(session, deadline, signal, '', () => session.run(fillElement, [target.element, value, CLOSED_SHADOW_ROOTS_KEY], target.context));
}

/**
 * Runs a page mutation that reports why it refused, polling while the
 * refusal is one the app may lift (`NOT_YET`): such a refusal changed
 * nothing, so it does not count as dispatched. Nothing runs once `signal`
 * aborted.
 */
async function mutateWhenReady(session: BidiSession, deadline: Deadline, signal: AbortSignal, prefix: string, mutate: () => Promise<string | null>): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const dispatched = session.dispatches;
    session.mutated();
    const problem = await mutate();
    if (problem === null) return;
    if (!NOT_YET.has(problem)) throw new EngineError('NOT_ACTIONABLE', `${prefix}${problem}`, { retryable: false });
    session.dispatches = dispatched;
    if (deadline.remaining() <= POLL_MS) throw new EngineError('NOT_ACTIONABLE', `${prefix}${problem}`, { retryable: false });
    await sleep(POLL_MS, undefined, { signal });
  }
}

/**
 * Clicks a checkable once when its state differs, then polls until it
 * reads `checked`. A control gone after the click took it: the app replaced
 * it on change.
 */
async function setChecked(session: BidiSession, target: NodeTarget, checked: boolean, deadline: Deadline, signal: AbortSignal): Promise<void> {
  const before = await session.run(checkState, [target.element], target.context);
  if (before.checked === null) throw new EngineError('NOT_ACTIONABLE', 'element is not a checkbox or radio button', { retryable: false });
  if (before.checked === checked) return;
  if (!checked && before.radio) {
    throw new EngineError('NOT_ACTIONABLE', 'uncheck cannot clear a radio button; select another radio in its group', { retryable: false });
  }
  await click(session, target, deadline, {}, signal);
  for (let first = true; ; first = false) {
    const after = await unlessStale(session.run(checkState, [target.element], target.context), undefined);
    if (after === undefined) {
      if (first) return;
      throw new EngineError('NOT_ACTIONABLE', `${checked ? 'check' : 'uncheck'} clicked the control but its checked state did not change before the control was replaced`, { retryable: false });
    }
    if (after.checked === checked) return;
    if (deadline.remaining() <= POLL_MS) {
      throw new EngineError('NOT_ACTIONABLE', `${checked ? 'check' : 'uncheck'} clicked the control but its checked state did not change`, { retryable: false });
    }
    await sleep(POLL_MS, undefined, { signal });
  }
}

/**
 * Attaches files to a file input or one a `<label>` names directly; any
 * other control is clicked with the file chooser awaited
 * (`input.fileDialogOpened`), and the input that chooser serves takes the
 * files. A control that opens no chooser by the deadline fails, as
 * Playwright's upload does. A browser on another machine is refused:
 * `input.setFiles` takes paths on the browser's own filesystem.
 */
async function setInputFiles(session: BidiSession, target: NodeTarget, paths: readonly string[], deadline: Deadline, signal: AbortSignal): Promise<void> {
  if (session.settings.remoteFiles) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', 'setInputFiles: the BiDi driver cannot send local files to a browser on another machine; use the Playwright driver', { retryable: false });
  }
  const connection = session.connection;
  const files = paths.map((file) => path.resolve(session.settings.projectRoot, file));
  const input = await session.run(fileInput, [target.element], target.context);
  if (input instanceof ElementRef) {
    signal.throwIfAborted();
    session.mutated();
    await connection.send('input.setFiles', { context: target.context, element: { sharedId: input.sharedId }, files });
    return;
  }
  const timer = new AbortController();
  let off: () => void = () => undefined;
  const opened = new Promise<{ context: string; element?: { sharedId: string } } | undefined>((resolve) => {
    off = connection.on('input.fileDialogOpened', (info) => {
      if (session.onPage(info.context)) resolve(info);
    });
    timer.signal.addEventListener('abort', () => resolve(undefined));
  });
  const timeout = setTimeout(() => timer.abort(), Math.max(1, deadline.remaining()));
  const cancel = (): void => timer.abort();
  signal.addEventListener('abort', cancel);
  try {
    await click(session, target, deadline, {}, signal);
    const chooser = await opened;
    signal.throwIfAborted();
    if (chooser?.element === undefined) {
      throw new EngineError('NOT_ACTIONABLE', 'upload clicked the control but it opened no file chooser', { retryable: false });
    }
    await connection.send('input.setFiles', { context: chooser.context, element: { sharedId: chooser.element.sharedId }, files });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
    off();
  }
}

/**
 * Drags the source onto the target: the target is brought into view first,
 * then the source, and the target is read again where the source's scroll
 * left it, so neither end is a stale point. A target the source's scroll
 * pushed out of view fails rather than dropping beside it.
 */
async function dragTo(session: BidiSession, source: NodeTarget, target: NodeTarget, deadline: Deadline, signal: AbortSignal): Promise<void> {
  await pointerPoint(session, target, deadline, false, signal);
  const from = await pointerPoint(session, source, deadline, true, signal);
  const local = await session.run(readActionPoint, [target.element, { enabled: false, scroll: false, key: CLOSED_SHADOW_ROOTS_KEY, ariaDisabledRoles: ARIA_DISABLED_ROLES }], target.context);
  if (local.state !== 'ok') throw new EngineError('NOT_ACTIONABLE', `dragTo: the target cannot be shown with the source: ${blocker(local)}`, { retryable: false });
  const box = await session.frames.viewportBox(session.connection, target.context);
  if (box === null) throw new EngineError('NOT_ACTIONABLE', 'dragTo: the target is in a frame that lays out no box', { retryable: false });
  const to = box === undefined ? local : { x: Math.round(box.x + local.x), y: Math.round(box.y + local.y) };
  await drag(session, from, to, 0, signal);
}

/**
 * Presses at `from`, moves to `to` over `durationMs`, and releases there.
 * On Chromium a drag the page starts carries its data to the drop
 * (`chromiumDrag`). Firefox's remote agent synthesizes no drop
 * (https://bugzilla.mozilla.org/show_bug.cgi?id=1515879), so there the
 * pointer moves alone.
 */
async function drag(session: BidiSession, from: ViewportPoint, to: ViewportPoint, durationMs: number, signal: AbortSignal): Promise<void> {
  if (session.settings.browser !== 'chromium') {
    await session.sendInput(dragSources(from, to, durationMs), signal);
    return;
  }
  const context = session.requireContext();
  const documents = await session.documentContexts(context);
  signal.throwIfAborted();
  session.mutated();
  await chromiumDrag(session.connection, context, documents, dragPath(from, to), dragStepMs(durationMs), signal);
  session.pointer = { x: to.x, y: to.y };
}

/** Wheels at a viewport point by a swipe of `extent`'s size, then waits for the frame that renders it. */
async function wheel(
  session: BidiSession,
  at: ViewportPoint,
  extent: ViewportSize,
  direction: Parameters<typeof wheelDelta>[0],
  momentum: Parameters<typeof swipeDistance>[1],
  signal: AbortSignal,
): Promise<void> {
  const distance = swipeDistance(direction === 'up' || direction === 'down' ? extent.height : extent.width, momentum);
  const [deltaX, deltaY] = wheelDelta(direction, distance);
  const point = nearestPixel(at);
  await session.sendInput(wheelSources(point.x, point.y, deltaX, deltaY), signal);
  await session.run(nextFrame, []);
}
