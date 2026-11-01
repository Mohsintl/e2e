/**
 * The `browser` fixture on the BiDi driver: the shared declaration,
 * matchers, route contract, and argument checks (`browser-calls.ts`), over
 * the BiDi surface's calls.
 */

import type { Network, Storage } from 'webdriver-bidi-protocol';
import type { Expectable, JsonValue } from 'e2e';
import { Deadline, rejectUnknownOptions, TestError, toTextPattern, type EngineFixtureContext, type OperationContext, type TextPattern } from 'e2e/engine';
import { createBrowserExpectation, declareBrowserFixture, frameScreen, requireSelector, type Browser, type BrowserExpectation, type Cookie } from '../browser.ts';
import {
  cookieTargets,
  readResponseBody,
  requireCookieFilter,
  requireDownloadCount,
  requireDownloadTimeout,
  requireMedia,
  runRouteHandler,
  waitedResponse,
  type RouteAdapter,
} from '../browser-calls.ts';
import { evaluateInPage } from '../evaluation.ts';
import { testInitScriptSource } from '../init-scripts.ts';
import { routePatternMatches, routePatternsEqual } from '../route-pattern.ts';
import { fixtureKeySource, moveSources, pressDownSources, releaseSources, typeSource, wheelSources } from './input.ts';
import type { InterceptedRequest, NetworkRoute, RouteDecisions } from './network.ts';
import type { PageArgument } from './script.ts';
import type { BidiSurface } from './surface.ts';

/** Builds the attempt's `browser` fixture over the BiDi surface. */
export function createBidiBrowserFixture(surface: BidiSurface, context: EngineFixtureContext): Browser {
  const navigation = (options: { timeout?: number } | undefined): OperationContext => context.operation(options?.timeout ?? context.timeouts.test);
  const currentUrl = (deadline?: Deadline): Promise<string> => surface.url(context.operation(deadline?.remaining()));
  const currentTitle = (deadline?: Deadline): Promise<string> => surface.title(context.operation(deadline?.remaining()));
  const expectation = createBrowserExpectation({
    currentUrl,
    currentTitle,
    baseHref: () => context.app.resolveUrl(''),
    deadlineFor: (timeout) => new Deadline(context.operation(timeout ?? context.timeouts.assertion).timeoutMs),
    context,
  });
  const heldKeys = new Set<string>();
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
    evaluate<T extends JsonValue>(fn: string | ((arg?: never) => T | Promise<T>), arg?: JsonValue): Promise<T> {
      return evaluateInPage(fn, arg, (evaluate, input) => surface.evaluate(evaluate.toString(), input as PageArgument | undefined, context.operation()));
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
          const work = runRouteHandler(handler, routeAdapter(surface, context, request, decisions), (error) => surface.latchFailure(error), context, (file) => surface.projectPath(file));
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
      return waitedResponse(context, response, readResponseBody('waitForResponse', () => response.body()));
    },
    cookies: async () => (await surface.cookies(context.operation())).map(toCookie),
    setCookies(cookies) {
      const targets = cookieTargets(cookies, context);
      const partial = cookies.map((cookie, index): Storage.PartialCookie => {
        const target = targets[index]!;
        const url = 'url' in target ? new URL(target.url) : undefined;
        return {
          name: cookie.name,
          value: { type: 'string', value: cookie.value },
          domain: url?.hostname ?? ('domain' in target ? target.domain : ''),
          path: url === undefined && 'path' in target ? target.path : '/',
          ...(cookie.expires !== undefined && cookie.expires >= 0 ? { expiry: Math.floor(cookie.expires) } : {}),
          ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
          secure: cookie.secure ?? url?.protocol === 'https:',
          ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite.toLowerCase() as Network.SameSite } : {}),
        };
      });
      return surface.setCookies(partial, context.operation());
    },
    async clearCookies(options) {
      requireCookieFilter(options);
      const fields = ['name', 'domain', 'path'] as const;
      const operation = context.operation();
      if (fields.every((field) => typeof options?.[field] !== 'object')) {
        const filter = Object.fromEntries(fields.flatMap((field) => (options?.[field] === undefined ? [] : [[field, options[field]]])));
        return surface.deleteCookies([filter], operation);
      }
      const matches = (await surface.cookies(operation)).filter((cookie) =>
        fields.every((field) => {
          const wanted = options?.[field];
          return wanted === undefined || (typeof wanted === 'string' ? cookie[field] === wanted : new RegExp(wanted.source, wanted.flags).test(cookie[field]));
        }),
      );
      return surface.deleteCookies(matches.map(({ name, domain, path }) => ({ name, domain, path })), operation);
    },
    setViewport: async (size) => {
      await surface.setViewport(size, context.operation());
      context.attachViewport({ width: size.width, height: size.height, scale: 1 });
    },
    emulateMedia: (media) => surface.emulateMedia(requireMedia(media), context.operation()),
    // Async so the harness records the registration as a `browser.onDialog` step.
    async onDialog(handler) {
      const unsubscribe = surface.onDialog(handler);
      return async () => unsubscribe();
    },
    async waitForDownload(trigger, options) {
      const [file] = await downloads(surface, context, trigger, 1, options?.timeout, 'browser.waitForDownload');
      return file!;
    },
    waitForDownloads: (trigger, options) => downloads(surface, context, trigger, requireDownloadCount(options), options.timeout, 'browser.waitForDownloads'),
    keyboard: {
      down: async (key) => {
        await surface.input('keyboard.down', [fixtureKeySource(key, 'keyDown', heldKeys.has('Shift'))], context.operation());
        heldKeys.add(key);
      },
      up: async (key) => {
        await surface.input('keyboard.up', [fixtureKeySource(key, 'keyUp', heldKeys.has('Shift'))], context.operation());
        heldKeys.delete(key);
      },
      press: (key) => surface.input('keyboard.press', [fixtureKeySource(key, 'press', heldKeys.has('Shift'))], context.operation()),
      type: (text) => surface.input('keyboard.type', [typeSource(text)], context.operation()),
    },
    mouse: {
      move: (x, y) => surface.input('mouse.move', moveSources(Math.round(x), Math.round(y)), context.operation()),
      wheel: (deltaX, deltaY) => {
        const at = surface.pointerPosition();
        return surface.input('mouse.wheel', wheelSources(at.x, at.y, deltaX, deltaY), context.operation());
      },
      down: () => {
        const at = surface.pointerPosition();
        return surface.input('mouse.down', pressDownSources(at.x, at.y), context.operation());
      },
      up: () => surface.input('mouse.up', releaseSources(), context.operation()),
    },
  };
  return declareBrowserFixture(context, browser, expectation);
}

