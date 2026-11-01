/**
 * The `browser` fixture on the BiDi driver, declared through the same table
 * as the Playwright fixture so both record the same steps, with the same
 * contracts: a route handler decides each request exactly once, a dialog
 * handler answers each dialog, and a failure on a path no step awaits fails
 * the next step.
 */

import type { Network, Storage } from 'webdriver-bidi-protocol';
import type { Expectable, JsonValue } from 'e2e';
import {
  ConfigurationError,
  Deadline,
  obj,
  parseKey,
  raceAbort,
  rejectUnknownOptions,
  TestError,
  toTextPattern,
  validateJsonValue,
  withTimeout,
  type EngineFixtureContext,
  type OperationContext,
  type TextPattern,
} from 'e2e/engine';
import {
  createBrowserExpectation,
  declareBrowserFixture,
  frameScreen,
  requireSelector,
  type Browser,
  type BrowserExpectation,
  type Cookie,
} from '../browser.ts';
import { compileEvaluation, pageFunctionSource } from '../evaluation.ts';
import { testInitScriptSource } from '../init-scripts.ts';
import { MEDIA_KEYS, mediaProblem } from '../media.ts';
import { parseContinue, parseFulfill, requireNoArguments } from '../route-options.ts';
import { routePatternMatches, routePatternsEqual } from '../route-pattern.ts';
import { isClassified, message as causeMessage } from '../support.ts';
import { releaseQuietly } from './errors.ts';
import type { InterceptedRequest, NetworkRoute, ObservedResponse, RouteDecisions } from './network.ts';
import { clickSources, moveSources, pressSource, typeSource, wheelSources } from './input.ts';
import type { PageArgument } from './script.ts';
import type { BidiSurface } from './surface.ts';

