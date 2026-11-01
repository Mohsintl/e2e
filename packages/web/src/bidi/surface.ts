/**
 * The WebDriver BiDi surface: one browser per worker, one user context per
 * attempt, and the browsing context every engine member drives. The same
 * engine contract as `PlaywrightSurface`, reading the page through the same
 * in-page semantic reader, so the two drivers differ only in transport and
 * input dispatch. Nested documents, the network, downloads, and video live in
 * the modules beside this one.
 */

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Emulation, Input, Network, Storage } from 'webdriver-bidi-protocol';
import {
  Deadline,
  EngineError,
  OBSERVED_NAME_LIMIT,
  OBSERVED_TEXT_LIMIT,
  obj,
  raceAbort,
  resolveExpression,
  TestError,
  withinCleanupBudget,
  type AppLogEntry,
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
  type ObservationPixels,
  type OperationContext,
  type PointerAction,
  type SemanticNode,
  type VideoFile,
  type ViewportPoint,
  type ViewportSize,
} from 'e2e/engine';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT, CLOSED_SHADOW_ROOTS_KEY } from '../closed-shadow.ts';
import { DialogRouter, type NativeDialog } from '../dialogs.ts';
import { focusTakesKeys } from '../focus.ts';
import type { ConfiguredInitScripts } from '../init-scripts.ts';
import { ensureBrowsersInstalled } from '../install.ts';
import { frameSelectors } from '../locators.ts';
import type { WebMedia } from '../media.ts';
import { assembleTree, isOnSiteFrame, ROOT_NODE_ID, toSemanticNode } from '../observation.ts';
import { readPngSize } from '../observe.ts';
import { withOperationDeadline } from '../operation-budget.ts';
import { httpCredentials, lowercaseNames, siteHeadersFor } from '../protected-app.ts';
import type { LeasedBrowsers } from '../provider.ts';
import { SECURE_FIELD_SELECTOR, type RawNodeData } from '../read-node.ts';
import { cancelled, ErrorLatch, invalidState, isClassified, message, nearestPixel, sanitizeFilename, swipeDistance, wheelDelta } from '../support.ts';
import type { WebBasicAuth, WebScreencastOptions } from '../surface.ts';
import { BidiError, type BidiConnection } from './connection.ts';
import { AttemptDownloads, type FinishedDownload } from './downloads.ts';
import { contentContext, FrameRegistry, inViewport, resolveFrames, withinFrame, type NodeTarget } from './frames.ts';
import { clickSources, dragSources, moveSources, pressSource, typeSource, wheelSources, type ClickOptions } from './input.ts';
import { connectBidiOverCdp, launchBidiBrowser, type BidiBrowser, type BidiBrowserName } from './launch.ts';
import { AttemptNetwork, type NetworkRoute, type ObservedResponse } from './network.ts';
import {
  ACTION_POINT,
  CHECK_STATE,
  DOM_READY,
  FILE_INPUT,
  FILL,
  FOCUS,
  FRAME_INSET,
  LOCATE_READ,
  MASK,
  NEXT_FRAME,
  READ_TREE,
  SELECT_OPTION,
  UNMASK,
  VIEWPORT_SIZE,
  type ActionPoint,
  type LocateMetadata,
  type TreeMetadata,
} from './page.ts';
import { callFunction, ScriptError, type CallOptions, type ElementRef, type PageArgument, type PageValue } from './script.ts';
import { BidiVideo } from './video.ts';

/** Browser launch budget when the harness init budget is not otherwise expressed. */
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;
/** Shared node budget of one observation, as the Playwright surface's. */
const MAX_OBSERVED_NODES = 3_000;
/** Nested iframe capture depth; deeper frames stay boundary nodes, as on the Playwright surface. */
const MAX_FRAME_DEPTH = 4;
/** Settling is best-effort and spends from the observation's budget. */
const SETTLE_TIMEOUT_MS = 5_000;
/** How long a long press holds the button when the action names no duration. */
const DEFAULT_LONG_PRESS_MS = 500;
/** Pause between actionability checks of an element that is not ready yet. */
const ACTIONABILITY_POLL_MS = 50;

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

/** One attempt's isolation: its user context, the tab it drives, and everything scoped to it. */
interface Attempt {
  userContext: string;
  context: string | undefined;
  preloads: string[];
  /** Init scripts the test added, preloaded again into a user context a reset or restore replaces. */
  readonly addedScripts: string[];
  readonly refs: BidiRefs;
  readonly frames: FrameRegistry;
  readonly network: AttemptNetwork;
  readonly downloads: AttemptDownloads;
  readonly dialogs: DialogRouter;
  readonly latch: ErrorLatch;
  /** The media features in effect, the configured ones updated by `browser.emulateMedia`. */
  media: WebMedia;
  /** Origins the configured permissions were granted on in this user context. */
  readonly granted: Set<string>;
  readonly artifactsDir: string;
  artifactCounter: number;
  readonly appLog: (entry: AppLogEntry) => void;
  readonly credentials: { readonly username: string; readonly password: string } | undefined;
  video: BidiVideo | undefined;
  /** Where the mouse last moved, which a viewport swipe wheels at. */
  pointer: ViewportPoint;
}

/**
 * The ids the surface minted and the element behind each, with the browsing
 * context that holds it. A BiDi shared id holds no handle: it names the
 * element for as long as it lives, so nothing here needs disposing.
 */
class BidiRefs {
  private counter = 0;
  private observation = new Map<string, NodeTarget>();
  private readonly located = new Map<string, NodeTarget>();

  /** Reserves ids before a document can stamp them. */
  reserveIds(count: number): number {
    const first = this.counter + 1;
    this.counter += count;
    return first;
  }

  /** Replaces the observation generation. */
  publish(generation: Map<string, NodeTarget>): void {
    this.observation = generation;
  }

  /** Keeps a located element under the id the read gave it. */
  storeLocated(id: string, target: NodeTarget): void {
    this.located.delete(id);
    this.located.set(id, target);
    for (const oldest of this.located.keys()) {
      if (this.located.size <= 2048) break;
      this.located.delete(oldest);
    }
  }

  lookup(ref: NodeRef): NodeTarget {
    const target = this.located.get(ref.id) ?? this.observation.get(ref.id);
    if (target === undefined) throw new EngineError('NODE_STALE', `node reference ${ref.id} is stale`, { retryable: true });
    return target;
  }

  clear(): void {
    this.observation = new Map();
    this.located.clear();
  }
}

/** One read document's tree with the element behind each of its ids. */
interface CapturedTree {
  readonly tree: SemanticNode;
  readonly generation: Map<string, NodeTarget>;
  readonly nodeCount: number;
  readonly truncated: boolean;
}

