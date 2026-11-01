/**
 * The WebDriver BiDi surface: one browser per worker and one `BidiSession`
 * per attempt, behind the same engine hooks and `browser` fixture calls as
 * `PlaywrightSurface`. Each hook is bounded and classified here and
 * delegates to the module that implements it.
 */

import { copyFileSync } from 'node:fs';
import path from 'node:path';
import type { Input, Network, Storage } from 'webdriver-bidi-protocol';
import {
  EngineError,
  raceAbort,
  withinCleanupBudget,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineFinishInfo,
  type EngineInitInfo,
  type EngineObserveOptions,
  type EnginePrepareInfo,
  type EnginePrepareResult,
  type EngineSnapshot,
  type EngineState,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type OperationContext,
  type PointerAction,
  type SemanticNode,
  type VideoFile,
  type ViewportPoint,
  type ViewportSize,
} from 'e2e/engine';
import type { DialogHandler } from '../dialogs.ts';
import type { ConfiguredInitScripts } from '../init-scripts.ts';
import { ensureBrowsersInstalled } from '../install.ts';
import type { WebMedia } from '../media.ts';
import { withOperationDeadline } from '../operation-budget.ts';
import { httpCredentials, lowercaseNames, siteHeadersFor } from '../protected-app.ts';
import type { LeasedBrowsers } from '../provider.ts';
import { cancelled, invalidState } from '../support.ts';
import type { WebBasicAuth, WebScreencastOptions } from '../surface.ts';
import { perform, performAt, typeText } from './actions.ts';
import { screenshot, startVideo, stopVideo } from './artifacts.ts';
import { classify } from './errors.ts';
import { routeEvents, SESSION_EVENTS } from './events.ts';
import { pressSource } from './input.ts';
import { connectBidiOverCdp, launchBidiBrowser, type BidiBrowser, type BidiBrowserName } from './launch.ts';
import type { NetworkRoute, ObservedResponse } from './network.ts';
import { locate, observe } from './observe.ts';
import type { PageArgument, PageValue } from './script.ts';
import { BidiSession, ContextOwners, type SessionSettings } from './session.ts';
import { captureState, restoreState } from './state.ts';
import { goto, reload, reset, restart, traverse, type WaitUntil } from './steering.ts';

/** Browser launch budget when the harness init budget is not otherwise expressed. */
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;

export interface BidiSurfaceOptions {
  readonly browser: BidiBrowserName;
  readonly viewport: ViewportSize | null;
  readonly testIdAttribute: string;
  readonly initScripts: ConfiguredInitScripts;
  readonly screencast: WebScreencastOptions;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly basicAuth: WebBasicAuth | undefined;
  readonly userAgent: string | undefined;
  readonly locale: string | undefined;
  readonly timezoneId: string | undefined;
  /** The configured media features every attempt starts from. */
  readonly media: WebMedia;
  /** Resolves a remote Chromium's CDP endpoint instead of launching one (`web({ connect })`). */
  readonly cdpEndpoint: ((signal: AbortSignal) => string | Promise<string>) | undefined;
  /** A browser provider's worker-scoped leases, attached to over CDP. */
  readonly leases: LeasedBrowsers | undefined;
}

export class BidiSurface {
  private browser: BidiBrowser | undefined;
  private session: BidiSession | undefined;
  private settings: SessionSettings | undefined;
  private headed = false;
  private readonly owners = new ContextOwners();
  private unrouteEvents: () => void = () => undefined;

  constructor(private readonly options: BidiSurfaceOptions) {}

  /** Installs the build this driver launches, or leases a provider's browsers, once per run; reads the init scripts. */
  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult | void> {
    await this.options.initScripts.load(info.projectRoot);
    if (this.options.leases !== undefined) return this.options.leases.prepare(info);
    if (this.options.cdpEndpoint !== undefined) return;
    await ensureBrowsersInstalled([this.options.browser], { env: info.env, signal: info.signal, log: info.log, headed: info.headed });
  }

  /** Releases what `prepare` leased. */
  async finish(info: EngineFinishInfo): Promise<void> {
    await this.options.leases?.finish(info);
  }

