/**
 * One attempt on the BiDi driver: its user context, the tab it drives, the
 * refs it minted, and the network, downloads, dialogs, and video scoped to
 * it, with the primitives every other module drives the page through.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Emulation, Input, Storage } from 'webdriver-bidi-protocol';
import { EngineError, obj, type AppLogEntry, type EngineSnapshot, type NodeRef, type ViewportPoint, type ViewportSize } from 'e2e/engine';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT } from '../closed-shadow.ts';
import { DialogRouter } from '../dialogs.ts';
import type { ConfiguredInitScripts } from '../init-scripts.ts';
import type { WebMedia } from '../media.ts';
import { ErrorLatch, invalidState, sanitizeFilename } from '../support.ts';
import type { WebScreencastOptions } from '../surface.ts';
import type { BidiConnection } from './connection.ts';
import { AttemptDownloads } from './downloads.ts';
import { releaseQuietly } from './errors.ts';
import { FrameRegistry, type NodeTarget } from './frames.ts';
import type { BidiBrowser, BidiBrowserName } from './launch.ts';
import { AttemptNetwork } from './network.ts';
import { viewportSize } from './page.ts';
import { callFunction, type CallOptions, type PageArgument, type PageValue, type TypedPageFunction, type Wire } from './script.ts';
import type { BidiVideo } from './video.ts';
import type { ProviderVideo } from '../provider-video.ts';

/**
 * Refuses service worker registration, as Playwright's `serviceWorkers:
 * 'block'` does when headers are configured: a worker's requests bypass
 * request interception, so they would leave without the headers.
 */
const BLOCK_SERVICE_WORKERS = "if (navigator.serviceWorker) navigator.serviceWorker.register = async () => { console.warn('Service Worker registration blocked by e2e'); };";

/** What every attempt of a worker is configured with. */
export interface SessionSettings {
  readonly browser: BidiBrowserName;
  readonly viewport: ViewportSize | null;
  readonly initScripts: ConfiguredInitScripts;
  readonly screencast: WebScreencastOptions;
  readonly userAgent: string | undefined;
  readonly locale: string | undefined;
  readonly timezoneId: string | undefined;
  readonly media: WebMedia;
  readonly testIdAttribute: string;
  readonly site: string | undefined;
  readonly projectRoot: string;
  readonly permissions: readonly string[];
  /** Whether the browser runs on another machine (a provider's lease), whose filesystem local paths do not reach. */
  readonly remoteFiles: boolean;
  /** Whether every request is held for the configured site headers, and service workers blocked. */
  readonly holdRequests: boolean;
  readonly siteHeaders: (url: string) => Readonly<Record<string, string>> | undefined;
}

/** What one attempt starts with. */
export interface AttemptSettings {
  readonly attemptId: string;
  readonly artifactsDir: string;
  readonly appLog: (entry: AppLogEntry) => void;
  /** Tells the trace where the app went on its own. */
  readonly navigation: (line: string) => void;
  /** Hands the trace a screen read after an action; absent when the attempt keeps no trace. */
  readonly screen: ((snapshot: EngineSnapshot) => void) | undefined;
  readonly credentials: { readonly username: string; readonly password: string } | undefined;
}

/** The user context and parent of each browsing context, as the session's events report them. */
export class ContextOwners {
  private readonly owners = new Map<string, string>();
  private readonly parents = new Map<string, string>();

  /** Records `context`'s user context, or its parent's for a frame. */
  created(context: string, userContext: string | undefined, parent: string | null | undefined): void {
    if (parent != null) this.parents.set(context, parent);
    if (userContext !== undefined) this.owners.set(context, userContext);
    else if (parent != null) this.owners.set(context, this.owners.get(parent) ?? '');
  }

  /** Forgets a closed context. */
  destroyed(context: string): void {
    this.owners.delete(context);
    this.parents.delete(context);
  }