export class BidiSurface {
  private browser: BidiBrowser | undefined;
  private attempt: Attempt | undefined;
  private headed = false;
  private site: string | undefined;
  private projectRoot = '';
  private permissions: readonly string[] = [];
  /** The user context of every browsing context the session has seen, by context id. */
  private readonly contexts = new Map<string, string>();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly options: BidiSurfaceOptions) {}

  // --- lifecycle ---

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
    this.site = info.app.site;
    this.projectRoot = info.projectRoot;
    this.permissions = Object.keys(info.app.permissions ?? {});
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
    this.contexts.clear();
    this.listen(browser);
    await browser.connection.send('session.subscribe', {
      events: [
        'log.entryAdded',
        'network.responseCompleted',
        'network.fetchError',
        'browsingContext.contextCreated',
        'browsingContext.contextDestroyed',
        'browsingContext.userPromptOpened',
        'browsingContext.downloadWillBegin',
        'browsingContext.downloadEnd',
        // Subscribed, a file chooser opens no native picker; the driver answers it with `input.setFiles`.
        'input.fileDialogOpened',
      ],
    });
    return browser;
  }

  /** A local launch, or an attach over CDP to the `connect` endpoint or a provider's lease. */
  private async openBrowser(signal: AbortSignal): Promise<BidiBrowser> {
    const remote = this.options.cdpEndpoint ?? (this.options.leases === undefined ? undefined : (s: AbortSignal) => this.options.leases!.endpoint(s));
    if (remote !== undefined) return connectBidiOverCdp(await remote(signal), BROWSER_LAUNCH_TIMEOUT_MS);
    return launchBidiBrowser(this.options.browser, {
      headed: this.headed,
      timeoutMs: BROWSER_LAUNCH_TIMEOUT_MS,
      firefoxPrefs: firefoxMediaPrefs(this.options.media),
    });
  }

  /** Whether `context` belongs to the running attempt's user context. */
  private ours(context: string | null | undefined): boolean {
    return context != null && this.attempt !== undefined && this.contexts.get(context) === this.attempt.userContext;
  }

  /** Routes the session's events to the attempt: its app log, its dialogs, and the contexts it owns. */
  private listen(browser: BidiBrowser): void {
    for (const off of this.unsubscribe.splice(0)) off();
    const connection = browser.connection;
    const report = (entry: AppLogEntry): void => {
      try {
        this.attempt?.appLog(entry);
      } catch {
        // The harness's sink never fails a page event.
      }
    };
    this.unsubscribe.push(
      connection.on('browsingContext.contextCreated', (info) => {
        if (info.userContext !== undefined) this.contexts.set(info.context, info.userContext);
        else if (info.parent != null) this.contexts.set(info.context, this.contexts.get(info.parent) ?? '');
      }),
      connection.on('browsingContext.contextDestroyed', (info) => this.contexts.delete(info.context)),
      connection.on('browsingContext.userPromptOpened', (prompt) => this.onPrompt(connection, prompt)),
      connection.on('log.entryAdded', (entry) => {
        if (!this.ours(entry.source.context) || entry.text === null) return;
        if (entry.type === 'javascript') report({ source: 'error', level: 'error', text: entry.text });
        else if (entry.level !== 'debug' && !entry.text.startsWith('Failed to load resource:')) {
          report({ source: 'console', level: entry.level === 'warn' ? 'warning' : entry.level, text: entry.text });
        }
      }),
      connection.on('network.responseCompleted', (event) => {
        const { status, statusText } = event.response;
        if (!this.ours(event.context) || status < 400) return;
        // A browser's own request for a site icon the app never served is noise, as the Playwright app log treats it.
        if (status === 404 && URL.canParse(event.request.url) && new URL(event.request.url).pathname === '/favicon.ico') return;
        const line = `${event.request.method} ${event.request.url} ${status}${statusText === '' ? '' : ` ${statusText}`}`;
        report({ source: 'network', level: status >= 500 ? 'error' : 'warning', text: line });
      }),
      connection.on('network.fetchError', (event) => {
        if (!this.ours(event.context) || event.errorText === 'NS_BINDING_ABORTED' || event.errorText === 'net::ERR_ABORTED') return;
        report({ source: 'network', level: 'error', text: `${event.request.method} ${event.request.url} ${event.errorText}` });
      }),
    );
  }

  /** Hands a user prompt to the attempt's dialog router; one outside any attempt is dismissed. */
  private onPrompt(connection: BidiConnection, prompt: { context: string; message: string; type: string }): void {
    const answer = (accept: boolean, userText?: string): Promise<void> =>
      connection
        .send('browsingContext.handleUserPrompt', { context: prompt.context, accept, ...(userText === undefined ? {} : { userText }) })
        .then(() => undefined);
    if (!this.ours(prompt.context) || this.attempt === undefined) {
      void answer(false).catch(() => undefined);
      return;
    }
    const dialog: NativeDialog = {
      type: () => prompt.type,
      message: () => prompt.message,
      accept: (text) => answer(true, text),
      dismiss: () => answer(false),
    };
    void this.attempt.dialogs.dispatch(dialog);
  }

  /** Opens the attempt's user context, its network, downloads, and emulation. */
  async startAttempt(context: EngineAttemptContext): Promise<void> {
    if (this.attempt !== undefined) throw invalidState('an attempt is already running');
    const basicAuth = this.options.basicAuth;
    const credentials = basicAuth === undefined
      ? undefined
      : await raceAbort(() => httpCredentials(basicAuth, context.resolveSecret), context.signal, 'resolving the basic-auth password');
    const browser = await this.acquireBrowser(context.signal);
    const connection = browser.connection;
    const latch = new ErrorLatch();
    const headers = this.options.headers === undefined ? undefined : lowercaseNames(this.options.headers);
    const attempt: Attempt = {
      userContext: '',
      context: undefined,
      preloads: [],
      addedScripts: [],
      refs: new BidiRefs(),
      frames: new FrameRegistry(),
      network: new AttemptNetwork(connection, () => attempt.userContext, {
        siteHeaders: (url) => siteHeadersFor(url, this.site, headers),
        credentials,
        ours: (event) => this.ours(event.context),
      }),
      downloads: new AttemptDownloads(connection),
      dialogs: new DialogRouter(latch),
      latch,
      media: this.options.media,
      granted: new Set(),
      artifactsDir: context.artifactsDir,
      artifactCounter: 0,
      appLog: context.appLog,
      credentials,
      video: undefined,
      pointer: { x: 0, y: 0 },
    };
    this.attempt = attempt;
    await this.openUserContext(attempt);
    context.environment({ browser: `${browser.name} ${browser.version}`, driver: 'webdriver-bidi' });
  }

  /**
   * Creates the attempt's user context and applies everything scoped to it:
   * the preloaded scripts, downloads, the emulated user agent, locale, time
   * zone, and media, and the network the headers and credentials need.
   */
  private async openUserContext(attempt: Attempt): Promise<void> {
    const connection = this.requireBrowser().connection;
    const { userContext } = await connection.send('browser.createUserContext', {});
    attempt.userContext = userContext;
    attempt.granted.clear();
    const scoped = { userContexts: [userContext] as [string] };
    const sources = [CLOSED_SHADOW_ROOTS_INIT_SCRIPT, ...this.options.initScripts.forAttempt(), ...attempt.addedScripts];
    const { userAgent, locale, timezoneId } = this.options;
    const [preloads] = await Promise.all([
      Promise.all(sources.map(async (source) => (await connection.send('script.addPreloadScript', { functionDeclaration: wrapScript(source), ...scoped })).script)),
      attempt.downloads.allow(userContext),
      userAgent === undefined ? undefined : connection.send('emulation.setUserAgentOverride', { userAgent, ...scoped }),
      locale === undefined ? undefined : connection.send('emulation.setLocaleOverride', { locale, ...scoped }),
      // Playwright's `locale` also sets the language the browser asks servers for.
      locale === undefined ? undefined : connection.send('network.setExtraHeaders', { headers: [{ name: 'accept-language', value: { type: 'string', value: locale } }], ...scoped }),
      timezoneId === undefined ? undefined : connection.send('emulation.setTimezoneOverride', { timezone: timezoneId, ...scoped }),
      this.applyMedia(attempt),
      attempt.network.start(this.options.headers !== undefined || attempt.credentials !== undefined),
    ]);
    attempt.preloads = preloads;
  }

  /**
   * Applies the attempt's media features: on Chromium through
   * `emulation.setMediaFeaturesOverride`. Firefox does not implement that
   * command; its configured features are launch preferences instead.
   */
  private async applyMedia(attempt: Attempt): Promise<void> {
    if (this.options.browser !== 'chromium' || (attempt.media.colorScheme === undefined && attempt.media.reducedMotion === undefined)) return;
    const features: Emulation.MediaFeatures = obj({
      'prefers-color-scheme': attempt.media.colorScheme === 'no-preference' ? null : attempt.media.colorScheme,
      'prefers-reduced-motion': attempt.media.reducedMotion,
    });
    await this.requireBrowser().connection.send('emulation.setMediaFeaturesOverride', { features, userContexts: [attempt.userContext] });
  }

  /** Waits for a dialog or route handler still running, then rethrows what it latched. */
  settleAttempt(context: EngineCleanupContext): Promise<void> {
    return this.attempt?.latch.settle(context) ?? Promise.resolve();
  }

  /** Removes the attempt's user context, which closes its tabs, and its network. Idempotent. */
  async endAttempt(context: EngineCleanupContext): Promise<void> {
    const attempt = this.attempt;
    this.attempt = undefined;
    if (attempt === undefined) return;
    attempt.downloads.dispose();
    if (this.browser === undefined || this.browser.connection.isClosed) return;
    await withinCleanupBudget(
      (async () => {
        await attempt.video?.stop().catch(() => undefined);
        await this.dropUserContext(attempt);
        await attempt.network.dispose();
      })(),
      context,
    ).catch(() => undefined);
  }

  private async dropUserContext(attempt: Attempt): Promise<void> {
    const connection = this.requireBrowser().connection;
    // Scripts go after their tabs: removing one from a live tab races the tab's close inside the Chromium mapper.
    await connection.send('browser.removeUserContext', { userContext: attempt.userContext });
    await Promise.all(attempt.preloads.map((script) => connection.send('script.removePreloadScript', { script }).catch(() => undefined)));
    attempt.frames.clear();
  }

  /** Ends the attempt, closes the browser, and releases a provider's lease. */
  async dispose(context: EngineCleanupContext): Promise<void> {
    await this.endAttempt(context);
    const browser = this.browser;
    this.browser = undefined;
    for (const off of this.unsubscribe.splice(0)) off();
    if (browser !== undefined) await withinCleanupBudget(browser.close(), context);
    await this.options.leases?.dispose(context);
  }

  // --- plumbing ---

  private requireBrowser(): BidiBrowser {
    if (this.browser === undefined) throw invalidState('the browser is not running');
    return this.browser;
  }

  private requireAttempt(): Attempt {
    if (this.attempt === undefined) throw invalidState('no attempt is running');
    return this.attempt;
  }

  /** The attempt's tab; throws before the first `open`. */
  private requireContext(): string {
    const context = this.requireAttempt().context;
    if (context === undefined) throw invalidState('no page is open yet: open the app first');
    return context;
  }

  /** Creates the attempt's tab on first use, at the configured viewport, and starts its video segment when recording. */
  private async ensureContext(): Promise<string> {
    const attempt = this.requireAttempt();
    if (attempt.context !== undefined) return attempt.context;
    const connection = this.requireBrowser().connection;
    const { context } = await connection.send('browsingContext.create', {
      // Playwright's Firefox build never answers a tab created in a new user context; a window works in every build.
      type: this.options.browser === 'firefox' ? 'window' : 'tab',
      userContext: attempt.userContext,
    });
    this.contexts.set(context, attempt.userContext);
    if (this.options.viewport !== null) {
      await connection.send('browsingContext.setViewport', { context, viewport: this.options.viewport });
    }
    attempt.context = context;
    attempt.pointer = { x: 0, y: 0 };
    await attempt.video?.contextOpened(context, await this.viewportSize());
    return context;
  }

  private call(declaration: string, args: readonly PageArgument[] = [], options?: CallOptions, context?: string): Promise<PageValue> {
    return callFunction(this.requireBrowser().connection, context ?? this.requireContext(), declaration, args, options);
  }

  /** `call` for a page function of this module whose return shape the caller names; the page is not checked against it. */
  private async read<T>(declaration: string, args: readonly PageArgument[] = [], options?: CallOptions, context?: string): Promise<T> {
    return (await this.call(declaration, args, options, context)) as T;
  }

  /** Runs input sources on the attempt's tab, then releases what they hold; the attempt remembers where the mouse ended. */
  private async sendInput(actions: Input.SourceActions[]): Promise<void> {
    const connection = this.requireBrowser().connection;
    const context = this.requireContext();
    await connection.send('input.performActions', { context, actions });
    await connection.send('input.releaseActions', { context });
    this.trackPointer(actions);
  }

  /** Where the mouse last moved in the attempt's tab. */
  pointerPosition(): ViewportPoint {
    return this.requireAttempt().pointer;
  }

  private trackPointer(actions: readonly Input.SourceActions[]): void {
    const attempt = this.attempt;
    if (attempt === undefined) return;
    for (const source of actions) {
      if (source.type !== 'pointer') continue;
      const last = source.actions.findLast((action) => action.type === 'pointerMove');
      if (last?.type === 'pointerMove') attempt.pointer = { x: last.x, y: last.y };
    }
  }

  /** Bounds one operation by its budget, fails it with an error a handler latched, and classifies what it threw. */
  private async guard<T>(
    operation: OperationContext,
    label: string,
    work: (budget: { readonly signal: AbortSignal; readonly timeoutMs: number }) => Promise<T>,
  ): Promise<T> {
    this.attempt?.latch.throwPending();
    try {
      return await withOperationDeadline(operation, label, (remaining) => work(remaining()));
    } catch (cause) {
      throw classify(cause, label);
    }
  }

  /** Grants the configured permissions on `url`'s origin, once per origin and user context: BiDi grants per origin. */
  private async grantPermissions(url: string): Promise<void> {
    const attempt = this.requireAttempt();
    if (this.permissions.length === 0 || !URL.canParse(url)) return;
    const { origin } = new URL(url);
    if (origin === 'null' || attempt.granted.has(origin)) return;
    attempt.granted.add(origin);
    const connection = this.requireBrowser().connection;
    await Promise.all(this.permissions.map((name) =>
      connection.send('permissions.setPermission', { descriptor: { name }, state: 'granted', origin, userContext: attempt.userContext })));
  }

  // --- steering ---

  /** Opens one URL in the attempt's tab and waits for its load event. */
  open(url: string, operation: OperationContext): Promise<void> {
    return this.goto(url, 'load', operation);
  }

  /** Goes back once in the tab's history and waits for the load. */
  back(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', (budget) => this.traverse(-1, budget.timeoutMs));
  }

  /**
   * Moves `delta` entries through the tab's history and waits until the
   * document it lands on has loaded: a `browsingContext.load` event for the
   * tab, or a new URL whose document reads complete, which a page restored
   * from the back-forward cache shows without a load event.
   */
  private async traverse(delta: number, timeoutMs: number): Promise<void> {
    const connection = this.requireBrowser().connection;
    const context = this.requireContext();
    const deadline = new Deadline(timeoutMs);
    const before = await this.currentUrl();
    let loaded = false;
    const off = connection.on('browsingContext.load', (event) => {
      if (event.context === context) loaded = true;
    });
    const { subscription } = await connection.send('session.subscribe', { events: ['browsingContext.load'], contexts: [context] });
    try {
      await connection.send('browsingContext.traverseHistory', { context, delta });
      for (;;) {
        if (loaded) return;
        const settled = await this.call("() => document.readyState === 'complete' ? location.href : null").catch(() => null);
        if (typeof settled === 'string' && settled !== before) return;
        if (deadline.expired()) throw new EngineError('OPERATION_TIMEOUT', 'history navigation did not load in time', { retryable: false });
        await sleep(ACTIONABILITY_POLL_MS);
      }
    } finally {
      off();
      await connection.send('session.unsubscribe', { subscriptions: [subscription] }).catch(() => undefined);
    }
  }

  /** Closes the tab, keeping the user context's storage; the harness reopens the app. */
  restart(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'restart', async () => {
      const attempt = this.requireAttempt();
      const context = attempt.context;
      await attempt.video?.contextClosing();
      attempt.context = undefined;
      attempt.refs.clear();
      attempt.frames.clear();
      if (context !== undefined) await this.requireBrowser().connection.send('browsingContext.close', { context });
    });
  }

  /** Replaces the user context with a clean one and opens its blank tab. */
  reset(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'state reset', async () => {
      const attempt = this.requireAttempt();
      await attempt.video?.contextClosing();
      await this.dropUserContext(attempt);
      attempt.context = undefined;
      attempt.refs.clear();
      await this.openUserContext(attempt);
      await this.ensureContext();
    });
  }

  // --- observation and location ---

  /** One semantic observation, child documents on the app's site stitched in, with masked pixels when asked. */
  observe(operation: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot> {
    return this.guard(operation, 'observe', async (budget) => {
      const attempt = this.requireAttempt();
      const context = this.requireContext();
      const deadline = Date.now() + budget.timeoutMs;
      const settle = Math.min(SETTLE_TIMEOUT_MS, budget.timeoutMs / 2);
      await this.call(DOM_READY, [settle], { awaitPromise: true }).catch(() => undefined);
      const viewport = await this.viewportSize();
      const [captured, pixels] = await Promise.all([
        this.captureTree(attempt, context, [], MAX_OBSERVED_NODES, deadline),
        options?.pixels === true ? this.capturePixels(viewport).catch(() => undefined) : undefined,
      ]);
      if (budget.signal.aborted) throw cancelled('observe cancelled');
      attempt.refs.publish(captured.generation);
      return {
        location: await this.currentUrl(),
        root: captured.tree,
        viewport,
        ...(captured.truncated ? { truncated: true } : {}),
        ...(pixels === undefined ? {} : { pixels: pixels.pixels, maskedRegionCount: pixels.maskedRegionCount }),
      };
    });
  }

  /**
   * Resolves one expression with the contract's reference semantics
   * (`resolveExpression`) over node-mode reads of the elements the
   * expression's queries could match, in the document its frame chain names;
   * a `selector` is answered by `browsingContext.locateNodes`.
   */
  locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    return this.guard(operation, 'locate', async () => {
      const attempt = this.requireAttempt();
      const connection = this.requireBrowser().connection;
      const chain = frameSelectors(expression);
      const context = await resolveFrames(connection, this.requireContext(), chain, attempt.frames);
      const inner = chain.length === 0 ? expression : withinFrame(expression);
      const frameBox = chain.length === 0 ? undefined : await attempt.frames.viewportBox(connection, context);
      const selected = await this.locateSelectors(inner, context);
      const options = { testIdAttribute: this.options.testIdAttribute, secureFieldSelector: SECURE_FIELD_SELECTOR };
      const [json, elements] = await this.read<[string, ElementRef[]]>(LOCATE_READ, [options, wantedQueries(inner), CLOSED_SHADOW_ROOTS_KEY], undefined, context);
      // oxlint-disable-next-line e2e/no-unchecked-json -- page-reported reads; the alignment below is checked
      const { nodes, parents } = JSON.parse(json) as LocateMetadata;
      if (nodes.length !== elements.length || parents.length !== nodes.length) {
        throw new EngineError('ENGINE_FAILURE', 'located reads do not align with their elements', { retryable: false });
      }
      const first = attempt.refs.reserveIds(nodes.length);
      const ids = nodes.map((_node, index) => `n${first + index}`);
      const sharedIds = new Map(ids.map((id, index) => [id, elements[index]!.sharedId]));
      const roots = buildForest(nodes, parents, ids);
      const matches = resolveExpression(inner, roots, {
        selector: (selector, candidates) => {
          const hits = selected.get(selector) ?? new Set<string>();
          return candidates.filter((node) => hits.has(sharedIds.get(node.ref.id) ?? ''));
        },
      });
      return matches.map((node) => {
        attempt.refs.storeLocated(node.ref.id, { element: { sharedId: sharedIds.get(node.ref.id) ?? '' }, context });
        const { children: _children, ...rest } = node;
        return inViewport(rest, frameBox, chain);
      });
    });
  }

  /** The shared ids every `selector` in the expression matches in `context`, read before the elements so one pass answers them all. */
  private async locateSelectors(expression: LocatorExpression, context: string): Promise<Map<string, Set<string>>> {
    const selectors = new Set<string>();
    const walk = (node: LocatorExpression): void => {
      switch (node.kind) {
        case 'selector':
          selectors.add(node.selector);
          return;
        case 'query':
          if (node.scope !== undefined) walk(node.scope);
          return;
        case 'filter':
          walk(node.source);
          if (node.has !== undefined) walk(node.has);
          if (node.hasNot !== undefined) walk(node.hasNot);
          return;
        case 'index':
        case 'frame':
          walk(node.source);
          return;
        case 'union':
          walk(node.left);
          walk(node.right);
      }
    };
    walk(expression);
    const out = new Map<string, Set<string>>();
    const connection = this.requireBrowser().connection;
    for (const selector of selectors) {
      const xpath = selector.startsWith('xpath=') ? selector.slice('xpath='.length) : selector.startsWith('/') ? selector : undefined;
      const css = selector.startsWith('css=') ? selector.slice('css='.length) : selector;
      const { nodes } = await connection
        .send('browsingContext.locateNodes', {
          context,
          locator: xpath === undefined ? { type: 'css', value: css } : { type: 'xpath', value: xpath },
        })
        .catch((cause: unknown) => {
          throw new TestError('INVALID_LOCATOR', `selector ${selector} is not a CSS or XPath selector: ${message(cause)}`);
        });
      out.set(selector, new Set(nodes.flatMap((node) => (node.sharedId === undefined ? [] : [node.sharedId]))));
    }
    return out;
  }

  /**
   * Reads one document's tree in one call (the reader's metadata as one JSON
   * string, each walked element as its shared id), then each iframe on the
   * app's site, stitched under its boundary node within the node budget and
   * the observation's deadline. An on-site frame that could not be read
   * marks the tree truncated; an off-site one stays a boundary node by
   * design.
   */
  private async captureTree(attempt: Attempt, context: string, framePath: readonly string[], budget: number, deadline: number): Promise<CapturedTree> {
    const readTree = (structured: boolean): Promise<[TreeMetadata | string | null, ElementRef[]]> => {
      const options = {
        testIdAttribute: this.options.testIdAttribute,
        secureFieldSelector: SECURE_FIELD_SELECTOR,
        mode: { kind: 'tree', maxNodes: budget, idSeed: attempt.refs.reserveIds(budget), nameLimit: OBSERVED_NAME_LIMIT, textLimit: OBSERVED_TEXT_LIMIT },
      };
      return this.read(READ_TREE, [options, structured], structured ? { maxObjectDepth: null } : undefined, context);
    };
    let [metadata, elements] = await readTree(false);
    if (metadata === null) [metadata, elements] = await readTree(true);
    // oxlint-disable-next-line e2e/no-unchecked-json -- page-reported metadata; the ids and nodes alignment below is checked
    const decoded = typeof metadata === 'string' ? (JSON.parse(metadata) as TreeMetadata) : (metadata as TreeMetadata);
    const { nodes, ids } = decoded;
    if (!Array.isArray(ids) || ids.length !== nodes.length || elements.length !== nodes.length) {
      throw new EngineError('ENGINE_FAILURE', 'observation ids do not align with its nodes', { retryable: false });
    }
    if (nodes.length === 0) throw new EngineError('NODE_STALE', 'observation produced no nodes', { retryable: true });
    if (framePath.length === 0) ids[0] = ROOT_NODE_ID;
    const generation = new Map<string, NodeTarget>();
    elements.forEach((element, index) => generation.set(ids[index] as string, { element, context }));
    let nodeCount = nodes.length;
    let truncated = decoded.truncated;
    const frameChildren = new Map<number, { tree: SemanticNode; inset: NonNullable<SemanticNode['rect']> }>();
    const connection = this.requireBrowser().connection;
    for (let index = 0; index < nodes.length; index += 1) {
      const selector = nodes[index]!.frameSelector;
      if (selector === undefined) continue;
      const frame: NodeTarget = { element: elements[index]!, context };
      const child = await contentContext(connection, frame).catch(() => undefined);
      if (child === undefined) continue;
      const url = (await connection.send('browsingContext.getTree', { root: child, maxDepth: 0 }).catch(() => undefined))?.contexts[0]?.url ?? '';
      if (!isOnSiteFrame(url, this.site)) continue;
      const remaining = budget - nodeCount;
      const rect = nodes[index]!.rect;
      if (framePath.length >= MAX_FRAME_DEPTH || remaining <= 0 || Date.now() >= deadline || rect === null) {
        truncated = true;
        continue;
      }
      attempt.frames.enter(child, frame);
      const read = await (async () => {
        const inset = await this.read<NonNullable<SemanticNode['rect']>>(FRAME_INSET, [frame.element], undefined, context);
        return { inset, captured: await this.captureTree(attempt, child, [...framePath, selector], remaining, deadline) };
      })().catch(() => undefined);
      if (read === undefined) {
        truncated = true;
        continue;
      }
      for (const [id, target] of read.captured.generation) generation.set(id, target);
      frameChildren.set(index, { tree: read.captured.tree, inset: read.inset });
      nodeCount += read.captured.nodeCount;
      truncated ||= read.captured.truncated;
    }
    return { tree: assembleTree(nodes, ids, framePath, frameChildren), generation, nodeCount, truncated };
  }

  private async viewportSize(): Promise<ViewportSize> {
    if (this.options.viewport !== null) return this.options.viewport;
    return this.read<ViewportSize>(VIEWPORT_SIZE);
  }

  private async currentUrl(): Promise<string> {
    const { contexts } = await this.requireBrowser().connection.send('browsingContext.getTree', { root: this.requireContext(), maxDepth: 0 });
    return contexts[0]?.url ?? '';
  }

  /** A viewport screenshot with every secure field in every document covered and the caret hidden. */
  private async capturePixels(viewport: ViewportSize): Promise<{ pixels: ObservationPixels; maskedRegionCount: number }> {
    const connection = this.requireBrowser().connection;
    const context = this.requireContext();
    const documents = await this.documentContexts(context);
    const counts = await Promise.all(documents.map((each) =>
      this.read<number>(MASK, [SECURE_FIELD_SELECTOR, CLOSED_SHADOW_ROOTS_KEY], undefined, each).catch(() => 0)));
    try {
      const { data } = await connection.send('browsingContext.captureScreenshot', {
        context,
        origin: 'viewport',
        format: { type: 'image/png' },
      });
      const bytes = new Uint8Array(Buffer.from(data, 'base64'));
      const size = readPngSize(bytes) ?? viewport;
      return {
        pixels: {
          data: bytes,
          mediaType: 'image/png',
          width: size.width,
          height: size.height,
          scale: viewport.width > 0 ? size.width / viewport.width : 1,
        },
        maskedRegionCount: counts.reduce((total, count) => total + count, 0),
      };
    } finally {
      await Promise.all(documents.map((each) => this.call(UNMASK, [], undefined, each).catch(() => undefined)));
    }
  }

  /** `context` and every frame document under it. */
  private async documentContexts(context: string): Promise<string[]> {
    const { contexts } = await this.requireBrowser().connection.send('browsingContext.getTree', { root: context });
    const out: string[] = [];
    const walk = (info: { context: string; children: readonly { context: string; children: unknown }[] | null }): void => {
      out.push(info.context);
      for (const child of info.children ?? []) walk(child as typeof info);
    };
    for (const info of contexts) walk(info);
    return out;
  }

  // --- actions ---

  /** One action on a located or observed node; a `swipe` on the root is the viewport swipe. */
  perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    return this.guard(operation, action.kind, async (budget) => {
      const attempt = this.requireAttempt();
      if (action.kind === 'swipe' && ref.id === ROOT_NODE_ID) {
        // At the pointer's last position, as Playwright's `mouse.wheel` does: the centre can sit over a scrollable pane.
        await this.wheel(attempt.pointer, await this.viewportSize(), action.direction, action.momentum ?? 'none');
        return;
      }
      const target = attempt.refs.lookup(ref);
      const deadline = new Deadline(budget.timeoutMs);
      await this.dispatch(target, action, deadline, attempt);
    });
  }

  private async dispatch(target: NodeTarget, action: LocatorAction, deadline: Deadline, attempt: Attempt): Promise<void> {
    const { element, context } = target;
    switch (action.kind) {
      case 'tap':
        return this.click(target, deadline, action.modifiers === undefined ? {} : { modifiers: action.modifiers });
      case 'doubleTap':
        return this.click(target, deadline, { clicks: 2, ...(action.modifiers === undefined ? {} : { modifiers: action.modifiers }) });
      case 'secondaryTap':
        return this.click(target, deadline, { button: 2, ...(action.modifiers === undefined ? {} : { modifiers: action.modifiers }) });
      case 'longPress':
        return this.click(target, deadline, { holdMs: action.durationMs ?? DEFAULT_LONG_PRESS_MS });
      case 'hover': {
        const point = await this.actionPoint(target, deadline, false);
        await this.sendInput(moveSources(point.x, point.y));
        return;
      }
      case 'fill':
        return this.fill(target, action.value);
      case 'clear':
        return this.fill(target, '');
      case 'press':
        await this.call(FOCUS, [element], undefined, context);
        await this.sendInput([pressSource(action.key)]);
        return;
      case 'focus':
        await this.call(FOCUS, [element], undefined, context);
        return;
      case 'scrollIntoView':
        await this.actionPoint(target, deadline, false, false);
        return;
      case 'check':
      case 'uncheck':
        return this.setChecked(target, action.kind === 'check', deadline);
      case 'selectOption': {
        const value = action.value;
        const by = typeof value === 'string' ? { label: value } : value;
        const problem = await this.call(SELECT_OPTION, [element, by as PageArgument], undefined, context);
        if (typeof problem === 'string') throw new EngineError('NOT_ACTIONABLE', `selectOption: ${problem}`, { retryable: false });
        return;
      }
      case 'setInputFiles':
        return this.setInputFiles(target, action.paths, deadline);
      case 'dragTo': {
        const from = await this.actionPoint(target, deadline, true);
        const to = await this.actionPoint(attempt.refs.lookup(action.target), deadline, false);
        await this.sendInput(dragSources(from, to));
        return;
      }
      case 'swipe': {
        const point = await this.actionPoint(target, deadline, false);
        const viewport = await this.viewportSize();
        const box = await this.read<ViewportSize>('(element) => { const r = element.getBoundingClientRect(); return { width: r.width, height: r.height }; }', [element], undefined, context);
        await this.wheel(point, box.width > 0 ? box : viewport, action.direction, action.momentum ?? 'none');
        return;
      }
    }
  }

  /** Waits until the element can take a pointer action, then clicks its centre. */
  private async click(target: NodeTarget, deadline: Deadline, options: ClickOptions): Promise<void> {
    const point = await this.actionPoint(target, deadline, true);
    await this.sendInput(clickSources(point.x, point.y, options));
  }

  /**
   * Polls the element's actionability until it is ready or the deadline
   * passes, and returns its centre in the top-level viewport: each frame
   * holding it is scrolled into view first, and the point is shifted by the
   * frames' boxes.
   */
  private async actionPoint(target: NodeTarget, deadline: Deadline, enabled: boolean, hitTest = true): Promise<{ x: number; y: number }> {
    const attempt = this.requireAttempt();
    for (const frame of attempt.frames.chain(target.context)) {
      await this.call(ACTION_POINT, [frame.element, false, false], { awaitPromise: true }, frame.context);
    }
    let last: ActionPoint;
    for (;;) {
      last = await this.read<ActionPoint>(ACTION_POINT, [target.element, enabled, hitTest], { awaitPromise: true }, target.context);
      if (last.state === 'ok') break;
      if (last.state === 'detached') throw new EngineError('NODE_STALE', 'element is not attached to the DOM', { retryable: true });
      if (deadline.remaining() <= ACTIONABILITY_POLL_MS) {
        const reason = last.state === 'blocked' ? last.blocker : `element is ${last.state === 'moving' ? 'not stable' : `not ${last.state === 'hidden' ? 'visible' : 'enabled'}`}`;
        throw new EngineError('NOT_ACTIONABLE', `element did not become actionable in time: ${reason}`, { retryable: false });
      }
      await sleep(ACTIONABILITY_POLL_MS);
    }
    const box = await attempt.frames.viewportBox(this.requireBrowser().connection, target.context);
    if (box === null) throw new EngineError('NOT_ACTIONABLE', 'element is in a frame that lays out no box', { retryable: false });
    return box === undefined ? { x: last.x, y: last.y } : { x: Math.round(box.x + last.x), y: Math.round(box.y + last.y) };
  }

  /** Replaces the field's content with `value` in one edit, as a paste would; see `FILL`. */
  private async fill(target: NodeTarget, value: string): Promise<void> {
    const problem = await this.call(FILL, [target.element, value], undefined, target.context);
    if (typeof problem === 'string') throw new EngineError('NOT_ACTIONABLE', problem, { retryable: false });
  }

  /** Clicks a checkable once when its state differs, then polls until it reads `checked`. */
  private async setChecked(target: NodeTarget, checked: boolean, deadline: Deadline): Promise<void> {
    const read = (): Promise<{ checked: boolean | null; radio: boolean }> => this.read(CHECK_STATE, [target.element], undefined, target.context);
    const before = await read();
    if (before.checked === null) throw new EngineError('NOT_ACTIONABLE', 'element is not a checkbox or radio button', { retryable: false });
    if (before.checked === checked) return;
    if (!checked && before.radio) {
      throw new EngineError('NOT_ACTIONABLE', 'uncheck cannot clear a radio button; select another radio in its group', { retryable: false });
    }
    await this.click(target, deadline, {});
    for (;;) {
      // A control gone after the click took it: the app replaced it on change.
      const after = await read().catch((cause: unknown) => {
        const error = classify(cause, 'check');
        if (error instanceof EngineError && error.code === 'NODE_STALE') return undefined;
        throw error;
      });
      if (after === undefined || after.checked === checked) return;
      if (deadline.remaining() <= ACTIONABILITY_POLL_MS) {
        throw new EngineError('NOT_ACTIONABLE', `${checked ? 'check' : 'uncheck'} clicked the control but its checked state did not change`, { retryable: false });
      }
      await sleep(ACTIONABILITY_POLL_MS);
    }
  }

  /**
   * Attaches files to a file input or one a `<label>` names directly; any
   * other control is clicked with the file chooser awaited
   * (`input.fileDialogOpened`), and the input that chooser serves takes the
   * files. A control that opens no chooser by the deadline fails, as
   * Playwright's upload does.
   */
  private async setInputFiles(target: NodeTarget, paths: readonly string[], deadline: Deadline): Promise<void> {
    const connection = this.requireBrowser().connection;
    const files = paths.map((file) => path.resolve(this.projectRoot, file));
    const input = await this.call(FILE_INPUT, [target.element], undefined, target.context);
    if (input !== null && typeof input === 'object' && 'sharedId' in input && typeof input.sharedId === 'string') {
      await connection.send('input.setFiles', { context: target.context, element: { sharedId: input.sharedId }, files });
      return;
    }
    let off: () => void = () => undefined;
    const opened = new Promise<{ context: string; element?: { sharedId: string } }>((resolve) => {
      off = connection.on('input.fileDialogOpened', (info) => {
        if (this.ours(info.context)) resolve(info);
      });
    });
    try {
      await this.click(target, deadline, {});
      const timeout = sleep(Math.max(1, deadline.remaining()), undefined, { ref: false });
      const chooser = await Promise.race([opened, timeout]);
      if (chooser?.element === undefined) {
        throw new EngineError('NOT_ACTIONABLE', 'upload clicked the control but it opened no file chooser', { retryable: false });
      }
      await connection.send('input.setFiles', { context: chooser.context, element: { sharedId: chooser.element.sharedId }, files });
    } finally {
      off();
    }
  }

  /** Wheels at a viewport point by a swipe of `extent`'s size, then waits for the frame that renders it. */
  private async wheel(
    at: ViewportPoint,
    extent: ViewportSize,
    direction: Parameters<typeof wheelDelta>[0],
    momentum: Parameters<typeof swipeDistance>[1],
  ): Promise<void> {
    const distance = swipeDistance(direction === 'up' || direction === 'down' ? extent.height : extent.width, momentum);
    const [deltaX, deltaY] = wheelDelta(direction, distance);
    const point = nearestPixel(at);
    await this.sendInput(wheelSources(point.x, point.y, deltaX, deltaY));
    await this.call(NEXT_FRAME, [], { awaitPromise: true });
  }

  /** One pointer action at a viewport point with nothing resolved behind it. */
  performAt(point: ViewportPoint, action: PointerAction, operation: OperationContext): Promise<void> {
    return this.guard(operation, `${action.kind} at point`, async () => {
      const at = nearestPixel(point);
      switch (action.kind) {
        case 'tap':
          return this.sendInput(clickSources(at.x, at.y));
        case 'doubleTap':
          return this.sendInput(clickSources(at.x, at.y, { clicks: 2 }));
        case 'secondaryTap':
          return this.sendInput(clickSources(at.x, at.y, { button: 2 }));
        case 'longPress':
          return this.sendInput(clickSources(at.x, at.y, { holdMs: action.durationMs ?? DEFAULT_LONG_PRESS_MS }));
        case 'hover':
          return this.sendInput(moveSources(at.x, at.y));
        case 'dragTo':
          return this.sendInput(dragSources(at, nearestPixel(action.target)));
        case 'swipeTo':
          return this.sendInput(dragSources(at, nearestPixel(action.target), action.durationMs));
        case 'swipe':
          return this.wheel(at, await this.viewportSize(), action.direction, action.momentum ?? 'none');
      }
    });
  }

  /** Types into whatever holds focus, in any document of the tab, refusing when nothing there takes keystrokes. */
  typeText(text: string, options: { readonly replace: boolean }, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'keyboard.type', async () => {
      const documents = await this.documentContexts(this.requireContext());
      const editable = await Promise.all(documents.map((context) =>
        this.call(focusTakesKeys.toString(), [CLOSED_SHADOW_ROOTS_KEY], undefined, context).catch(() => false)));
      if (!editable.includes(true)) {
        throw new EngineError(
          'NOT_ACTIONABLE',
          'nothing that takes keystrokes has focus: the typed text would reach no field. Tap the field first, or type into a listed input by id.',
          { retryable: false },
        );
      }
      if (options.replace) {
        await this.sendInput([pressSource('ControlOrMeta+a')]);
        await this.sendInput([pressSource('Delete')]);
      }
      await this.sendInput([typeSource(text)]);
    });
  }

  /** Sends one key to whatever holds focus. */
  pressKey(key: string, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'keyboard.press', () => this.sendInput([pressSource(key)]));
  }

  // --- the browser fixture ---

  /**
   * Navigates the attempt's tab to `url`, creating it on first use. A
   * `networkidle` wait then holds until no request has been in flight for
   * 500 ms, counted from before the navigation started.
   */
  goto(url: string, waitUntil: 'load' | 'domcontentloaded' | 'commit' | 'networkidle', operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', async (budget) => {
      const attempt = this.requireAttempt();
      const context = await this.ensureContext();
      await this.grantPermissions(url);
      if (waitUntil === 'networkidle') await attempt.network.start(false);
      const wait = waitUntil === 'load' || waitUntil === 'networkidle' ? 'complete' : waitUntil === 'domcontentloaded' ? 'interactive' : 'none';
      await this.requireBrowser().connection.send('browsingContext.navigate', { context, url, wait });
      if (waitUntil === 'networkidle') await attempt.network.waitForIdle(budget.signal);
    });
  }

  /** Reloads the tab and waits for its load event. */
  reload(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', async () => {
      await this.requireBrowser().connection.send('browsingContext.reload', { context: this.requireContext(), wait: 'complete' });
    });
  }

  /** Goes forward once in the tab's history and waits for the load. */
  forward(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', (budget) => this.traverse(1, budget.timeoutMs));
  }

  /** The tab's URL. */
  url(operation: OperationContext): Promise<string> {
    return this.guard(operation, 'url', () => this.currentUrl());
  }

  /** The document's title. */
  title(operation: OperationContext): Promise<string> {
    return this.guard(operation, 'title', async () => String(await this.call('() => document.title')));
  }

  /** Calls a compiled page function (`compileEvaluation`) with `arg` and returns its whole result. */
  evaluate(declaration: string, arg: PageArgument | undefined, operation: OperationContext): Promise<PageValue> {
    return this.guard(operation, 'evaluate', () =>
      this.call(declaration, arg === undefined ? [] : [arg], { awaitPromise: true, maxObjectDepth: null }),
    );
  }

  /** Adds one init script for every document the attempt's user context creates from now on, and every one a reset replaces it with. */
  addInitScript(source: string, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'addInitScript', async () => {
      const attempt = this.requireAttempt();
      const { script } = await this.requireBrowser().connection.send('script.addPreloadScript', {
        functionDeclaration: wrapScript(source),
        userContexts: [attempt.userContext],
      });
      attempt.addedScripts.push(source);
      attempt.preloads.push(script);
    });
  }

  /** The project-relative path of a file a test names. */
  projectPath(file: string): string {
    return path.resolve(this.projectRoot, file);
  }

  /** Registers a route for the attempt's requests; the newest route sees a request first. */
  route(route: NetworkRoute, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'route', () => this.requireAttempt().network.addRoute(route));
  }

  /** Removes the routes `match` selects. */
  unroute(match: (route: NetworkRoute) => boolean, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'unroute', async () => this.requireAttempt().network.removeRoutes(match));
  }

  /** The headers a request to `url` carries for the app's site, which a route's own `continue` keeps. */
  siteHeaders(url: string): Readonly<Record<string, string>> | undefined {
    return siteHeadersFor(url, this.site, this.options.headers === undefined ? undefined : lowercaseNames(this.options.headers));
  }

  /** Tracks one route handler so the attempt's end waits for it, and latches what it fails with. */
  trackHandler(work: Promise<void>): void {
    this.requireAttempt().latch.track('route', work);
  }

  /** Fails the next step with `error`, a route handler's failure nobody awaited. */
  latchFailure(error: Error): void {
    this.requireAttempt().latch.latch(error);
  }

  /** Resolves with the first response from now on whose URL `matches`, its body collected. */
  waitForResponse(matches: (url: string) => boolean, operation: OperationContext): Promise<ObservedResponse> {
    return this.guard(operation, 'waitForResponse', (budget) => this.requireAttempt().network.waitForResponse(matches, budget.signal));
  }

  /** Registers a dialog handler; returns its unsubscribe. */
  onDialog(handler: Parameters<DialogRouter['add']>[0]): () => void {
    return this.requireAttempt().dialogs.add(handler);
  }

  /**
   * Runs `trigger` and saves the first `count` downloads it starts into the
   * attempt's `downloads` folder, in start order. The trigger is test code,
   * so only cancellation bounds the wait around it.
   */
  collectDownloads(count: number, trigger: () => Promise<void>, signal: AbortSignal): Promise<{ path: string; absolutePath: string; suggestedFilename: string }[]> {
    const attempt = this.requireAttempt();
    return attempt.downloads.collect(count, trigger, signal, (context) => this.ours(context)).then((finished: FinishedDownload[]) =>
      finished.map((download) => {
        const { relative, absolute } = this.artifactPath('downloads', download.suggestedFilename, '');
        copyFileSync(download.filepath, absolute);
        return { path: relative, absolutePath: absolute, suggestedFilename: download.suggestedFilename };
      }));
  }

  /**
   * Changes the attempt's media features for the rest of it, from the next
   * paint on. Firefox does not implement `emulation.setMediaFeaturesOverride`,
   * so there it refuses.
   */
  emulateMedia(media: WebMedia, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'emulateMedia', async () => {
      if (this.options.browser !== 'chromium') {
        throw new EngineError('UNSUPPORTED_CAPABILITY', 'browser.emulateMedia needs emulation.setMediaFeaturesOverride, which Firefox does not implement yet; web({ colorScheme, reducedMotion }) applies on Firefox', {
          retryable: false,
        });
      }
      const attempt = this.requireAttempt();
      attempt.media = { ...attempt.media, ...media };
      await this.applyMedia(attempt);
    });
  }

  /** The cookies of the attempt's user context. */
  cookies(operation: OperationContext): Promise<Network.Cookie[]> {
    return this.guard(operation, 'cookies', async () => {
      const { cookies } = await this.requireBrowser().connection.send('storage.getCookies', { partition: this.partition() });
      return cookies;
    });
  }

  /** Sets cookies in the attempt's user context. */
  setCookies(cookies: readonly Storage.PartialCookie[], operation: OperationContext): Promise<void> {
    return this.guard(operation, 'setCookies', async () => {
      const connection = this.requireBrowser().connection;
      for (const cookie of cookies) await connection.send('storage.setCookie', { cookie, partition: this.partition() });
    });
  }

  /** Deletes the cookies `filter` selects (every one when it selects none), in the attempt's user context. */
  deleteCookies(filters: readonly Storage.CookieFilter[], operation: OperationContext): Promise<void> {
    return this.guard(operation, 'clearCookies', async () => {
      const connection = this.requireBrowser().connection;
      for (const filter of filters) await connection.send('storage.deleteCookies', { filter, partition: this.partition() });
    });
  }

  private partition(): Storage.StorageKeyPartitionDescriptor {
    return { type: 'storageKey', userContext: this.requireAttempt().userContext };
  }

  /** Resizes the tab's viewport for the rest of the attempt. */
  setViewport(size: ViewportSize, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'setViewport', async () => {
      await this.requireBrowser().connection.send('browsingContext.setViewport', { context: await this.ensureContext(), viewport: size });
    });
  }

  /** Runs raw input sources, holding what they leave pressed when `release` is false (`keyboard.down`). */
  input(label: string, actions: Input.SourceActions[], operation: OperationContext, release = true): Promise<void> {
    return this.guard(operation, label, async () => {
      if (release) return this.sendInput(actions);
      await this.requireBrowser().connection.send('input.performActions', { context: this.requireContext(), actions });
      this.trackPointer(actions);
    });
  }

  // --- state ---

  /** The user context's cookies and the open page's localStorage. */
  captureState(operation: OperationContext): Promise<EngineState> {
    return this.guard(operation, 'state capture', async () => {
      const { cookies } = await this.requireBrowser().connection.send('storage.getCookies', { partition: this.partition() });
      const origins: StoredOrigin[] = [];
      if (this.requireAttempt().context !== undefined) {
        const local = await this.read<StoredOrigin | null>(`() => /^https?:$/.test(location.protocol)
          ? { origin: location.origin, localStorage: Object.keys(localStorage).map((name) => ({ name, value: localStorage.getItem(name) })) }
          : null`, [], { maxObjectDepth: null });
        if (local !== null && local.localStorage.length > 0) origins.push(local);
      }
      const data: BidiStorageState = { cookies, origins };
      return { format: STATE_FORMAT, version: 1, data };
    });
  }

  /**
   * Replaces the user context with a clean one holding the snapshot: cookies
   * through `storage.setCookie`, and each origin's localStorage written from
   * a blank document the surface serves at that origin through a network
   * intercept, so the app's server sees no request.
   */
  restoreState(state: EngineState, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'state restore', async () => {
      if (state.format !== STATE_FORMAT || state.version !== 1 || !isStorageState(state.data)) {
        throw new EngineError('INVALID_STATE', `unsupported state format ${state.format}@${String(state.version)}`, { retryable: false });
      }
      const attempt = this.requireAttempt();
      const connection = this.requireBrowser().connection;
      await attempt.video?.contextClosing();
      await this.dropUserContext(attempt);
      attempt.context = undefined;
      attempt.refs.clear();
      await this.openUserContext(attempt);
      for (const { size: _size, ...cookie } of state.data.cookies) {
        await connection.send('storage.setCookie', { cookie, partition: this.partition() });
      }
      if (state.data.origins.length === 0) return;
      const context = await this.ensureContext();
      const { intercept } = await connection.send('network.addIntercept', { phases: ['beforeRequestSent'], contexts: [context] });
      const { subscription } = await connection.send('session.subscribe', { events: ['network.beforeRequestSent'], contexts: [context] });
      const off = connection.on('network.beforeRequestSent', (event) => {
        if (event.context !== context || !event.isBlocked) return;
        void connection.send('network.provideResponse', {
          request: event.request.request,
          statusCode: 200,
          headers: [{ name: 'content-type', value: { type: 'string', value: 'text/html' } }],
          body: { type: 'string', value: '<!doctype html><title></title>' },
        }).catch(() => undefined);
      });
      try {
        for (const origin of state.data.origins) {
          await connection.send('browsingContext.navigate', { context, url: `${origin.origin}/`, wait: 'complete' });
          await this.call('(items) => { localStorage.clear(); for (const { name, value } of items) localStorage.setItem(name, value); }', [
            origin.localStorage.map(({ name, value }) => ({ name, value })),
          ]);
        }
      } finally {
        off();
        await connection.send('session.unsubscribe', { subscriptions: [subscription] }).catch(() => undefined);
        await connection.send('network.removeIntercept', { intercept }).catch(() => undefined);
      }
      await connection.send('browsingContext.navigate', { context, url: 'about:blank', wait: 'complete' });
    });
  }

  // --- artifacts ---

  /**
   * Reserves one artifact path under the attempt directory: a per-attempt
   * counter keeps names unique, the label keeps them readable.
   */
  artifactPath(folder: string, label: string | undefined, extension: string): { relative: string; absolute: string } {
    const attempt = this.requireAttempt();
    attempt.artifactCounter += 1;
    const name = `${String(attempt.artifactCounter).padStart(3, '0')}${label === undefined ? '' : `-${sanitizeFilename(label)}`}${extension}`;
    const relative = path.posix.join(folder, name);
    const absolute = path.join(attempt.artifactsDir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    return { relative, absolute };
  }

  /** Writes a masked viewport screenshot under the attempt directory and returns its relative path. */
  screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    return this.guard(operation, 'screenshot', async () => {
      const { relative, absolute } = this.artifactPath('screenshots', label, '.png');
      const { pixels } = await this.capturePixels(await this.viewportSize());
      writeFileSync(absolute, pixels.data);
      return relative;
    });
  }

  /** Starts the attempt's video: the open tab now, and every tab the attempt opens until it stops. */
  startVideo(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'video', async () => {
      const attempt = this.requireAttempt();
      attempt.video ??= new BidiVideo(this.requireBrowser().connection, this.options.browser, attempt.artifactsDir, this.options.screencast);
      await attempt.video.arm(attempt.context, await (attempt.context === undefined ? Promise.resolve(this.options.viewport ?? { width: 1280, height: 720 }) : this.viewportSize()));
    });
  }

  /** Finishes the attempt's recording and returns its segments. */
  stopVideo(operation: OperationContext): Promise<readonly VideoFile[]> {
    return this.guard(operation, 'video', async () => (await this.requireAttempt().video?.stop()) ?? []);
  }
}