/** Builds the attempt's `browser` fixture over the BiDi surface. */
export function createBidiBrowserFixture(surface: BidiSurface, context: EngineFixtureContext): Browser {
  const baseHref = (): string => context.app.resolveUrl('');
  const navigation = (options: { timeout?: number } | undefined): OperationContext =>
    context.operation(options?.timeout ?? context.timeouts.test);
  const deadlineFor = (timeout: number | undefined): Deadline =>
    new Deadline(context.operation(timeout ?? context.timeouts.assertion).timeoutMs);
  const currentUrl = (deadline?: Deadline): Promise<string> => surface.url(context.operation(deadline?.remaining()));
  const currentTitle = (deadline?: Deadline): Promise<string> => surface.title(context.operation(deadline?.remaining()));
  const expectation = createBrowserExpectation({ currentUrl, currentTitle, baseHref, deadlineFor, context });
  const routes: { readonly pattern: TextPattern; readonly route: NetworkRoute }[] = [];
  const removeRoutes = (match: (stored: (typeof routes)[number]) => boolean): Promise<void> => {
    const removed = new Set(routes.filter(match).map((stored) => stored.route));
    for (let index = routes.length - 1; index >= 0; index -= 1) if (removed.has(routes[index]!.route)) routes.splice(index, 1);
    return surface.unroute((route) => removed.has(route), context.operation());
  };

  const browser: Omit<Browser, keyof Expectable<BrowserExpectation>> = {
    goto: (url, options) => surface.goto(context.app.resolveUrl(url), options?.waitUntil ?? 'load', navigation(options)),
    reload: (options) => surface.reload(navigation(options)),
    back: (options) => surface.back(navigation(options)),
    forward: (options) => surface.forward(navigation(options)),
    url: () => currentUrl(),
    title: () => currentTitle(),
    waitForURL: (url, options) => {
      rejectUnknownOptions('browser.waitForURL', options, ['timeout']);
      return expectation.toHaveURL(url, options);
    },
    locator: (selector) => context.locator({ kind: 'selector', selector: requireSelector('browser.locator', selector) }),
    frameLocator: (selector) => frameScreen(context, [requireSelector('browser.frameLocator', selector)]),
    async evaluate<T extends JsonValue>(fn: string | ((arg?: never) => T | Promise<T>), arg?: JsonValue): Promise<T> {
      const source = typeof fn === 'string' ? fn : pageFunctionSource(fn);
      validateJsonValue(arg, 'evaluate argument');
      const declaration = compileEvaluation(source, arg !== undefined).toString();
      const result = (await surface.evaluate(declaration, arg as PageArgument | undefined, context.operation())) as
        | { ok: true; value: unknown }
        | { ok: false; message: string };
      if (!result.ok) throw new TestError('EVALUATE_FAILED', result.message);
      validateJsonValue(result.value, 'evaluate result');
      return result.value as T;
    },
    async addInitScript(script: unknown, ...rest: unknown[]) {
      const source = await testInitScriptSource(script, rest.length === 0 ? undefined : { arg: rest[0] }, (file) => surface.projectPath(file));
      await surface.addInitScript(source, context.operation());
    },
    route(pattern, handler) {
      const wirePattern = toTextPattern(pattern);
      const route: NetworkRoute = {
        predicate: (url) => routePatternMatches(wirePattern, url.href),
        handle: (request, decisions) => {
          const work = handleRoute(surface, context, request, decisions, handler);
          surface.trackHandler(work);
          return work;
        },
      };
      routes.push({ pattern: wirePattern, route });
      return surface.route(route, context.operation());
    },
    unroute(pattern) {
      const wirePattern = toTextPattern(pattern);
      return removeRoutes((stored) => routePatternsEqual(stored.pattern, wirePattern));
    },
    unrouteAll: () => removeRoutes(() => true),
    async waitForResponse(pattern, options) {
      const wirePattern = toTextPattern(pattern);
      const response = await surface.waitForResponse((url) => routePatternMatches(wirePattern, url), context.operation(options?.timeout));
      return webResponse(context, response, 'waitForResponse');
    },
    cookies: async () => (await surface.cookies(context.operation())).map(toCookie),
    setCookies(cookies) {
      const scheme = new URL(baseHref()).protocol === 'https:' ? 'https' : 'http';
      const partial = cookies.map((cookie): Storage.PartialCookie => {
        const target = context.app.resolveUrl(cookie.url === undefined ? `${scheme}://${cookie.domain.replace(/^\./, '')}` : cookie.url);
        if (!/^https?:/.test(target)) throw new ConfigurationError('POLICY_DENIED', `cookie URL must be http(s): ${target}`);
        const url = new URL(target);
        return {
          name: cookie.name,
          value: { type: 'string', value: cookie.value },
          domain: cookie.url === undefined ? cookie.domain : url.hostname,
          path: cookie.url === undefined ? (cookie.path ?? '/') : '/',
          ...(cookie.expires !== undefined && cookie.expires >= 0 ? { expiry: Math.floor(cookie.expires) } : {}),
          ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
          secure: cookie.secure ?? (cookie.url !== undefined && url.protocol === 'https:'),
          ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite.toLowerCase() as Network.SameSite } : {}),
        };
      });
      return surface.setCookies(partial, context.operation());
    },
    async clearCookies(options) {
      rejectUnknownOptions('browser.clearCookies', options, ['name', 'domain', 'path']);
      const fields = ['name', 'domain', 'path'] as const;
      for (const field of fields) {
        const value = options?.[field];
        if (value !== undefined && typeof value !== 'string' && !(value instanceof RegExp)) {
          throw new TestError('INVALID_ARGUMENT', `browser.clearCookies ${field} must be a string or RegExp`);
        }
      }
      const operation = context.operation();
      if (fields.every((field) => typeof options?.[field] !== 'object')) {
        const filter = Object.fromEntries(fields.flatMap((field) => (options?.[field] === undefined ? [] : [[field, options[field]]])));
        return surface.deleteCookies([filter], operation);
      }
      const matches = (await surface.cookies(operation)).filter((cookie) =>
        fields.every((field) => {
          const wanted = options?.[field];
          return wanted === undefined || (typeof wanted === 'string' ? cookie[field] === wanted : wanted.test(cookie[field]));
        }),
      );
      return surface.deleteCookies(matches.map(({ name, domain, path }) => ({ name, domain, path })), operation);
    },
    setViewport: async (size) => {
      await surface.setViewport(size, context.operation());
      context.attachViewport({ width: size.width, height: size.height, scale: 1 });
    },
    async emulateMedia(media) {
      if (typeof media !== 'object' || media === null) {
        throw new TestError('INVALID_ARGUMENT', 'browser.emulateMedia takes { colorScheme?, reducedMotion? }');
      }
      rejectUnknownOptions('browser.emulateMedia', media, MEDIA_KEYS);
      for (const key of MEDIA_KEYS) {
        const problem = mediaProblem((name) => `browser.emulateMedia({ ${name} })`, key, media[key]);
        if (problem !== undefined) throw new TestError('INVALID_ARGUMENT', problem);
      }
      await surface.emulateMedia(obj({ colorScheme: media.colorScheme, reducedMotion: media.reducedMotion }), context.operation());
    },
    // Async so the harness records the registration as a `browser.onDialog` step.
    async onDialog(handler) {
      const unsubscribe = surface.onDialog(handler);
      return async () => unsubscribe();
    },
    async waitForDownload(trigger, options) {
      const [file] = await downloads(surface, context, trigger, 1, options?.timeout, 'browser.waitForDownload');
      return file!;
    },
    async waitForDownloads(trigger, options) {
      rejectUnknownOptions('browser.waitForDownloads', options, ['count', 'timeout']);
      const count = options?.count;
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new TestError('INVALID_ARGUMENT', 'waitForDownloads: count must be a positive safe integer');
      }
      return downloads(surface, context, trigger, count, options.timeout, 'browser.waitForDownloads');
    },
    keyboard: {
      down: (key) => surface.input('keyboard.down', [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: keyValue(key) }] }], context.operation(), false),
      up: (key) => surface.input('keyboard.up', [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyUp', value: keyValue(key) }] }], context.operation()),
      press: (key) => surface.input('keyboard.press', [pressSource(key)], context.operation()),
      type: (text) => surface.input('keyboard.type', [typeSource(text)], context.operation()),
    },
    mouse: {
      move: (x, y) => surface.input('mouse.move', moveSources(Math.round(x), Math.round(y)), context.operation(), false),
      wheel: (deltaX, deltaY) => {
        const at = surface.pointerPosition();
        return surface.input('mouse.wheel', wheelSources(at.x, at.y, deltaX, deltaY), context.operation());
      },
      down: () => {
        const at = surface.pointerPosition();
        const [source] = clickSources(at.x, at.y);
        const pointer = source as Extract<typeof source, { type: 'pointer' }>;
        return surface.input('mouse.down', [{ ...pointer, actions: pointer.actions.slice(0, 2) }], context.operation(), false);
      },
      up: () => surface.input('mouse.up', [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerUp', button: 0 }] }], context.operation()),
    },
  };
  return declareBrowserFixture(context, browser, expectation);
}

/**
 * Runs one test route handler on a held request with Playwright's contract:
 * exactly one of fulfill, continue, fallback, or abort. A handler that
 * decides twice, returns undecided, or throws fails the next step with its
 * cause (latched on the surface), and an undecided request is aborted rather
 * than left hanging.
 */
async function handleRoute(
  surface: BidiSurface,
  context: EngineFixtureContext,
  request: InterceptedRequest,
  decisions: RouteDecisions,
  handler: Parameters<Browser['route']>[1],
): Promise<void> {
  let decided = false;
  const decideWith = async (name: string, act: () => Promise<void>): Promise<void> => {
    if (decided) throw new TestError('ACTION_FAILED', `route handler already decided; ${name} called twice`);
    decided = true;
    try {
      await act();
    } catch (cause) {
      await releaseQuietly(decisions.abort());
      throw cause;
    }
  };
  const publicRoute: Parameters<Parameters<Browser['route']>[1]>[0] = {
    request: { url: request.url, method: request.method, headers: request.headers, ...(request.postData === undefined ? {} : { postData: request.postData }) },
    fetch: async (...args: unknown[]) => {
      requireNoArguments('route.fetch', args);
      const { signal } = context.operation();
      const fetched = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers, ...surface.siteHeaders(request.url) },
        redirect: 'manual',
        signal,
        ...(request.postData === undefined ? {} : { body: request.postData }),
      });
      const body = Buffer.from(await fetched.arrayBuffer());
      return {
        url: request.url,
        status: fetched.status,
        headers: Object.fromEntries(fetched.headers),
        // oxlint-disable-next-line e2e/no-unchecked-json -- public API: the caller names T, unknown by default
        json: async <T = unknown>() => JSON.parse(body.toString()) as T,
        text: async () => body.toString(),
      };
    },
    fulfill: async (response) => {
      const decision = parseFulfill(response, (file) => surface.projectPath(file));
      await decideWith('fulfill', () => decisions.fulfill(decision));
    },
    continue: async (overrides) => {
      const decision = parseContinue(overrides, request.url, context.app.resolveUrl);
      await decideWith('continue', () => decisions.continue(decision));
    },
    fallback: async (...args: unknown[]) => {
      requireNoArguments('route.fallback', args);
      await decideWith('fallback', () => decisions.fallback());
    },
    abort: async (...args: unknown[]) => {
      requireNoArguments('route.abort', args);
      await decideWith('abort', () => decisions.abort());
    },
  };
  try {
    await handler(publicRoute);
    if (!decided) throw new TestError('ACTION_FAILED', 'route handler returned without calling fulfill, continue, fallback, or abort');
  } catch (cause) {
    surface.latchFailure(isClassified(cause) || cause instanceof Error ? cause : new TestError('ACTION_FAILED', `route handler failed: ${causeMessage(cause)}`));
    if (!decided) await releaseQuietly(decisions.abort());
  }
}