  /** Launches or attaches to the worker's browser. */
  async init(info: EngineInitInfo): Promise<void> {
    this.headed = info.headed;
    const headers = this.options.headers === undefined ? undefined : lowercaseNames(this.options.headers);
    const site = info.app.site;
    this.settings = {
      browser: this.options.browser,
      viewport: this.options.viewport,
      initScripts: this.options.initScripts,
      screencast: this.options.screencast,
      userAgent: this.options.userAgent,
      locale: this.options.locale,
      timezoneId: this.options.timezoneId,
      media: this.options.media,
      testIdAttribute: this.options.testIdAttribute,
      site,
      projectRoot: info.projectRoot,
      permissions: Object.keys(info.app.permissions ?? {}),
      holdRequests: headers !== undefined,
      siteHeaders: (url) => siteHeadersFor(url, site, headers),
    };
    this.options.leases?.init(info);
    await this.options.initScripts.load(info.projectRoot);
    await this.acquireBrowser(info.signal);
  }

  /** The live browser, relaunched or reattached when the last one went away. */
  private async acquireBrowser(signal: AbortSignal): Promise<BidiBrowser> {
    if (this.browser !== undefined && !this.browser.connection.isClosed) return this.browser;
    if (signal.aborted) throw cancelled('browser launch cancelled');
    const browser = await raceAbort(this.openBrowser(signal), signal, 'browser launch');
    this.browser = browser;
    this.owners.clear();
    this.unrouteEvents();
    this.unrouteEvents = routeEvents(browser.connection, this.owners, () => this.session);
    await browser.connection.send('session.subscribe', { events: [...SESSION_EVENTS] });
    return browser;
  }

  /** A local launch, or an attach over CDP to the `connect` endpoint or a provider's lease. */
  private async openBrowser(signal: AbortSignal): Promise<BidiBrowser> {
    const { cdpEndpoint, leases } = this.options;
    if (cdpEndpoint !== undefined) return connectBidiOverCdp(await cdpEndpoint(signal), BROWSER_LAUNCH_TIMEOUT_MS);
    if (leases !== undefined) return connectBidiOverCdp(await leases.endpoint(signal), BROWSER_LAUNCH_TIMEOUT_MS);
    return launchBidiBrowser(this.options.browser, { headed: this.headed, timeoutMs: BROWSER_LAUNCH_TIMEOUT_MS, firefoxPrefs: firefoxMediaPrefs(this.options.media) });
  }

  /** Opens the attempt's session: its user context, network, downloads, and emulation. */
  async startAttempt(context: EngineAttemptContext): Promise<void> {
    if (this.session !== undefined) throw invalidState('an attempt is already running');
    if (this.settings === undefined) throw invalidState('the engine is not initialized');
    const basicAuth = this.options.basicAuth;
    const credentials = basicAuth === undefined
      ? undefined
      : await raceAbort(() => httpCredentials(basicAuth, context.resolveSecret), context.signal, 'resolving the basic-auth password');
    const browser = await this.acquireBrowser(context.signal);
    const session = new BidiSession(browser, this.settings, { artifactsDir: context.artifactsDir, appLog: context.appLog, credentials }, this.owners);
    this.session = session;
    await session.openUserContext();
    context.environment({ browser: `${browser.name} ${browser.version}`, driver: 'webdriver-bidi' });
  }

  /** Waits for a dialog or route handler still running, then rethrows what it latched. */
  async settleAttempt(context: EngineCleanupContext): Promise<void> {
    await this.session?.latch.settle(context);
  }