  /** The user context `context` belongs to; undefined for one never seen. */
  owner(context: string): string | undefined {
    return this.owners.get(context);
  }

  /** The top-level browsing context `context` is, or is a frame of. */
  top(context: string): string {
    let top = context;
    for (let parent = this.parents.get(top); parent !== undefined; parent = this.parents.get(top)) top = parent;
    return top;
  }

  /** Forgets everything recorded, for a new user context. */
  clear(): void {
    this.owners.clear();
    this.parents.clear();
  }
}

/**
 * The ids the driver minted and the element behind each, with the browsing
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

  /** Keeps a located element under the id its read gave it, dropping the oldest past 2048. */
  storeLocated(id: string, target: NodeTarget): void {
    this.located.delete(id);
    this.located.set(id, target);
    for (const oldest of this.located.keys()) {
      if (this.located.size <= 2048) break;
      this.located.delete(oldest);
    }
  }

  /** The element behind `ref`; `NODE_STALE` when no generation holds it. */
  lookup(ref: NodeRef): NodeTarget {
    const target = this.located.get(ref.id) ?? this.observation.get(ref.id);
    if (target === undefined) throw new EngineError('NODE_STALE', `node reference ${ref.id} is stale`, { retryable: true });
    return target;
  }

  /** Forgets everything recorded, for a new user context. */
  clear(): void {
    this.observation = new Map();
    this.located.clear();
  }
}

/**
 * One attempt on a BiDi browser: its user context and tab, and the refs,
 * frames, network, downloads, dialogs, and video scoped to it.
 */
export class BidiSession {
  userContext = '';
  context: string | undefined;
  readonly refs = new BidiRefs();
  readonly frames = new FrameRegistry();
  readonly latch = new ErrorLatch();
  readonly dialogs = new DialogRouter(this.latch);
  readonly network: AttemptNetwork;
  readonly downloads: AttemptDownloads;
  /** The media features in effect: the configured ones, updated by `browser.emulateMedia`. */
  media: WebMedia;
  video: BidiVideo | undefined;
  /** The browser provider's own recording, which takes the place of `video` when the provider records. */
  providerVideo: ProviderVideo | undefined;
  /** Where the mouse last moved, which a viewport swipe wheels at. */
  pointer: ViewportPoint = { x: 0, y: 0 };
  /** Input and page mutations dispatched so far: an action that fails after this moved may have reached the app. */
  dispatches = 0;
  /** Navigations the driver itself has in flight, which the trace leaves to the step that started them. */
  ownNavigations = 0;
  /** The viewport `browser.setViewport` set for the rest of the attempt; the configured one until then. */
  private viewport: ViewportSize | null;
  private creating: Promise<string> | undefined;
  private preloads: string[] = [];
  private readonly addedScripts: string[] = [];
  private readonly granted = new Map<string, Promise<void>>();
  /** The web origins the attempt's documents have been at, whose storage a saved session keeps. */
  readonly visited = new Set<string>();
  private artifactCounter = 0;

  constructor(
    readonly browser: BidiBrowser,
    readonly settings: SessionSettings,
    readonly attempt: AttemptSettings,
    private readonly owners: ContextOwners,
  ) {
    this.media = settings.media;
    this.viewport = settings.viewport;
    this.network = new AttemptNetwork(browser.connection, {
      siteHeaders: settings.siteHeaders,
      credentials: attempt.credentials,
      ours: (event) => this.owns(event.context),
      onPage: (context) => this.onPage(context),
      exclusive: browser.exclusive,
      onFailure: (error) => this.latch.latch(error),
      holdAll: settings.holdRequests,
    });
    this.downloads = new AttemptDownloads(browser.connection);
  }

  /** The browser's BiDi connection. */
  get connection(): BidiConnection {
    return this.browser.connection;
  }

  /** Whether `context` belongs to this attempt's user context. */
  owns(context: string | null | undefined): boolean {
    return context != null && this.owners.owner(context) === this.userContext;
  }

