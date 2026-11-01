/**
 * One attempt on the BiDi driver: its user context, the tab it drives, the
 * refs it minted, and the network, downloads, dialogs, and video scoped to
 * it, with the primitives every other module drives the page through.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Emulation, Input, Storage } from 'webdriver-bidi-protocol';
import { EngineError, obj, type AppLogEntry, type NodeRef, type ViewportPoint, type ViewportSize } from 'e2e/engine';
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
import { VIEWPORT_SIZE } from './page.ts';
import { callFunction, type CallOptions, type PageArgument, type PageValue } from './script.ts';
import type { BidiVideo } from './video.ts';

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
  /** Whether every request is held for the configured site headers. */
  readonly holdRequests: boolean;
  readonly siteHeaders: (url: string) => Readonly<Record<string, string>> | undefined;
}

/** What one attempt starts with. */
export interface AttemptSettings {
  readonly artifactsDir: string;
  readonly appLog: (entry: AppLogEntry) => void;
  readonly credentials: { readonly username: string; readonly password: string } | undefined;
}

/** The user context each browsing context belongs to, as the session's events report them. */
export class ContextOwners {
  private readonly owners = new Map<string, string>();

  /** Records `context`'s user context, or its parent's for a frame. */
  created(context: string, userContext: string | undefined, parent: string | null | undefined): void {
    if (userContext !== undefined) this.owners.set(context, userContext);
    else if (parent != null) this.owners.set(context, this.owners.get(parent) ?? '');
  }

  destroyed(context: string): void {
    this.owners.delete(context);
  }

  owner(context: string): string | undefined {
    return this.owners.get(context);
  }

  clear(): void {
    this.owners.clear();
  }
}

/**
 * The ids the driver minted and the element behind each, with the browsing
 * context that holds it. A BiDi shared id holds no handle: it names the
 * element for as long as it lives, so nothing here needs disposing.
 */
export class BidiRefs {
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