  /** Ends the attempt's session. Idempotent; a browser already gone has nothing left to close. */
  async endAttempt(context: EngineCleanupContext): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session === undefined) return;
    if (session.connection.isClosed) {
      session.downloads.dispose();
      return;
    }
    await withinCleanupBudget(session.close(), context);
  }

  /** Ends the attempt, closes the browser, and releases a provider's lease, each attempted whatever the others did. */
  async dispose(context: EngineCleanupContext): Promise<void> {
    const browser = this.browser;
    const results = await Promise.allSettled([this.endAttempt(context)]);
    this.browser = undefined;
    if (browser !== undefined) results.push(...(await Promise.allSettled([withinCleanupBudget(browser.close(), context)])));
    this.unrouteEvents();
    results.push(...(await Promise.allSettled([this.options.leases?.dispose(context)])));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw classify(failed.reason, 'dispose');
  }

  private requireSession(): BidiSession {
    if (this.session === undefined) throw invalidState('no attempt is running');
    return this.session;
  }

  /** Bounds one operation by its budget, fails it with an error a handler latched, and classifies what it threw. */
  private async guard<T>(
    operation: OperationContext,
    label: string,
    work: (session: BidiSession, budget: { readonly signal: AbortSignal; readonly timeoutMs: number }) => Promise<T>,
  ): Promise<T> {
    this.session?.latch.throwPending();
    try {
      return await withOperationDeadline(operation, label, (remaining) => work(this.requireSession(), remaining()));
    } catch (cause) {
      throw classify(cause, label);
    }
  }

  open(url: string, operation: OperationContext): Promise<void> {
    return this.goto(url, 'load', operation);
  }

  back(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', (session, budget) => traverse(session, -1, budget.timeoutMs));
  }

  forward(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', (session, budget) => traverse(session, 1, budget.timeoutMs));
  }

  restart(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'restart', (session) => restart(session));
  }

  reset(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'state reset', (session) => reset(session));
  }

  goto(url: string, waitUntil: WaitUntil, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', (session, budget) => goto(session, url, waitUntil, budget.signal));
  }

  reload(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', (session) => reload(session));
  }

  observe(operation: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot> {
    return this.guard(operation, 'observe', (session, budget) => observe(session, budget.timeoutMs, budget.signal, options));
  }

  locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    return this.guard(operation, 'locate', (session) => locate(session, expression));
  }

  perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    return this.guard(operation, action.kind, (session, budget) => perform(session, ref, action, budget.timeoutMs));
  }

  performAt(point: ViewportPoint, action: PointerAction, operation: OperationContext): Promise<void> {
    return this.guard(operation, `${action.kind} at point`, (session) => performAt(session, point, action));
  }

  typeText(text: string, options: { readonly replace: boolean }, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'keyboard.type', (session) => typeText(session, text, options.replace));
  }

  pressKey(key: string, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'keyboard.press', (session) => session.sendInput([pressSource(key)]));
  }

  /** Runs raw input sources, holding what they leave pressed when `release` is false (`keyboard.down`). */
  input(label: string, actions: Input.SourceActions[], operation: OperationContext, release = true): Promise<void> {
    return this.guard(operation, label, (session) => session.sendInput(actions, release));
  }

  /** Where the mouse last moved in the attempt's tab. */
  pointerPosition(): ViewportPoint {
    return this.requireSession().pointer;
  }

  url(operation: OperationContext): Promise<string> {
    return this.guard(operation, 'url', (session) => session.currentUrl());
  }

  title(operation: OperationContext): Promise<string> {
    return this.guard(operation, 'title', async (session) => String(await session.call('() => document.title')));
  }

  /** Calls a compiled page function (`compileEvaluation`) with `arg` and returns its whole result. */
  evaluate(declaration: string, arg: PageArgument | undefined, operation: OperationContext): Promise<PageValue> {
    return this.guard(operation, 'evaluate', (session) => session.call(declaration, arg === undefined ? [] : [arg], { awaitPromise: true, maxObjectDepth: null }));
  }

  addInitScript(source: string, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'addInitScript', (session) => session.addInitScript(source));
  }

  /** The absolute path of a file a test names relative to the project root. */
  projectPath(file: string): string {
    return path.resolve(this.settings?.projectRoot ?? '', file);
  }

  route(route: NetworkRoute, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'route', (session) => session.network.addRoute(route));
  }

  unroute(match: (route: NetworkRoute) => boolean, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'unroute', async (session) => session.network.removeRoutes(match));
  }

  /** The headers a request to `url` carries for the app's site, which a route's own `fetch` sends too. */
  siteHeaders(url: string): Readonly<Record<string, string>> | undefined {
    return this.settings?.siteHeaders(url);
  }

  /** Tracks one route handler so the attempt's end waits for it. */
  trackHandler(work: Promise<void>): void {
    this.requireSession().latch.track('route', work);
  }

  /** Fails the next step with `error`, a route handler's failure nobody awaited. */
  latchFailure(error: Error): void {
    this.requireSession().latch.latch(error);
  }

  waitForResponse(matches: (url: string) => boolean, operation: OperationContext): Promise<ObservedResponse> {
    return this.guard(operation, 'waitForResponse', (session, budget) => session.network.waitForResponse(matches, budget.signal));
  }

  /** Registers a dialog handler; returns its unsubscribe. */
  onDialog(handler: DialogHandler): () => void {
    return this.requireSession().dialogs.add(handler);
  }

  /**
   * Runs `trigger` and saves the first `count` downloads it starts into the
   * attempt's `downloads` folder, in start order. The trigger is test code,
   * so only cancellation bounds the wait around it.
   */
  async collectDownloads(count: number, trigger: () => Promise<void>, signal: AbortSignal): Promise<{ path: string; absolutePath: string; suggestedFilename: string }[]> {
    const session = this.requireSession();
    const finished = await session.downloads.collect(count, trigger, signal, (context) => session.owns(context));
    return finished.map((download) => {
      const { relative, absolute } = session.artifactPath('downloads', download.suggestedFilename, '');
      copyFileSync(download.filepath, absolute);
      return { path: relative, absolutePath: absolute, suggestedFilename: download.suggestedFilename };
    });
  }

  /**
   * Changes the attempt's media features from the next paint on. Firefox
   * implements `emulation.setMediaFeaturesOverride` from version 159
   * (https://bugzilla.mozilla.org/show_bug.cgi?id=2064354), so there it refuses.
   */
  emulateMedia(media: WebMedia, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'emulateMedia', async (session) => {
      if (this.options.browser !== 'chromium') {
        throw new EngineError('UNSUPPORTED_CAPABILITY', 'browser.emulateMedia needs emulation.setMediaFeaturesOverride, which Firefox implements from version 159; web({ colorScheme, reducedMotion }) applies on Firefox', {
          retryable: false,
        });
      }
      session.media = { ...session.media, ...media };
      await session.applyMedia();
    });
  }

  cookies(operation: OperationContext): Promise<Network.Cookie[]> {
    return this.guard(operation, 'cookies', async (session) => (await session.connection.send('storage.getCookies', { partition: session.partition() })).cookies);
  }

  setCookies(cookies: readonly Storage.PartialCookie[], operation: OperationContext): Promise<void> {
    return this.guard(operation, 'setCookies', async (session) => {
      for (const cookie of cookies) await session.connection.send('storage.setCookie', { cookie, partition: session.partition() });
    });
  }

  /** Deletes the cookies each filter selects; an empty filter selects every one. */
  deleteCookies(filters: readonly Storage.CookieFilter[], operation: OperationContext): Promise<void> {
    return this.guard(operation, 'clearCookies', async (session) => {
      for (const filter of filters) await session.connection.send('storage.deleteCookies', { filter, partition: session.partition() });
    });
  }

  setViewport(size: ViewportSize, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'setViewport', async (session) => {
      await session.connection.send('browsingContext.setViewport', { context: await session.ensureContext(), viewport: size });
    });
  }

  captureState(operation: OperationContext): Promise<EngineState> {
    return this.guard(operation, 'state capture', (session) => captureState(session));
  }

  restoreState(state: EngineState, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'state restore', (session) => restoreState(session, state));
  }

  screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    return this.guard(operation, 'screenshot', (session) => screenshot(session, label));
  }

  startVideo(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'video', (session) => startVideo(session));
  }

  stopVideo(operation: OperationContext): Promise<readonly VideoFile[]> {
    return this.guard(operation, 'video', (session) => stopVideo(session));
  }
}

/** Firefox preferences that set the configured media features for every page, since Firefox before 159 has no BiDi media override. */
function firefoxMediaPrefs(media: WebMedia): Record<string, number> {
  const prefs: Record<string, number> = {};
  if (media.colorScheme !== undefined) {
    prefs['layout.css.prefers-color-scheme.content-override'] = media.colorScheme === 'dark' ? 0 : media.colorScheme === 'light' ? 1 : 2;
  }
  if (media.reducedMotion !== undefined) prefs['ui.prefersReducedMotion'] = media.reducedMotion === 'reduce' ? 1 : 0;
  return prefs;
}
