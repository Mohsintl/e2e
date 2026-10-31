/**
 * The WebDriver BiDi surface: one browser per worker, one user context per
 * attempt, and the browsing context every engine member drives. The same
 * engine contract as `PlaywrightSurface`, reading the page through the same
 * in-page semantic reader, so the two drivers differ only in transport and
 * input dispatch.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Input, Network, Storage } from 'webdriver-bidi-protocol';
import {
  Deadline,
  EngineError,
  OBSERVED_NAME_LIMIT,
  OBSERVED_TEXT_LIMIT,
  raceAbort,
  resolveExpression,
  TestError,
  withinCleanupBudget,
  type AppLogEntry,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineInitInfo,
  type EngineObserveOptions,
  type EnginePrepareInfo,
  type EngineSnapshot,
  type EngineState,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type ObservationPixels,
  type OperationContext,
  type PointerAction,
  type SemanticNode,
  type ViewportPoint,
  type ViewportSize,
} from 'e2e/engine';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT, CLOSED_SHADOW_ROOTS_KEY } from '../closed-shadow.ts';
import { focusTakesKeys } from '../focus.ts';
import type { ConfiguredInitScripts } from '../init-scripts.ts';
import { ensureBrowsersInstalled } from '../install.ts';
import { assembleTree, ROOT_NODE_ID, toSemanticNode } from '../observation.ts';
import type { RawNodeData } from '../read-node.ts';
import { readPngSize } from '../observe.ts';
import { withOperationDeadline } from '../operation-budget.ts';
import { SECURE_FIELD_SELECTOR } from '../read-node.ts';
import { cancelled, invalidState, isClassified, message, nearestPixel, sanitizeFilename, swipeDistance, wheelDelta } from '../support.ts';
import { BidiError } from './connection.ts';
import { clickSources, dragSources, moveSources, pressSource, typeSource, wheelSources, type ClickOptions } from './input.ts';
import { launchBidiBrowser, type BidiBrowser, type BidiBrowserName } from './launch.ts';
import {
  ACTION_POINT,
  CHECK_STATE,
  DOM_READY,
  FILE_INPUT,
  FILL,
  FOCUS,
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

/** Browser launch budget when the harness init budget is not otherwise expressed. */
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;
/** Shared node budget of one observation, as the Playwright surface's. */
const MAX_OBSERVED_NODES = 3_000;
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
}

/** One attempt's isolation: its user context, the tab it drives, and the refs it minted. */
interface Attempt {
  userContext: string;
  context: string | undefined;
  preloads: string[];
  readonly refs: BidiRefs;
  readonly artifactsDir: string;
  artifactCounter: number;
  readonly appLog: (entry: AppLogEntry) => void;
  /** Where the mouse last moved, which a viewport swipe wheels at. */
  pointer: ViewportPoint;
}

/**
 * The ids the surface minted and the elements behind them. A BiDi shared id
 * holds no handle: it names the element for as long as it lives, so nothing
 * here needs disposing.
 */
class BidiRefs {
  private counter = 0;
  private observation = new Map<string, string>();
  private readonly located = new Map<string, string>();

  /** Reserves ids before a document can stamp them. */
  reserveIds(count: number): number {
    const first = this.counter + 1;
    this.counter += count;
    return first;
  }

  /** Replaces the observation generation. */
  publish(generation: Map<string, string>): void {
    this.observation = generation;
  }

  /** Keeps a located element under the id the tree read stamped on it. */
  storeLocated(id: string, sharedId: string): void {
    this.located.delete(id);
    this.located.set(id, sharedId);
    for (const oldest of this.located.keys()) {
      if (this.located.size <= 2048) break;
      this.located.delete(oldest);
    }
  }

  lookup(ref: NodeRef): ElementRef {
    const sharedId = this.located.get(ref.id) ?? this.observation.get(ref.id);
    if (sharedId === undefined) throw new EngineError('NODE_STALE', `node reference ${ref.id} is stale`, { retryable: true });
    return { sharedId };
  }

  get observed(): boolean {
    return this.observation.size > 0;
  }

  clear(): void {
    this.observation = new Map();
    this.located.clear();
  }
}

/** One read tree with the element behind each of its ids. */
interface CapturedTree {
  readonly tree: SemanticNode;
  readonly generation: Map<string, string>;
  readonly truncated: boolean;
}