/** An init script's source as a preload script's function declaration. */
function wrapScript(source: string): string {
  return `() => {\n${source}\n}`;
}

/**
 * Firefox preferences that set the configured media features for every
 * page: Firefox has no BiDi media override, and the configuration is the
 * same for every attempt of a worker.
 */
function firefoxMediaPrefs(media: WebMedia): Record<string, number> {
  const prefs: Record<string, number> = {};
  if (media.colorScheme !== undefined) {
    prefs['layout.css.prefers-color-scheme.content-override'] = media.colorScheme === 'dark' ? 0 : media.colorScheme === 'light' ? 1 : 2;
  }
  if (media.reducedMotion !== undefined) prefs['ui.prefersReducedMotion'] = media.reducedMotion === 'reduce' ? 1 : 0;
  return prefs;
}

/** BiDi and script errors that mean the element or its document is gone. */
const STALE_PATTERN = /no such node|stale element|no such element|detached|execution context was destroyed|cannot find context|context with specified id|document unloaded|navigat/i;

/** Maps a failure onto the engine error contract. */
function classify(cause: unknown, label: string): Error {
  if (isClassified(cause)) return cause;
  const text = message(cause);
  if ((cause instanceof BidiError || cause instanceof ScriptError) && STALE_PATTERN.test(text)) {
    return new EngineError('NODE_STALE', `${label}: ${text}`, { retryable: true, cause });
  }
  return new EngineError('ENGINE_FAILURE', `${label}: ${text}`, { retryable: false, cause });
}

