/**
 * The `browser` fixture on the BiDi driver: navigation, reads, evaluation,
 * cookies, the viewport, and raw input, declared through the same table as
 * the Playwright fixture so both record the same steps. Request routing,
 * response waits, init scripts added mid-test, media emulation, dialogs, and
 * downloads refuse with `UNSUPPORTED_CAPABILITY` until the driver has them.
 */

import type { Network, Storage } from 'webdriver-bidi-protocol';
import type { Expectable, JsonValue } from 'e2e';
import {
  ConfigurationError,
  Deadline,
  parseKey,
  rejectUnknownOptions,
  TestError,
  validateJsonValue,
  type EngineFixtureContext,
  type OperationContext,
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
  const unsupported = (method: string) => async (): Promise<never> => {
    throw new TestError('UNSUPPORTED_CAPABILITY', `browser.${method} is not implemented on the BiDi driver yet; use web({ driver: 'playwright' })`);
  };

  const browser: Omit<Browser, keyof Expectable<BrowserExpectation>> = {
    goto: async (url, options) => {
      const waitUntil = options?.waitUntil ?? 'load';
      if (waitUntil === 'networkidle') {
        throw new TestError('UNSUPPORTED_CAPABILITY', "browser.goto waitUntil 'networkidle' has no WebDriver BiDi equivalent; use 'load'");
      }
      await surface.goto(context.app.resolveUrl(url), waitUntil, navigation(options));
    },
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
    addInitScript: unsupported('addInitScript'),
    route: unsupported('route'),
    unroute: unsupported('unroute'),
    unrouteAll: unsupported('unrouteAll'),
    waitForResponse: unsupported('waitForResponse'),
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
      // A RegExp filter is matched here, and each cookie it selects deleted by its exact identity.
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
    emulateMedia: unsupported('emulateMedia'),
    onDialog: unsupported('onDialog'),
    waitForDownload: unsupported('waitForDownload'),
    waitForDownloads: unsupported('waitForDownloads'),
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