/** A collected response as the fixture reports it; its body is read on a budget of its own when asked for. */
function webResponse(context: EngineFixtureContext, response: ObservedResponse, api: string): Awaited<ReturnType<Browser['waitForResponse']>> {
  const text = async (): Promise<string> => {
    const { signal, timeoutMs } = context.operation();
    const body = await raceAbort(
      withTimeout(response.body(), timeoutMs, () => new TestError('ACTION_FAILED', `${api}: response body did not finish within ${timeoutMs}ms`)),
      signal,
      `${api} body`,
    ).catch((cause: unknown) => {
      if (isClassified(cause)) throw cause;
      throw new TestError('ACTION_FAILED', `${api}: the browser kept no body for ${response.url}: ${causeMessage(cause)}`);
    });
    return body.toString();
  };
  return {
    url: response.url,
    status: response.status,
    headers: response.headers,
    // oxlint-disable-next-line e2e/no-unchecked-json -- public API: the caller names T, unknown by default
    json: async <T = unknown>() => JSON.parse(await text()) as T,
    text,
  };
}

/** Runs `trigger` once and saves the first `count` downloads it starts, each attached as a `download` artifact. */
async function downloads(
  surface: BidiSurface,
  context: EngineFixtureContext,
  trigger: () => Promise<void>,
  count: number,
  timeout: number | undefined,
  api: string,
): Promise<{ path: string; absolutePath: string; suggestedFilename: string }[]> {
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
    throw new TestError('INVALID_ARGUMENT', `${api} timeout must be positive and finite`);
  }
  const { signal, timeoutMs } = context.operation(timeout);
  const files = await withTimeout(
    surface.collectDownloads(count, trigger, signal),
    timeoutMs,
    () => new TestError('ACTION_FAILED', `${count === 1 ? 'no download' : `fewer than ${count} downloads`} finished within ${timeoutMs}ms`),
  );
  for (const file of files) context.attachArtifact('download', file.path);
  return files;
}

/** One key of the grammar as the single WebDriver key value `keyDown` and `keyUp` take; modifiers are refused there. */
function keyValue(key: string): string {
  const parsed = parseKey(key);
  if (parsed === undefined || parsed.modifiers.length > 0) {
    throw new TestError('INVALID_ARGUMENT', `keyboard.down and keyboard.up take one key, got "${key}"`);
  }
  const press = pressSource(key).actions[0];
  return press?.type === 'keyDown' ? press.value : key;
}

/** A BiDi cookie as the fixture reports it. */
function toCookie(cookie: Network.Cookie): Cookie {
  return {
    name: cookie.name,
    value: cookie.value.type === 'string' ? cookie.value.value : Buffer.from(cookie.value.value, 'base64').toString(),
    domain: cookie.domain,
    path: cookie.path,
    ...(cookie.expiry === undefined ? {} : { expires: cookie.expiry }),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    ...(cookie.sameSite === 'default' ? {} : { sameSite: (cookie.sameSite[0]!.toUpperCase() + cookie.sameSite.slice(1)) as NonNullable<Cookie['sameSite']> }),
  };
}