/**
 * What a locate must read: the query kinds and, for role queries, the roles
 * the expression names, so the page reads only elements one of its queries
 * could match. A selector, or a role query outside the known roles, reads
 * every element.
 */
function wantedQueries(expression: LocatorExpression): { kinds: Record<string, boolean>; roles: string[]; all: boolean } {
  const kinds: Record<string, boolean> = {};
  const roles = new Set<string>();
  let all = false;
  const walk = (node: LocatorExpression): void => {
    switch (node.kind) {
      case 'query':
        kinds[node.query.kind] = true;
        if (node.query.kind === 'role' && node.query.value.kind === 'string') roles.add(node.query.value.value);
        else if (node.query.kind === 'role') all = true;
        if (node.scope !== undefined) walk(node.scope);
        return;
      case 'selector':
        all = true;
        return;
      case 'filter':
        if (node.hasText !== undefined || node.hasNotText !== undefined) kinds['text'] = true;
        walk(node.source);
        if (node.has !== undefined) walk(node.has);
        if (node.hasNot !== undefined) walk(node.hasNot);
        return;
      case 'index':
      case 'frame':
        walk(node.source);
        return;
      case 'union':
        walk(node.left);
        walk(node.right);
    }
  };
  walk(expression);
  return { kinds, roles: [...roles], all };
}

/** Builds the read elements into trees by their nearest read ancestor; the roots, in document order. */
function buildForest(nodes: readonly RawNodeData[], parents: readonly number[], ids: readonly string[]): SemanticNode[] {
  const children: SemanticNode[][] = nodes.map(() => []);
  const built: SemanticNode[] = [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    built[index] = toSemanticNode({ id: ids[index]!, revision: '' }, labelled(nodes[index]!), children[index]!);
    const parent = parents[index]!;
    if (parent >= 0) children[parent]!.unshift(built[index]!);
  }
  return built.filter((_node, index) => parents[index]! < 0);
}

/**
 * A read whose name the reader left empty (a hidden element has none) named
 * by its first label or its `aria-label`, so a label query finds a hidden
 * control as Playwright's `getByLabel` does.
 */
function labelled(raw: RawNodeData): RawNodeData {
  if (raw.name !== null) return raw;
  const name = raw.labels?.[0] ?? raw.attributes['aria-label'];
  return name === undefined ? raw : { ...raw, name };
}

