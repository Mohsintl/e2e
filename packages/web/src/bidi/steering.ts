/** Navigation on the BiDi driver: open, history, reload, and the attempt's restart and reset. */

import { setTimeout as sleep } from 'node:timers/promises';
import { Deadline, EngineError } from 'e2e/engine';
import { isStale, releaseQuietly } from './errors.ts';
import type { BidiSession } from './session.ts';

/** How a navigation waits: the `waitUntil` the `browser` fixture takes. */
export type WaitUntil = 'load' | 'domcontentloaded' | 'commit' | 'networkidle';

/** Pause between reads of a history navigation that has not landed yet. */
const POLL_MS = 50;

/**
 * Navigates the attempt's tab to `url`, creating it on first use. A
 * `networkidle` wait then holds until no request has been in flight for
 * 500 ms, counted from before the navigation started.
 */
export async function goto(session: BidiSession, url: string, waitUntil: WaitUntil, signal: AbortSignal): Promise<void> {
  const context = await session.ensureContext();
  await session.grantPermissions(url);
  if (waitUntil === 'networkidle') await session.network.track();
  const wait = waitUntil === 'load' || waitUntil === 'networkidle' ? 'complete' : waitUntil === 'domcontentloaded' ? 'interactive' : 'none';
  await session.connection.send('browsingContext.navigate', { context, url, wait });
  if (waitUntil === 'networkidle') await session.network.waitForIdle(signal);
}

/** Reloads the tab and waits for its load event. */
export async function reload(session: BidiSession): Promise<void> {
  await session.connection.send('browsingContext.reload', { context: session.requireContext(), wait: 'complete' });
}

/**
 * Moves `delta` entries through the tab's history and waits until the
 * document it lands on has loaded: a `browsingContext.load` event for the
 * tab, or a new URL whose document reads complete, which a page restored
 * from the back-forward cache shows without a load event.
 */
export async function traverse(session: BidiSession, delta: number, timeoutMs: number): Promise<void> {
  const connection = session.connection;
  const context = session.requireContext();
  const deadline = new Deadline(timeoutMs);
  const before = await session.currentUrl();
  let loaded = false;
  const off = connection.on('browsingContext.load', (event) => {
    if (event.context === context) loaded = true;
  });
  const { subscription } = await connection.send('session.subscribe', { events: ['browsingContext.load'], contexts: [context] });
  try {
    await connection.send('browsingContext.traverseHistory', { context, delta });
    for (;;) {
      if (loaded) return;
      const settled = await landedUrl(session);
      if (settled !== undefined && settled !== before) return;
      if (deadline.expired()) throw new EngineError('OPERATION_TIMEOUT', 'history navigation did not load in time', { retryable: false });
      await sleep(POLL_MS);
    }
  } finally {
    off();
    await releaseQuietly(connection.send('session.unsubscribe', { subscriptions: [subscription] }));
  }
}

/** The tab's URL once its document reads complete; undefined while it loads or is being replaced. */
async function landedUrl(session: BidiSession): Promise<string | undefined> {
  try {
    const url = await session.call("() => document.readyState === 'complete' ? location.href : null");
    return typeof url === 'string' ? url : undefined;
  } catch (cause) {
    if (isStale(cause)) return undefined;
    throw cause;
  }
}

/** Closes the tab, keeping the user context's storage; the harness reopens the app. */
export function restart(session: BidiSession): Promise<void> {
  return session.closeContext();
}

/** Replaces the user context with a clean one and opens its blank tab. */
export async function reset(session: BidiSession): Promise<void> {
  await session.replaceUserContext();
  await session.ensureContext();
}