  clear(): void {
    this.observation = new Map();
    this.located.clear();
  }
}

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
  /** Where the mouse last moved, which a viewport swipe wheels at. */
  pointer: ViewportPoint = { x: 0, y: 0 };
  private preloads: string[] = [];
  private readonly addedScripts: string[] = [];
  private readonly granted = new Set<string>();
  private artifactCounter = 0;

  constructor(
    readonly browser: BidiBrowser,
    readonly settings: SessionSettings,
    readonly attempt: AttemptSettings,
    private readonly owners: ContextOwners,
  ) {
    this.media = settings.media;
    this.network = new AttemptNetwork(browser.connection, {
      siteHeaders: settings.siteHeaders,
      credentials: attempt.credentials,
      ours: (event) => this.owns(event.context),
      onFailure: (error) => this.latch.latch(error),
      holdAll: settings.holdRequests,
    });
    this.downloads = new AttemptDownloads(browser.connection);
  }

  get connection(): BidiConnection {
    return this.browser.connection;
  }

  /** Whether `context` belongs to this attempt's user context. */
  owns(context: string | null | undefined): boolean {
    return context != null && this.owners.owner(context) === this.userContext;
  }

  /**
   * Creates the attempt's user context and applies everything scoped to it:
   * the preloaded scripts, downloads, the emulated user agent, locale (and
   * the `accept-language` Playwright's locale sends), time zone, and media,
   * and the network the headers and credentials need.
   */
  async openUserContext(): Promise<void> {
    const connection = this.connection;
    const { userContext } = await connection.send('browser.createUserContext', {});
    this.userContext = userContext;
    this.granted.clear();
    const scoped = { userContexts: [userContext] as [string] };
    const sources = [CLOSED_SHADOW_ROOTS_INIT_SCRIPT, ...this.settings.initScripts.forAttempt(), ...this.addedScripts];
    const { userAgent, locale, timezoneId } = this.settings;
    const [preloads] = await Promise.all([
      Promise.all(sources.map(async (source) => (await connection.send('script.addPreloadScript', { functionDeclaration: wrapScript(source), ...scoped })).script)),
      this.downloads.allow(userContext),
      userAgent === undefined ? undefined : connection.send('emulation.setUserAgentOverride', { userAgent, ...scoped }),
      locale === undefined ? undefined : connection.send('emulation.setLocaleOverride', { locale, ...scoped }),
      locale === undefined ? undefined : connection.send('network.setExtraHeaders', { headers: [{ name: 'accept-language', value: { type: 'string', value: locale } }], ...scoped }),
      timezoneId === undefined ? undefined : connection.send('emulation.setTimezoneOverride', { timezone: timezoneId, ...scoped }),
      this.applyMedia(),
      this.network.bind(userContext),
    ]);
    this.preloads = preloads;
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
   * The attempt's tab, created on first use at the configured viewport,
   * with the network covering it and a video segment started when recording.
   * A window on Firefox: Playwright's build never answers a tab created in a
   * new user context.
   */
  async ensureContext(): Promise<string> {
    if (this.context !== undefined) return this.context;
    const connection = this.connection;
    const { context } = await connection.send('browsingContext.create', {
      type: this.settings.browser === 'firefox' ? 'window' : 'tab',
      userContext: this.userContext,
    });
    this.owners.created(context, this.userContext, null);
    await this.network.addContext(context);
    if (this.settings.viewport !== null) await connection.send('browsingContext.setViewport', { context, viewport: this.settings.viewport });
    this.context = context;
    this.pointer = { x: 0, y: 0 };
    await this.video?.contextOpened(context, await this.viewportSize());
    return context;
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

  /** `call` for a page function of this driver whose return shape the caller names; the page is not checked against it. */
  async read<T>(declaration: string, args: readonly PageArgument[] = [], options?: CallOptions, context?: string): Promise<T> {
    return (await this.call(declaration, args, options, context)) as T;
  }

  /** Runs input sources on the tab, releasing what they hold unless `release` is false (`keyboard.down`). */
  async sendInput(actions: Input.SourceActions[], release = true): Promise<void> {
    const context = this.requireContext();
    await this.connection.send('input.performActions', { context, actions });
    if (release) await this.connection.send('input.releaseActions', { context });
    this.trackPointer(actions);
  }

  /** Remembers where `actions` left the mouse. */
  trackPointer(actions: readonly Input.SourceActions[]): void {
    for (const source of actions) {
      if (source.type !== 'pointer') continue;
      const last = source.actions.findLast((action) => action.type === 'pointerMove');
      if (last?.type === 'pointerMove') this.pointer = { x: last.x, y: last.y };
    }
  }

  /** Grants the configured permissions on `url`'s origin, once per origin and user context: BiDi grants per origin. */
  async grantPermissions(url: string): Promise<void> {
    if (this.settings.permissions.length === 0 || !URL.canParse(url)) return;
    const { origin } = new URL(url);
    if (origin === 'null' || this.granted.has(origin)) return;
    this.granted.add(origin);
    await Promise.all(this.settings.permissions.map((name) =>
      this.connection.send('permissions.setPermission', { descriptor: { name }, state: 'granted', origin, userContext: this.userContext })));
  }

  /** The viewport in CSS pixels: the configured one, else the window's. */
  async viewportSize(): Promise<ViewportSize> {
    if (this.settings.viewport !== null) return this.settings.viewport;
    return this.read<ViewportSize>(VIEWPORT_SIZE);
  }

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

  /** Ends the attempt: its video, user context, network, and download directory. */
  async close(): Promise<void> {
    try {
      await this.video?.stop();
      await this.dropUserContext();
      await this.network.dispose();
    } finally {
      this.downloads.dispose();
    }
  }
}

/** An init script's source as a preload script's function declaration. */
function wrapScript(source: string): string {
  return `() => {\n${source}\n}`;
}