/**
 * A held request as the shared route contract drives it. `fetch` replays it
 * from Node as the browser sent it (its body bytes, its cookies, and the
 * site headers) within the operation's budget, and stores the cookies the
 * response sets in the user context, as Playwright's `route.fetch` does. A
 * body the browser did not keep refuses the replay rather than send none.
 */
function routeAdapter(surface: BidiSurface, context: EngineFixtureContext, request: InterceptedRequest, decisions: RouteDecisions): RouteAdapter {
  return {
    request: { url: request.url, method: request.method, headers: request.headers, ...(request.postData === undefined ? {} : { postData: request.postData }) },
    fetch: async () => {
      if (request.bodyUnavailable === true) {
        throw new TestError('ACTION_FAILED', 'route.fetch: the browser kept none of the request body (too large or streamed), so the request cannot be replayed');
      }
      const operation = context.operation();
      const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(operation.timeoutMs)]);
      const fetched = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers, ...(request.cookie === undefined ? {} : { cookie: request.cookie }), ...surface.siteHeaders(request.url) },
        redirect: 'manual',
        signal,
        ...(request.body === undefined ? {} : { body: new Uint8Array(request.body) }),
      });
      const cookies = fetched.headers.getSetCookie().flatMap((header) => setCookieOf(header, new URL(request.url)) ?? []);
      if (cookies.length > 0) await surface.setCookies(cookies, operation);
      const text = await readResponseBody('route.fetch', async () => Buffer.from(await fetched.arrayBuffer()));
      // oxlint-disable-next-line e2e/no-unchecked-json -- public API: the caller names T, unknown by default
      return { url: request.url, status: fetched.status, headers: Object.fromEntries(fetched.headers), json: async <T = unknown>() => JSON.parse(await text()) as T, text };
    },
    fulfill: (decision) => decisions.fulfill(decision),
    continue: (decision) => decisions.continue(decision),
    fallback: () => decisions.fallback(),
    abort: () => decisions.abort(),
  };
}

/** One `Set-Cookie` header of a response from `url` as a cookie to store; undefined for one with no name. */
export function setCookieOf(header: string, url: URL): Storage.PartialCookie | undefined {
  const [pair = '', ...attributes] = header.split(';');
  const split = pair.indexOf('=');
  const name = pair.slice(0, split).trim();
  if (split <= 0 || name === '') return undefined;
  const directory = url.pathname.slice(0, url.pathname.lastIndexOf('/'));
  const attribute = new Map<string, string>();
  for (const each of attributes) {
    const at = each.indexOf('=');
    attribute.set((at === -1 ? each : each.slice(0, at)).trim().toLowerCase(), at === -1 ? '' : each.slice(at + 1).trim());
  }
  const domain = attribute.get('domain') ?? '';
  const path = attribute.get('path') ?? '';
  const sameSite = attribute.get('samesite')?.toLowerCase() ?? '';
  const maxAge = attribute.get('max-age') ?? '';
  const expires = Date.parse(attribute.get('expires') ?? '');
  const expiry = /^-?\d+$/.test(maxAge) ? Math.floor(Date.now() / 1000) + Number(maxAge) : Number.isNaN(expires) ? undefined : Math.floor(expires / 1000);
  return {
    name,
    value: { type: 'string', value: pair.slice(split + 1).trim() },
    domain: domain === '' ? url.hostname : domain,
    path: path.startsWith('/') ? path : directory === '' ? '/' : directory,
    ...(attribute.has('secure') ? { secure: true } : {}),
    ...(attribute.has('httponly') ? { httpOnly: true } : {}),
    ...(['strict', 'lax', 'none'].includes(sameSite) ? { sameSite: sameSite as Network.SameSite } : {}),
    ...(expiry === undefined ? {} : { expiry }),
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
  requireDownloadTimeout(timeout, api);
  const { signal, timeoutMs } = context.operation(timeout);
  const files = await surface.collectDownloads(count, trigger, signal, timeoutMs);
  for (const file of files) context.attachArtifact('download', file.path);
  return files;
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