  /** Whether `context` is the attempt's tab or a frame in it: what a page-scoped wait listens to, not a tab the app opened. */
  onPage(context: string | null | undefined): boolean {
    return context != null && this.context !== undefined && this.owners.top(context) === this.context;
  }

  /**
   * Creates the attempt's user context and applies everything scoped to it:
   * the preloaded scripts, downloads, the emulated user agent, locale (and
   * the `accept-language` Playwright's locale sends), time zone, and media,
   * and the network the headers and credentials need. Every step settles
   * before a failure is thrown, and each preload script is recorded as it is
   * added, so `close` removes everything that was set up.
   */
  async openUserContext(): Promise<void> {
    const connection = this.connection;
    const { userContext } = await connection.send('browser.createUserContext', {});
    this.userContext = userContext;
    this.granted.clear();
    this.visited.clear();
    const scoped = { userContexts: [userContext] as [string] };
    const sources = [
      CLOSED_SHADOW_ROOTS_INIT_SCRIPT,
      ...(this.settings.holdRequests ? [BLOCK_SERVICE_WORKERS] : []),
      ...this.settings.initScripts.forAttempt(),
      ...this.addedScripts,
    ];
    const { userAgent, locale, timezoneId } = this.settings;
    this.preloads = [];
    const steps = await Promise.allSettled([
      ...sources.map(async (source) => {
        this.preloads.push((await connection.send('script.addPreloadScript', { functionDeclaration: wrapScript(source), ...scoped })).script);
      }),
      this.downloads.allow(userContext),
      userAgent === undefined ? undefined : connection.send('emulation.setUserAgentOverride', { userAgent, ...scoped }),
      locale === undefined ? undefined : connection.send('emulation.setLocaleOverride', { locale, ...scoped }),
      locale === undefined ? undefined : connection.send('network.setExtraHeaders', { headers: [{ name: 'accept-language', value: { type: 'string', value: locale } }], ...scoped }),
      timezoneId === undefined ? undefined : connection.send('emulation.setTimezoneOverride', { timezone: timezoneId, ...scoped }),
      this.applyMedia(),
      this.network.bind(userContext),
    ]);
    const failed = steps.find((step) => step.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }

  /**
   * Removes the user context, which closes its tabs, then its preload
   * scripts: removing a script from a live tab races the tab's close inside
   * the Chromium mapper.
   */
  async dropUserContext(): Promise<void> {
    await this.video?.contextClosing();
    await this.connection.send('browser.removeUserContext', { userContext: this.userContext });
    await Promise.all(this.preloads.map((script) => releaseQuietly(this.connection.send('script.removePreloadScript', { script }))));
    this.preloads = [];
    this.context = undefined;
    this.refs.clear();
    this.frames.clear();
  }

  /** Replaces the user context with a clean one, the test's routes and added init scripts carried over. */
  async replaceUserContext(): Promise<void> {
    await this.dropUserContext();
    await this.openUserContext();
  }

  /**
   * Applies the media features on Chromium (`emulation.setMediaFeaturesOverride`);
   * Firefox takes the configured ones as launch preferences.
   */
  async applyMedia(): Promise<void> {
    if (this.settings.browser !== 'chromium' || (this.media.colorScheme === undefined && this.media.reducedMotion === undefined)) return;
    const features: Emulation.MediaFeatures = obj({
      'prefers-color-scheme': this.media.colorScheme === 'no-preference' ? null : this.media.colorScheme,
      'prefers-reduced-motion': this.media.reducedMotion,
    });
    await this.connection.send('emulation.setMediaFeaturesOverride', { features, userContexts: [this.userContext] });
  }

  /** Adds an init script for every document of this user context from now on, and of every one that replaces it. */
  async addInitScript(source: string): Promise<void> {
    const { script } = await this.connection.send('script.addPreloadScript', {
      functionDeclaration: wrapScript(source),
      userContexts: [this.userContext],
    });
    this.addedScripts.push(source);
    this.preloads.push(script);
  }

  /** The attempt's tab; `INVALID_STATE` before the first open. */
  requireContext(): string {
    if (this.context === undefined) throw invalidState('no page is open yet: open the app first');
    return this.context;
  }

  /**
   * The attempt's tab, created on first use at the attempt's viewport, with
   * the network covering it and a video segment started when recording.
   * Concurrent first uses share one creation. A window on Firefox:
   * Playwright's build never answers a tab created in a new user context.
   */
  ensureContext(): Promise<string> {
    if (this.context !== undefined) return Promise.resolve(this.context);
    this.creating ??= this.createContext().finally(() => {
      this.creating = undefined;
    });
    return this.creating;
  }

  /** Opens the attempt's tab in its user context, refusing one that opened after the user context was replaced. */
  private async createContext(): Promise<string> {
    const connection = this.connection;
    const userContext = this.userContext;
    const { context } = await connection.send('browsingContext.create', {
      type: this.settings.browser === 'firefox' ? 'window' : 'tab',
      userContext,
    });
    this.owners.created(context, userContext, null);
    if (userContext !== this.userContext) {
      await releaseQuietly(connection.send('browsingContext.close', { context }));
      throw new EngineError('NODE_STALE', 'the attempt replaced its user context while a tab opened', { retryable: true });
    }
    await this.network.addContext(context);
    if (this.viewport !== null) await connection.send('browsingContext.setViewport', { context, viewport: this.viewport });
    this.context = context;
    this.pointer = { x: 0, y: 0 };
    await this.video?.contextOpened(context, await this.viewportSize());
    return context;
  }

  /** Resizes the tab, and every tab the attempt opens after it, to `size`. */
  async setViewport(size: ViewportSize): Promise<void> {
    this.viewport = size;
    await this.connection.send('browsingContext.setViewport', { context: await this.ensureContext(), viewport: size });
  }

  /** Closes the tab, keeping the user context's storage. */
  async closeContext(): Promise<void> {
    const context = this.context;
    await this.video?.contextClosing();
    this.context = undefined;
    this.refs.clear();
    this.frames.clear();
    if (context === undefined) return;
    await this.network.removeContext(context);
    await this.connection.send('browsingContext.close', { context });
  }

  /** Calls a page function in `context` (the tab by default). */
  call(declaration: string, args: readonly PageArgument[] = [], options?: CallOptions, context?: string): Promise<PageValue> {
    return callFunction(this.connection, context ?? this.requireContext(), declaration, args, options);
  }

  /**
   * Runs one of this driver's typed page functions in `context` (the tab by
   * default), with its element arguments as references and its result
   * converted back the same way; a promise it returns is awaited.
   */
  async run<F extends TypedPageFunction>(fn: F, args: Wire<Parameters<F>> & readonly PageArgument[], context?: string): Promise<Wire<Awaited<ReturnType<F>>>> {
    const value = await callFunction(this.connection, context ?? this.requireContext(), fn, args, { awaitPromise: true, maxObjectDepth: null });
    return value as Wire<Awaited<ReturnType<F>>>;
  }

  /** `call` for a page function of this driver whose return shape the caller names; the page is not checked against it. */
  async read<T>(declaration: string, args: readonly PageArgument[] = [], options?: CallOptions, context?: string): Promise<T> {
    return (await this.call(declaration, args, options, context)) as T;
  }

  /**
   * Runs input sources on the tab. A source releases what it pressed itself,
   * so a key `keyboard.down` holds stays held across later input. Nothing is
   * sent once `signal` aborted.
   */
  async sendInput(actions: Input.SourceActions[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const context = this.requireContext();
    this.dispatches += 1;
    await this.connection.send('input.performActions', { context, actions });
    this.trackPointer(actions);
  }

  /** Counts a page mutation the driver made in the page (a fill, a select), which may have reached the app. */
  mutated(): void {
    this.dispatches += 1;
  }

  /** Remembers where `actions` left the mouse. */
  trackPointer(actions: readonly Input.SourceActions[]): void {
    for (const source of actions) {
      if (source.type !== 'pointer') continue;
      const last = source.actions.findLast((action) => action.type === 'pointerMove');
      if (last?.type === 'pointerMove') this.pointer = { x: last.x, y: last.y };
    }
  }

  /**
   * Records a document of the attempt starting to load `url`: its origin is
   * remembered for a saved session, and granted the configured permissions,
   * once per origin and user context (BiDi grants per origin). Concurrent
   * calls for one origin share its grant.
   */
  visit(url: string): Promise<void> {
    if (!URL.canParse(url)) return Promise.resolve();
    const { origin, protocol } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return Promise.resolve();
    this.visited.add(origin);
    if (this.settings.permissions.length === 0) return Promise.resolve();
    let grant = this.granted.get(origin);
    if (grant === undefined) {
      const userContext = this.userContext;
      grant = Promise.all(this.settings.permissions.map((name) =>
        this.connection.send('permissions.setPermission', { descriptor: { name }, state: 'granted', origin, userContext }))).then(() => undefined);
      this.granted.set(origin, grant);
    }
    return grant;
  }

  /** The viewport in CSS pixels: the attempt's, else the window's. */
  async viewportSize(): Promise<ViewportSize> {
    if (this.viewport !== null) return this.viewport;
    return this.run(viewportSize, []);
  }

  /** The tab's URL, as the browser reports it. */
  async currentUrl(): Promise<string> {
    const { contexts } = await this.connection.send('browsingContext.getTree', { root: this.requireContext(), maxDepth: 0 });
    return contexts[0]?.url ?? '';
  }

  /** `context` and every frame document under it. */
  async documentContexts(context: string): Promise<string[]> {
    const { contexts } = await this.connection.send('browsingContext.getTree', { root: context });
    const out: string[] = [];
    const walk = (info: (typeof contexts)[number]): void => {
      out.push(info.context);
      for (const child of info.children ?? []) walk(child);
    };
    for (const info of contexts) walk(info);
    return out;
  }

  /** The cookie partition of this user context. */
  partition(): Storage.StorageKeyPartitionDescriptor {
    return { type: 'storageKey', userContext: this.userContext };
  }

  /** Reserves one artifact path under the attempt directory: a counter keeps names unique, the label readable. */
  artifactPath(folder: string, label: string | undefined, extension: string): { relative: string; absolute: string } {
    this.artifactCounter += 1;
    const name = `${String(this.artifactCounter).padStart(3, '0')}${label === undefined ? '' : `-${sanitizeFilename(label)}`}${extension}`;
    const relative = path.posix.join(folder, name);
    const absolute = path.join(this.attempt.artifactsDir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    return { relative, absolute };
  }

  /**
   * Ends the attempt: its video, user context, network, and download
   * directory, each attempted whatever the others did; the first failure is
   * reported once all ran. A browser already gone leaves only local work.
   */
  async close(): Promise<void> {
    const gone = this.connection.isClosed;
    const results = await settleEach([
      () => this.video?.stop(),
      () => this.providerVideo?.abandon(AbortSignal.timeout(10_000)),
      () => (gone ? undefined : this.dropUserContext()),
      () => this.network.dispose(),
      () => this.downloads.dispose(),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }
}

/** An init script's source as a preload script's function declaration. */
function wrapScript(source: string): string {
  return `() => {\n${source}\n}`;
}

/** Runs each step in order whatever the earlier ones did, and settles with every outcome. */
async function settleEach(steps: readonly (() => unknown)[]): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = [];
  for (const step of steps) {
    try {
      results.push({ status: 'fulfilled', value: await step() });
    } catch (reason) {
      results.push({ status: 'rejected', reason });
    }
  }
  return results;
}
