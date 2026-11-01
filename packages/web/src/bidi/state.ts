/** Saved sessions on the BiDi driver: a user context's cookies and its pages' localStorage. */

import type { Network } from 'webdriver-bidi-protocol';
import { EngineError, type EngineState } from 'e2e/engine';
import { releaseQuietly } from './errors.ts';
import type { BidiSession } from './session.ts';

const STATE_FORMAT = 'bidi-storage-state';

/** One origin's localStorage in a saved state. */
interface StoredOrigin {
  readonly origin: string;
  readonly localStorage: readonly { readonly name: string; readonly value: string }[];
}

/** What a saved BiDi state holds: the user context's cookies and each saved origin's localStorage. */
interface BidiStorageState {
  readonly cookies: readonly Network.Cookie[];
  readonly origins: readonly StoredOrigin[];
}

/** True for the saved-state shape; anything else is refused before it reaches the browser. */
function isStorageState(data: unknown): data is BidiStorageState {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as { cookies?: unknown }).cookies) &&
    Array.isArray((data as { origins?: unknown }).origins)
  );
}

const READ_LOCAL_STORAGE = `() => /^https?:$/.test(location.protocol)
  ? { origin: location.origin, localStorage: Object.keys(localStorage).map((name) => ({ name, value: localStorage.getItem(name) })) }
  : null`;

const WRITE_LOCAL_STORAGE = '(items) => { localStorage.clear(); for (const { name, value } of items) localStorage.setItem(name, value); }';

/** The user context's cookies and the open page's localStorage. */
export async function captureState(session: BidiSession): Promise<EngineState> {
  const { cookies } = await session.connection.send('storage.getCookies', { partition: session.partition() });
  const origins: StoredOrigin[] = [];
  if (session.context !== undefined) {
    const local = await session.read<StoredOrigin | null>(READ_LOCAL_STORAGE, [], { maxObjectDepth: null });
    if (local !== null && local.localStorage.length > 0) origins.push(local);
  }
  const data: BidiStorageState = { cookies, origins };
  return { format: STATE_FORMAT, version: 1, data };
}

/**
 * Replaces the user context with a clean one holding the snapshot: cookies
 * through `storage.setCookie`, and each origin's localStorage written from
 * a blank document served at that origin through a network intercept, so
 * the app's server sees no request.
 */
export async function restoreState(session: BidiSession, state: EngineState): Promise<void> {
  if (state.format !== STATE_FORMAT || state.version !== 1 || !isStorageState(state.data)) {
    throw new EngineError('INVALID_STATE', `unsupported state format ${state.format}@${String(state.version)}`, { retryable: false });
  }
  const connection = session.connection;
  await session.replaceUserContext();
  for (const { size: _size, ...cookie } of state.data.cookies) {
    await connection.send('storage.setCookie', { cookie, partition: session.partition() });
  }
  if (state.data.origins.length === 0) return;
  const context = await session.ensureContext();
  const { intercept } = await connection.send('network.addIntercept', { phases: ['beforeRequestSent'], contexts: [context] });
  const { subscription } = await connection.send('session.subscribe', { events: ['network.beforeRequestSent'], contexts: [context] });
  let served: Error | undefined;
  const off = connection.on('network.beforeRequestSent', (event) => {
    if (event.context !== context || !event.isBlocked) return;
    connection.send('network.provideResponse', {
      request: event.request.request,
      statusCode: 200,
      headers: [{ name: 'content-type', value: { type: 'string', value: 'text/html' } }],
      body: { type: 'string', value: '<!doctype html><title></title>' },
    }).catch((cause: unknown) => {
      served ??= cause instanceof Error ? cause : new Error(String(cause));
    });
  });
  try {
    for (const origin of state.data.origins) {
      await connection.send('browsingContext.navigate', { context, url: `${origin.origin}/`, wait: 'complete' });
      if (served !== undefined) throw served;
      await session.call(WRITE_LOCAL_STORAGE, [origin.localStorage.map(({ name, value }) => ({ name, value }))]);
    }
  } finally {
    off();
    await releaseQuietly(connection.send('session.unsubscribe', { subscriptions: [subscription] }));
    await releaseQuietly(connection.send('network.removeIntercept', { intercept }));
  }
  await connection.send('browsingContext.navigate', { context, url: 'about:blank', wait: 'complete' });
}