export class BidiSurface {
  private browser: BidiBrowser | undefined;
  private attempt: Attempt | undefined;
  private headed = false;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly options: BidiSurfaceOptions) {}

  // --- lifecycle ---

  /** Installs the Playwright build this driver launches, once per run, and reads the init scripts. */
  async prepare(info: EnginePrepareInfo): Promise<void> {
    await this.options.initScripts.load(info.projectRoot);
    await ensureBrowsersInstalled([this.options.browser], { env: info.env, signal: info.signal, log: info.log, headed: info.headed });
  }

  /** Launches the worker's browser. */
  async init(info: EngineInitInfo): Promise<void> {
    this.headed = info.headed;
    await this.options.initScripts.load(info.projectRoot);
    await this.acquireBrowser(info.signal);
  }

  /** The live browser, relaunched when the last one went away. */
  private async acquireBrowser(signal: AbortSignal): Promise<BidiBrowser> {
    if (this.browser !== undefined && !this.browser.connection.isClosed) return this.browser;
    if (signal.aborted) throw cancelled('browser launch cancelled');
    const browser = await raceAbort(
      launchBidiBrowser(this.options.browser, { headed: this.headed, timeoutMs: BROWSER_LAUNCH_TIMEOUT_MS }),
      signal,
      'browser launch',
    );
    this.browser = browser;
    await browser.connection.send('session.subscribe', {
      events: ['log.entryAdded', 'network.responseCompleted', 'network.fetchError'],
    });
    this.listen(browser);
    return browser;
  }

  /** Forwards console output, uncaught errors, and failed requests of the attempt's tab to its app log. */
  private listen(browser: BidiBrowser): void {
    for (const off of this.unsubscribe.splice(0)) off();
    const ours = (context: string | null | undefined): boolean => context != null && context === this.attempt?.context;
    const report = (entry: AppLogEntry): void => {
      try {
        this.attempt?.appLog(entry);
      } catch {
        // The harness's sink never fails a page event.
      }
    };
    this.unsubscribe.push(
      browser.connection.on('log.entryAdded', (entry) => {
        if (!ours(entry.source.context) || entry.text === null) return;
        if (entry.type === 'javascript') report({ source: 'error', level: 'error', text: entry.text });
        else if (entry.level !== 'debug' && !entry.text.startsWith('Failed to load resource:')) {
          report({ source: 'console', level: entry.level === 'warn' ? 'warning' : entry.level, text: entry.text });
        }
      }),
      browser.connection.on('network.responseCompleted', (event) => {
        const { status, statusText } = event.response;
        if (!ours(event.context) || status < 400) return;
        // A browser's own request for a site icon the app never served is noise, as the Playwright app log treats it.
        if (status === 404 && URL.canParse(event.request.url) && new URL(event.request.url).pathname === '/favicon.ico') return;
        const line = `${event.request.method} ${event.request.url} ${status}${statusText === '' ? '' : ` ${statusText}`}`;
        report({ source: 'network', level: status >= 500 ? 'error' : 'warning', text: line });
      }),
      browser.connection.on('network.fetchError', (event) => {
        if (!ours(event.context) || event.errorText === 'NS_BINDING_ABORTED' || event.errorText === 'net::ERR_ABORTED') return;
        report({ source: 'network', level: 'error', text: `${event.request.method} ${event.request.url} ${event.errorText}` });
      }),
    );
  }

  /** Opens the attempt's user context with the closed-shadow recorder and the init scripts preloaded. */
  async startAttempt(context: EngineAttemptContext): Promise<void> {
    if (this.attempt !== undefined) throw invalidState('an attempt is already running');
    const browser = await this.acquireBrowser(context.signal);
    const userContext = await this.newUserContext(browser);
    this.attempt = {
      ...userContext,
      context: undefined,
      refs: new BidiRefs(),
      artifactsDir: context.artifactsDir,
      artifactCounter: 0,
      appLog: context.appLog,
      pointer: { x: 0, y: 0 },
    };
    context.environment({ browser: `${browser.name} ${browser.version}`, driver: 'webdriver-bidi' });
  }

  private async newUserContext(browser: BidiBrowser): Promise<{ userContext: string; preloads: string[] }> {
    const { userContext } = await browser.connection.send('browser.createUserContext', {});
    const sources = [CLOSED_SHADOW_ROOTS_INIT_SCRIPT, ...this.options.initScripts.forAttempt()];
    const preloads: string[] = [];
    for (const source of sources) {
      const { script } = await browser.connection.send('script.addPreloadScript', {
        functionDeclaration: `() => {\n${source}\n}`,
        userContexts: [userContext],
      });
      preloads.push(script);
    }
    return { userContext, preloads };
  }

  /** Removes the attempt's user context, which closes its tabs. Idempotent. */
  async endAttempt(context: EngineCleanupContext): Promise<void> {
    const attempt = this.attempt;
    this.attempt = undefined;
    if (attempt === undefined || this.browser === undefined || this.browser.connection.isClosed) return;
    await withinCleanupBudget(this.dropUserContext(attempt), context).catch(() => undefined);
  }

  private async dropUserContext(attempt: Attempt): Promise<void> {
    const connection = this.requireBrowser().connection;
    // Scripts go after their tabs: removing one from a live tab races the tab's close inside the Chromium mapper.
    await connection.send('browser.removeUserContext', { userContext: attempt.userContext });
    await Promise.all(attempt.preloads.map((script) => connection.send('script.removePreloadScript', { script }).catch(() => undefined)));
  }

  /** Ends the attempt and closes the browser. */
  async dispose(context: EngineCleanupContext): Promise<void> {
    await this.endAttempt(context);
    const browser = this.browser;
    this.browser = undefined;
    for (const off of this.unsubscribe.splice(0)) off();
    if (browser !== undefined) await withinCleanupBudget(browser.close(), context);
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

  /** Creates the attempt's tab on first use, at the configured viewport. */
  private async ensureContext(): Promise<string> {
    const attempt = this.requireAttempt();
    if (attempt.context !== undefined) return attempt.context;
    const connection = this.requireBrowser().connection;
    const { context } = await connection.send('browsingContext.create', {
      // Playwright's Firefox build never answers a tab created in a new user context; a window works in every build.
      type: this.options.browser === 'firefox' ? 'window' : 'tab',
      userContext: attempt.userContext,
    });
    if (this.options.viewport !== null) {
      await connection.send('browsingContext.setViewport', { context, viewport: this.options.viewport });
    }
    attempt.context = context;
    attempt.pointer = { x: 0, y: 0 };
    return context;
  }

  private call(declaration: string, args: readonly PageArgument[] = [], options?: CallOptions): Promise<PageValue> {
    return callFunction(this.requireBrowser().connection, this.requireContext(), declaration, args, options);
  }

  /** `call` for a page function of this module whose return shape the caller names; the page is not checked against it. */
  private async read<T>(declaration: string, args: readonly PageArgument[] = [], options?: CallOptions): Promise<T> {
    return (await this.call(declaration, args, options)) as T;
  }

  /** Runs input sources, then releases what they hold; the attempt remembers where the mouse ended. */
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

  /** Bounds one operation by its budget and classifies what it threw. */
  private async guard<T>(
    operation: OperationContext,
    label: string,
    work: (budget: { readonly signal: AbortSignal; readonly timeoutMs: number }) => Promise<T>,
  ): Promise<T> {
    try {
      return await withOperationDeadline(operation, label, (remaining) => work(remaining()));
    } catch (cause) {
      throw classify(cause, label);
    }
  }

  // --- steering ---

  /** Opens one URL in the attempt's tab and waits for its load event. */
  open(url: string, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', async () => {
      const context = await this.ensureContext();
      await this.requireBrowser().connection.send('browsingContext.navigate', { context, url, wait: 'complete' });
    });
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
      attempt.context = undefined;
      attempt.refs.clear();
      if (context !== undefined) await this.requireBrowser().connection.send('browsingContext.close', { context });
    });
  }

  /** Replaces the user context with a clean one and opens its blank tab. */
  reset(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'state reset', async () => {
      const attempt = this.requireAttempt();
      await this.dropUserContext(attempt);
      const fresh = await this.newUserContext(this.requireBrowser());
      attempt.userContext = fresh.userContext;
      attempt.preloads = fresh.preloads;
      attempt.context = undefined;
      attempt.refs.clear();
      await this.ensureContext();
    });
  }

  // --- observation and location ---

  /** One semantic observation, with masked pixels when asked. */
  observe(operation: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot> {
    return this.guard(operation, 'observe', async (budget) => {
      const attempt = this.requireAttempt();
      const settle = Math.min(SETTLE_TIMEOUT_MS, budget.timeoutMs / 2);
      await this.call(DOM_READY, [settle], { awaitPromise: true }).catch(() => undefined);
      const viewport = await this.viewportSize();
      const [captured, pixels] = await Promise.all([
        this.captureTree(attempt, MAX_OBSERVED_NODES, OBSERVED_NAME_LIMIT, OBSERVED_TEXT_LIMIT),
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
   * (`resolveExpression`) over node-mode reads of every element the
   * expression's queries could match; a `selector` is answered by
   * `browsingContext.locateNodes`.
   */
  locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    return this.guard(operation, 'locate', async () => {
      const attempt = this.requireAttempt();
      const selected = await this.locateSelectors(expression);
      const options = { testIdAttribute: this.options.testIdAttribute, secureFieldSelector: SECURE_FIELD_SELECTOR };
      const [json, elements] = await this.read<[string, ElementRef[]]>(LOCATE_READ, [options, wantedKinds(expression), CLOSED_SHADOW_ROOTS_KEY]);
      // oxlint-disable-next-line e2e/no-unchecked-json -- page-reported reads; the alignment below is checked
      const { nodes, parents } = JSON.parse(json) as LocateMetadata;
      if (nodes.length !== elements.length || parents.length !== nodes.length) {
        throw new EngineError('ENGINE_FAILURE', 'located reads do not align with their elements', { retryable: false });
      }
      const first = attempt.refs.reserveIds(nodes.length);
      const ids = nodes.map((_node, index) => `n${first + index}`);
      const sharedIds = new Map(ids.map((id, index) => [id, elements[index]!.sharedId]));
      const roots = buildForest(nodes, parents, ids);
      const matches = resolveExpression(expression, roots, {
        selector: (selector, candidates) => {
          const hits = selected.get(selector) ?? new Set<string>();
          return candidates.filter((node) => hits.has(sharedIds.get(node.ref.id) ?? ''));
        },
      });
      return matches.map((node) => {
        attempt.refs.storeLocated(node.ref.id, sharedIds.get(node.ref.id) ?? '');
        const { children: _children, ...rest } = node;
        return rest;
      });
    });
  }

  /** The shared ids every `selector` in the expression matches, read before the tree so one pass answers them all. */
  private async locateSelectors(expression: LocatorExpression): Promise<Map<string, Set<string>>> {
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
    const context = this.requireContext();
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
   * Reads the document's tree in one call: the reader's metadata as one JSON
   * string, and each walked element as its shared id. Child documents stay
   * boundary nodes; an iframe in the tree marks the read truncated.
   */
  private async captureTree(attempt: Attempt, maxNodes: number, nameLimit: number, textLimit: number): Promise<CapturedTree> {
    const readTree = (structured: boolean): Promise<[TreeMetadata | string | null, ElementRef[]]> => {
      const options = {
        testIdAttribute: this.options.testIdAttribute,
        secureFieldSelector: SECURE_FIELD_SELECTOR,
        mode: { kind: 'tree', maxNodes, idSeed: attempt.refs.reserveIds(maxNodes), nameLimit, textLimit },
      };
      return this.read(READ_TREE, [options, structured], structured ? { maxObjectDepth: null } : undefined);
    };
    let [metadata, elements] = await readTree(false);
    if (metadata === null) [metadata, elements] = await readTree(true);
    // oxlint-disable-next-line e2e/no-unchecked-json -- page-reported metadata; the ids and nodes alignment below is checked
    const decoded = typeof metadata === 'string' ? (JSON.parse(metadata) as TreeMetadata) : (metadata as TreeMetadata);
    const { nodes, ids } = decoded;
    if (!Array.isArray(ids) || ids.length !== nodes.length || elements.length !== nodes.length) {
      throw new EngineError('ENGINE_FAILURE', 'observation ids do not align with its nodes', { retryable: false });
    }
    if (ids.length > 0) ids[0] = ROOT_NODE_ID;
    const generation = new Map<string, string>();
    elements.forEach((element, index) => generation.set(ids[index] as string, element.sharedId));
    const truncated = decoded.truncated || nodes.some((node) => node.frameSelector !== undefined);
    return { tree: assembleTree(nodes, ids, [], new Map()), generation, truncated };
  }

  private async viewportSize(): Promise<ViewportSize> {
    if (this.options.viewport !== null) return this.options.viewport;
    return this.read<ViewportSize>(VIEWPORT_SIZE);
  }

  private async currentUrl(): Promise<string> {
    const { contexts } = await this.requireBrowser().connection.send('browsingContext.getTree', { root: this.requireContext(), maxDepth: 0 });
    return contexts[0]?.url ?? '';
  }

  /** A viewport screenshot with every secure field covered and the caret hidden. */
  private async capturePixels(viewport: ViewportSize): Promise<{ pixels: ObservationPixels; maskedRegionCount: number }> {
    const connection = this.requireBrowser().connection;
    const context = this.requireContext();
    const masked = await this.read<number>(MASK, [SECURE_FIELD_SELECTOR, CLOSED_SHADOW_ROOTS_KEY]);
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
        maskedRegionCount: masked,
      };
    } finally {
      await this.call(UNMASK).catch(() => undefined);
    }
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
      const element = attempt.refs.lookup(ref);
      const deadline = new Deadline(budget.timeoutMs);
      await this.dispatch(element, action, deadline, attempt);
    });
  }

  private async dispatch(element: ElementRef, action: LocatorAction, deadline: Deadline, attempt: Attempt): Promise<void> {
    switch (action.kind) {
      case 'tap':
        return this.click(element, deadline, action.modifiers === undefined ? {} : { modifiers: action.modifiers });
      case 'doubleTap':
        return this.click(element, deadline, { clicks: 2, ...(action.modifiers === undefined ? {} : { modifiers: action.modifiers }) });
      case 'secondaryTap':
        return this.click(element, deadline, { button: 2, ...(action.modifiers === undefined ? {} : { modifiers: action.modifiers }) });
      case 'longPress':
        return this.click(element, deadline, { holdMs: action.durationMs ?? DEFAULT_LONG_PRESS_MS });
      case 'hover': {
        const point = await this.actionPoint(element, deadline, false);
        await this.sendInput(moveSources(point.x, point.y));
        return;
      }
      case 'fill':
        return this.fill(element, action.value);
      case 'clear':
        return this.fill(element, '');
      case 'press':
        await this.call(FOCUS, [element]);
        await this.sendInput([pressSource(action.key)]);
        return;
      case 'focus':
        await this.call(FOCUS, [element]);
        return;
      case 'scrollIntoView':
        await this.actionPoint(element, deadline, false, false);
        return;
      case 'check':
      case 'uncheck':
        return this.setChecked(element, action.kind === 'check', deadline);
      case 'selectOption': {
        const value = action.value;
        const by = typeof value === 'string' ? { label: value } : value;
        const problem = await this.call(SELECT_OPTION, [element, by as PageArgument]);
        if (typeof problem === 'string') throw new EngineError('NOT_ACTIONABLE', `selectOption: ${problem}`, { retryable: false });
        return;
      }
      case 'setInputFiles': {
        const input = await this.call(FILE_INPUT, [element]);
        if (input === null || typeof input !== 'object' || !('sharedId' in input)) {
          throw new EngineError('UNSUPPORTED_CAPABILITY', 'setInputFiles on the BiDi driver takes a file input or its label; a control that opens a chooser is not supported yet', {
            retryable: false,
          });
        }
        await this.requireBrowser().connection.send('input.setFiles', {
          context: this.requireContext(),
          element: { sharedId: (input as ElementRef).sharedId },
          files: [...action.paths],
        });
        return;
      }
      case 'dragTo': {
        const from = await this.actionPoint(element, deadline, true);
        const to = await this.actionPoint(attempt.refs.lookup(action.target), deadline, false);
        await this.sendInput(dragSources(from, to));
        return;
      }
      case 'swipe': {
        const point = await this.actionPoint(element, deadline, false);
        const viewport = await this.viewportSize();
        const box = await this.read<ViewportSize>('(element) => { const r = element.getBoundingClientRect(); return { width: r.width, height: r.height }; }', [element]);
        await this.wheel(point, box.width > 0 ? box : viewport, action.direction, action.momentum ?? 'none');
        return;
      }
    }
  }

  /** Waits until the element can take a pointer action, then clicks its centre. */
  private async click(element: ElementRef, deadline: Deadline, options: ClickOptions): Promise<void> {
    const point = await this.actionPoint(element, deadline, true);
    await this.sendInput(clickSources(point.x, point.y, options));
  }

  /** Polls the element's actionability until it is ready or the deadline passes. */
  private async actionPoint(element: ElementRef, deadline: Deadline, enabled: boolean, hitTest = true): Promise<{ x: number; y: number }> {
    let last: ActionPoint;
    for (;;) {
      last = await this.read<ActionPoint>(ACTION_POINT, [element, enabled, hitTest], { awaitPromise: true });
      if (last.state === 'ok') return { x: last.x, y: last.y };
      if (last.state === 'detached') throw new EngineError('NODE_STALE', 'element is not attached to the DOM', { retryable: true });
      if (deadline.remaining() <= ACTIONABILITY_POLL_MS) break;
      await sleep(ACTIONABILITY_POLL_MS);
    }
    const reason = last.state === 'blocked' ? last.blocker : `element is ${last.state === 'moving' ? 'not stable' : `not ${last.state === 'hidden' ? 'visible' : 'enabled'}`}`;
    throw new EngineError('NOT_ACTIONABLE', `element did not become actionable in time: ${reason}`, { retryable: false });
  }

  /** Replaces the field's content with `value` in one edit, as a paste would; see `FILL`. */
  private async fill(element: ElementRef, value: string): Promise<void> {
    const problem = await this.call(FILL, [element, value]);
    if (typeof problem === 'string') throw new EngineError('NOT_ACTIONABLE', problem, { retryable: false });
  }

  /** Clicks a checkable once when its state differs, then polls until it reads `checked`. */
  private async setChecked(element: ElementRef, checked: boolean, deadline: Deadline): Promise<void> {
    const read = (): Promise<{ checked: boolean | null; radio: boolean }> => this.read(CHECK_STATE, [element]);
    const before = await read();
    if (before.checked === null) throw new EngineError('NOT_ACTIONABLE', 'element is not a checkbox or radio button', { retryable: false });
    if (before.checked === checked) return;
    if (!checked && before.radio) {
      throw new EngineError('NOT_ACTIONABLE', 'uncheck cannot clear a radio button; select another radio in its group', { retryable: false });
    }
    await this.click(element, deadline, {});
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

  /** Types into whatever holds focus, refusing when nothing there takes keystrokes. */
  typeText(text: string, options: { readonly replace: boolean }, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'keyboard.type', async () => {
      const editable = await this.call(focusTakesKeys.toString(), [CLOSED_SHADOW_ROOTS_KEY]);
      if (editable !== true) {
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

  /** Navigates the attempt's tab to `url`, creating it on first use. */
  goto(url: string, waitUntil: 'load' | 'domcontentloaded' | 'commit', operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', async () => {
      const context = await this.ensureContext();
      const wait = waitUntil === 'load' ? 'complete' : waitUntil === 'domcontentloaded' ? 'interactive' : 'none';
      await this.requireBrowser().connection.send('browsingContext.navigate', { context, url, wait });
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
      await this.dropUserContext(attempt);
      Object.assign(attempt, await this.newUserContext(this.requireBrowser()), { context: undefined });
      attempt.refs.clear();
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

  /** Writes a masked viewport screenshot under the attempt directory and returns its relative path. */
  screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    return this.guard(operation, 'screenshot', async () => {
      const attempt = this.requireAttempt();
      attempt.artifactCounter += 1;
      const name = `${String(attempt.artifactCounter).padStart(3, '0')}${label === undefined ? '' : `-${sanitizeFilename(label)}`}.png`;
      const relative = path.posix.join('screenshots', name);
      const absolute = path.join(attempt.artifactsDir, relative);
      mkdirSync(path.dirname(absolute), { recursive: true });
      const { pixels } = await this.capturePixels(await this.viewportSize());
      writeFileSync(absolute, pixels.data);
      return relative;
    });
  }
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

/** The query kinds an expression asks for, which decide the elements a locate reads; a role or selector reads every element. */
function wantedKinds(expression: LocatorExpression): Record<string, boolean> {
  const wants: Record<string, boolean> = {};
  const walk = (node: LocatorExpression): void => {
    switch (node.kind) {
      case 'query':
        wants[node.query.kind === 'role' ? 'all' : node.query.kind] = true;
        if (node.scope !== undefined) walk(node.scope);
        return;
      case 'selector':
        wants['all'] = true;
        return;
      case 'filter':
        if (node.hasText !== undefined || node.hasNotText !== undefined) wants['text'] = true;
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
  return wants;
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
