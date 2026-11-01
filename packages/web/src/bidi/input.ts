/** The contract's key grammar and pointer gestures as WebDriver BiDi `input.performActions` sources. */

import type { Input } from 'webdriver-bidi-protocol';
import { EngineError, parseKey, type KeyModifier, type KeyName } from 'e2e/engine';

/** WebDriver's code points for the named keys (WebDriver spec, "Keyboard actions"). */
const KEY_CODES: Readonly<Record<KeyName, string>> = {
  Enter: '',
  Escape: '',
  Tab: '',
  Backspace: '',
  Delete: '',
  Insert: '',
  Space: ' ',
  ArrowUp: '',
  ArrowDown: '',
  ArrowLeft: '',
  ArrowRight: '',
  Home: '',
  End: '',
  PageUp: '',
  PageDown: '',
  F1: '',
  F2: '',
  F3: '',
  F4: '',
  F5: '',
  F6: '',
  F7: '',
  F8: '',
  F9: '',
  F10: '',
  F11: '',
  F12: '',
};

const MODIFIER_CODES: Readonly<Record<Exclude<KeyModifier, 'ControlOrMeta'>, string>> = {
  Shift: '',
  Control: '',
  Alt: '',
  Meta: '',
};

/** A modifier's WebDriver code point; `ControlOrMeta` is Meta on macOS and Control elsewhere. */
function modifierCode(modifier: KeyModifier): string {
  if (modifier === 'ControlOrMeta') return process.platform === 'darwin' ? MODIFIER_CODES.Meta : MODIFIER_CODES.Control;
  return MODIFIER_CODES[modifier];
}

/** The key source that presses one key of the contract grammar with its modifiers held. */
export function pressSource(key: string): Input.KeySourceActions {
  const parsed = parseKey(key);
  if (parsed === undefined) throw new EngineError('UNSUPPORTED_CAPABILITY', `key "${key}" is outside the key grammar`, { retryable: false });
  const value = parsed.key.kind === 'named' ? KEY_CODES[parsed.key.name] : parsed.key.char;
  const modifiers = parsed.modifiers.map(modifierCode);
  return {
    type: 'key',
    id: 'keyboard',
    actions: [
      ...modifiers.map((code) => ({ type: 'keyDown' as const, value: code })),
      { type: 'keyDown', value },
      { type: 'keyUp', value },
      ...modifiers.toReversed().map((code) => ({ type: 'keyUp' as const, value: code })),
    ],
  };
}

/** The key source that types `text` one grapheme at a time, as a person would; a newline is Enter. */
export function typeSource(text: string): Input.KeySourceActions {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const actions: Input.KeySourceAction[] = [];
  for (const { segment } of segmenter.segment(text)) {
    const value = segment === '\n' || segment === '\r\n' ? KEY_CODES.Enter : segment;
    actions.push({ type: 'keyDown', value }, { type: 'keyUp', value });
  }
  return { type: 'key', id: 'keyboard', actions };
}

/** Pointer button numbers: the primary and the secondary (context-menu) button. */
export type PointerButton = 0 | 2;

export interface ClickOptions {
  readonly button?: PointerButton;
  readonly clicks?: number;
  /** How long each press is held before release. */
  readonly holdMs?: number;
  readonly modifiers?: readonly KeyModifier[];
}

/**
 * The sources of a click at a viewport point: a mouse move, then each press
 * and release, with any modifiers held on a key source across the same ticks.
 */
export function clickSources(x: number, y: number, options: ClickOptions = {}): Input.SourceActions[] {
  const button = options.button ?? 0;
  const pointer: Input.PointerSourceAction[] = [{ type: 'pointerMove', x, y, origin: 'viewport' }];
  for (let click = 0; click < (options.clicks ?? 1); click += 1) {
    pointer.push({ type: 'pointerDown', button });
    if (options.holdMs !== undefined) pointer.push({ type: 'pause', duration: options.holdMs });
    pointer.push({ type: 'pointerUp', button });
  }
  return withModifiers(mouse(pointer), options.modifiers ?? []);
}

/** The source that moves the mouse to a viewport point. */
export function moveSources(x: number, y: number): Input.SourceActions[] {
  return [mouse([{ type: 'pointerMove', x, y, origin: 'viewport' }])];
}

/** Steps a drag moves through between its press and its release, so drag-and-drop libraries see motion. */
const DRAG_STEPS = 5;

/** A drag's points: its start, then each step to `to`. */
export function dragPath(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] {
  const path = [{ x: from.x, y: from.y }];
  for (let index = 1; index <= DRAG_STEPS; index += 1) {
    path.push({
      x: Math.round(from.x + ((to.x - from.x) * index) / DRAG_STEPS),
      y: Math.round(from.y + ((to.y - from.y) * index) / DRAG_STEPS),
    });
  }
  return path;
}

/** How long each step of a drag that lasts `durationMs` takes. */
export function dragStepMs(durationMs: number): number {
  return Math.round(durationMs / DRAG_STEPS);
}

/** The source that presses at `from`, moves to `to` over `durationMs`, and releases there. */
export function dragSources(from: { x: number; y: number }, to: { x: number; y: number }, durationMs = 0): Input.SourceActions[] {
  const step = dragStepMs(durationMs);
  const [start, ...steps] = dragPath(from, to);
  const pointer: Input.PointerSourceAction[] = [
    { type: 'pointerMove', x: start!.x, y: start!.y, origin: 'viewport' },
    { type: 'pointerDown', button: 0 },
    ...steps.map((point) => ({ type: 'pointerMove' as const, x: point.x, y: point.y, origin: 'viewport' as const, ...(step > 0 ? { duration: step } : {}) })),
    { type: 'pointerUp', button: 0 },
  ];
  return [mouse(pointer)];
}

/** The source of one wheel gesture at a viewport point. */
export function wheelSources(x: number, y: number, deltaX: number, deltaY: number): Input.SourceActions[] {
  return [{ type: 'wheel', id: 'wheel', actions: [{ type: 'scroll', x, y, deltaX, deltaY, origin: 'viewport' }] }];
}

function mouse(actions: Input.PointerSourceAction[]): Input.PointerSourceActions {
  return { type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions };
}

/**
 * Holds `modifiers` for the whole pointer sequence: the key source presses
 * them on the first ticks, pauses while the pointer acts, and releases them
 * after it.
 */
function withModifiers(pointer: Input.PointerSourceActions, modifiers: readonly KeyModifier[]): Input.SourceActions[] {
  if (modifiers.length === 0) return [pointer];
  const codes = modifiers.map(modifierCode);
  const keys: Input.KeySourceAction[] = [
    ...codes.map((value) => ({ type: 'keyDown' as const, value })),
    ...pointer.actions.map(() => ({ type: 'pause' as const })),
    ...codes.map((value) => ({ type: 'keyUp' as const, value })),
  ];
  const lead: Input.PointerSourceAction[] = codes.map(() => ({ type: 'pause' }));
  return [{ type: 'key', id: 'keyboard', actions: keys }, { ...pointer, actions: [...lead, ...pointer.actions] }];
}
