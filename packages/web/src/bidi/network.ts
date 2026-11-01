/**
 * One attempt's network on the BiDi driver: request interception for the
 * test's routes and the configured site headers (`network.addIntercept` and
 * its continue, provide, and fail commands), basic-auth answers
 * (`authRequired` and `continueWithAuth`), the in-flight request count a
 * `networkidle` wait reads, and response waits whose bodies come from a data
 * collector. Interception and the extra subscriptions start only when
 * something needs them, since each blocked request costs a protocol round
 * trip.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Network } from 'webdriver-bidi-protocol';
import { raceAbort } from 'e2e/engine';
import { BidiError, type BidiConnection, type BidiEventParams } from './connection.ts';
import { lowercaseNames } from '../protected-app.ts';
import { releaseQuietly } from './errors.ts';

/** A request the browser holds for a route to decide. */
export interface InterceptedRequest {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  /** Header names lowercased, as Playwright reports a request's headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** The request body, when it has one the browser collected. */
  readonly postData?: string;
  /** The same body as the browser sent it, byte for byte. */
  readonly body?: Buffer;
  /** The cookies the browser sends with it, as one `cookie` header value. */
  readonly cookie?: string;
}

/** What a route does with one held request; exactly one of these runs. */
export interface RouteDecisions {
  continue(overrides?: { url?: string; method?: string; headers?: Record<string, string>; postData?: string }): Promise<void>;
  fulfill(response: { status: number; headers: Record<string, string>; contentType?: string; body?: string; json?: unknown; path?: string }): Promise<void>;
  abort(): Promise<void>;
  /** Hands the request to the next older matching route, or to the network. */
  fallback(): Promise<void>;
}

/** One registered route: which URLs it takes, and what it does with each request. */
export interface NetworkRoute {
  readonly predicate: (url: URL) => boolean;
  readonly handle: (request: InterceptedRequest, decisions: RouteDecisions) => Promise<void>;
}

/** A finished response as a response wait reports it. */
export interface ObservedResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** The body once it finished loading; rejects when the load failed or the browser kept none (a redirect, an evicted body). */
  body(): Promise<Buffer>;
}

export interface AttemptNetworkOptions {
  /** Headers for every request bound for the app's site; names lowercased. */
  readonly siteHeaders: (url: string) => Readonly<Record<string, string>> | undefined;
  readonly credentials: { readonly username: string; readonly password: string } | undefined;
  /** Whether an event belongs to the attempt. */
  readonly ours: (event: { readonly userContext?: string | null; readonly context: string | null }) => boolean;
  /** Whether a context is the attempt's tab or a frame in it, which a response wait listens to. */
  readonly onPage: (context: string | null) => boolean;
  /** Whether no other client drives the browser, so one intercept can cover every tab from its first request. */
  readonly exclusive: boolean;
  /** Takes a failure on a path no step awaits (deciding a held request, answering a challenge), for the next step to fail with. */
  readonly onFailure: (error: Error) => void;
}

/** The window of no requests in flight Playwright's `networkidle` waits for. */
const NETWORK_IDLE_MS = 500;
/** The largest body a response wait keeps, per response. */
const MAX_COLLECTED_BODY = 20 * 1024 * 1024;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export class AttemptNetwork {
  private routes: NetworkRoute[] = [];
  private userContext: string | undefined;
  /** The attempt's top-level tabs; intercepts cover exactly these, so a browser shared with other sessions keeps its own requests. */
  private readonly tops = new Set<string>();
  /** Whether every request is held: site headers to add, or a route registered. */
  private holding: boolean;
  /** Top-level tabs whose every document request is answered with a blank page (`serveBlank`), before any route. */
  private readonly blank = new Set<string>();
  private intercept: string | undefined;
  private authIntercept: string | undefined;
  /** Every intercept this network added to the bound user context, so a request a replaced one still holds is decided. */
  private readonly intercepts = new Set<string>();
  private subscription: string | undefined;
  private collector: Promise<string> | undefined;
  private requestCollector: string | undefined;
  /** Listeners of response bodies still loading, ended with the network. */
  private readonly pendingBodies = new Set<() => void>();
  private readonly inflight = new Set<string>();
  private lastSettled = Date.now();
  private readonly answered = new Set<string>();
  private readonly listeners: (() => void)[] = [];
  /** Serializes changes to the intercepts and subscriptions, which each take round trips. */
  private changes: Promise<void> = Promise.resolve();

  constructor(
    private readonly connection: BidiConnection,
    private readonly options: AttemptNetworkOptions & { readonly holdAll: boolean },
  ) {
    this.holding = options.holdAll;
  }

  private get needsEvents(): boolean {
    return this.holds || this.options.credentials !== undefined || this.listeners.length > 0;
  }

  private get holds(): boolean {
    return this.holding || this.blank.size > 0;
  }

  private change(work: () => Promise<void>): Promise<void> {
    const next = this.changes.then(work);
    this.changes = releaseQuietly(next);
    return next;
  }

  /**
   * Binds the network to a fresh user context (the attempt's first, or the
   * one a reset or restore replaced it with): its subscription and request
   * collector follow it, and its tabs start empty.
   */
  bind(userContext: string): Promise<void> {
    return this.change(async () => {
      await this.release();
      this.userContext = userContext;
      this.tops.clear();
      if (this.needsEvents) await this.subscribe();
    });
  }

  /** A top-level tab of the attempt opened: the intercepts cover it from now on. */
  addContext(context: string): Promise<void> {
    return this.change(async () => {
      this.tops.add(context);
      await this.refreshIntercepts();
    });
  }

  /** A top-level tab of the attempt closed. */
  removeContext(context: string): Promise<void> {
    if (!this.tops.delete(context)) return Promise.resolve();
    return this.change(() => this.refreshIntercepts());
  }

  /** Subscribes to the request events of the bound user context, and collects request bodies while requests are held. */
  private async subscribe(): Promise<void> {
    const connection = this.connection;
    const userContext = this.userContext;
    if (userContext === undefined || this.subscription !== undefined) return;
    if (this.listeners.length === 0) {
      this.listeners.push(
        connection.on('network.beforeRequestSent', (event) => this.onRequest(event)),
        connection.on('network.responseCompleted', (event) => this.settle(event)),
        connection.on('network.fetchError', (event) => this.settle(event)),
        connection.on('network.authRequired', (event) => this.onAuth(event)),
      );
    }
    const { subscription } = await connection.send('session.subscribe', {
      events: ['network.beforeRequestSent', 'network.authRequired'],
      userContexts: [userContext],
    });
    this.subscription = subscription;
    if (this.holding && this.requestCollector === undefined) {
      this.requestCollector = (await connection.send('network.addDataCollector', {
        dataTypes: ['request'],
        maxEncodedDataSize: MAX_COLLECTED_BODY,
        userContexts: [userContext],
      })).collector;
    }
  }

  /**
   * Brings the intercepts in line with what the attempt needs. On a browser
   * no other client drives, one intercept covers every tab, so a tab the app
   * opens is held from its first request; otherwise each covers the current
   * tabs exactly, so other clients keep their own requests, and is replaced,
   * the new one in place before the old goes.
   */
  private async refreshIntercepts(): Promise<void> {
    const connection = this.connection;
    const contexts = [...this.tops];
    const add = async (phase: 'beforeRequestSent' | 'authRequired'): Promise<string> => {
      const { intercept } = await connection.send('network.addIntercept', {
        phases: [phase],
        ...(this.options.exclusive ? {} : { contexts: contexts as [string, ...string[]] }),
      });
      this.intercepts.add(intercept);
      return intercept;
    };
    const replace = async (wanted: boolean, phase: 'beforeRequestSent' | 'authRequired', old: string | undefined): Promise<string | undefined> => {
      if (this.options.exclusive) return wanted ? (old ?? (await add(phase))) : old;
      const next = wanted && contexts.length > 0 ? await add(phase) : undefined;
      if (old !== undefined) await releaseQuietly(connection.send('network.removeIntercept', { intercept: old }));
      return next;
    };
    this.intercept = await replace(this.holds, 'beforeRequestSent', this.intercept);
    this.authIntercept = await replace(this.options.credentials !== undefined, 'authRequired', this.authIntercept);
  }

  /**
   * Answers every document request of `context`, a tab of the attempt, with
   * a blank page before any route sees it, so a page at an origin can run
   * script without the app's server seeing a request. Returns the undo.
   */
  async serveBlank(context: string): Promise<() => Promise<void>> {
    await this.change(async () => {
      this.blank.add(context);
      this.tops.add(context);
      await this.subscribe();
      await this.refreshIntercepts();
    });
    return () => this.change(async () => {
      this.blank.delete(context);
    });
  }

  /**
   * Starts counting the attempt's requests in flight, for a `networkidle`
   * wait. Call it before the navigation the wait follows.
   */
  track(): Promise<void> {
    return this.change(() => this.subscribe());
  }

  /** Registers a route for every request from now on; the newest route sees a request first. */
  addRoute(route: NetworkRoute): Promise<void> {
    return this.change(async () => {
      this.routes.push(route);
      if (this.holding) return;
      this.holding = true;
      await this.subscribe();
      if (this.requestCollector === undefined && this.userContext !== undefined) {
        this.requestCollector = (await this.connection.send('network.addDataCollector', {
          dataTypes: ['request'],
          maxEncodedDataSize: MAX_COLLECTED_BODY,
          userContexts: [this.userContext],
        })).collector;
      }
      await this.refreshIntercepts();
    });
  }

  /** Removes the routes `match` selects. */
  removeRoutes(match: (route: NetworkRoute) => boolean): void {
    this.routes = this.routes.filter((route) => !match(route));
  }

  private onRequest(event: BidiEventParams<'network.beforeRequestSent'>): void {
    const blocked = event.isBlocked && (event.intercepts ?? []).some((intercept) => this.intercepts.has(intercept));
    if (!this.options.ours(event)) {
      if (blocked) void this.connection.send('network.continueRequest', { request: event.request.request }).catch((cause: unknown) => this.fail(cause));
      return;
    }
    this.inflight.add(event.request.request);
    if (!blocked) return;
    const decide = event.context !== null && this.blank.has(event.context) ? this.answerBlank(event) : this.route(event);
    void decide.catch(async (cause: unknown) => {
      await releaseQuietly(this.connection.send('network.failRequest', { request: event.request.request }));
      this.fail(cause);
    });
  }

  /** Answers a document request with an empty page; any other request of a blank-served tab fails. */
  private async answerBlank(event: BidiEventParams<'network.beforeRequestSent'>): Promise<void> {
    const request = event.request.request;
    if (event.navigation === null) {
      await this.connection.send('network.failRequest', { request });
      return;
    }
    await this.connection.send('network.provideResponse', {
      request,
      statusCode: 200,
      headers: [{ name: 'content-type', value: { type: 'string', value: 'text/html' } }],
      body: { type: 'string', value: '<!doctype html><title></title>' },
    });
  }

  /**
   * Hands a failure of an unawaited path to the attempt. A request the
   * browser already let go (the page navigated away under it) is no failure.
   */
  private fail(cause: unknown): void {
    if (cause instanceof BidiError && cause.error === 'no such request') return;
    this.options.onFailure(cause instanceof Error ? cause : new Error(String(cause)));
  }

  /** Runs the matching routes newest first, then lets the request through with the site headers. */
  private async route(event: BidiEventParams<'network.beforeRequestSent'>): Promise<void> {
    const request = event.request;
    const url = URL.canParse(request.url) ? new URL(request.url) : undefined;
    const matching = url === undefined ? [] : this.routes.filter((route) => route.predicate(url)).toReversed();
    const intercepted: InterceptedRequest = {
      id: request.request,
      url: request.url,
      method: request.method,
      headers: headerRecord(request.headers),
      ...(request.cookies.length === 0 ? {} : { cookie: request.cookies.map((cookie) => `${cookie.name}=${bytesText(cookie.value)}`).join('; ') }),
      ...(matching.length === 0 ? {} : await this.postData(request)),
    };
    for (const route of matching) {
      let passed = false;
      await route.handle(intercepted, {
        continue: (overrides) => this.continue(intercepted, overrides),
        fulfill: (response) => this.fulfill(intercepted.id, response),
        abort: async () => {
          await this.connection.send('network.failRequest', { request: intercepted.id });
        },
        fallback: async () => {
          passed = true;
        },
      });
      if (!passed) return;
    }
    await this.continue(intercepted);
  }

  /** The request's body when the collector kept one, as text and bytes; a body it did not keep (too large, a stream) is none. */
  private async postData(request: Network.RequestData): Promise<{ postData?: string; body?: Buffer }> {
    if (this.requestCollector === undefined || (request.bodySize ?? 0) === 0) return {};
    try {
      const { bytes } = await this.connection.send('network.getData', { dataType: 'request', request: request.request, collector: this.requestCollector });
      const body = bytes.type === 'string' ? Buffer.from(bytes.value) : Buffer.from(bytes.value, 'base64');
      return { postData: body.toString(), body };
    } catch (cause) {
      if (cause instanceof BidiError && cause.error === 'no such network data') return {};
      throw cause;
    }
  }

  /** Lets a held request go on, with its overrides and, for the app's site, the configured headers. */
  private async continue(
    request: InterceptedRequest,
    overrides: { url?: string; method?: string; headers?: Record<string, string>; postData?: string } = {},
  ): Promise<void> {
    const site = this.options.siteHeaders(overrides.url ?? request.url);
    const headers = overrides.headers === undefined && site === undefined ? undefined : { ...lowercaseNames(overrides.headers ?? request.headers), ...site };
    await this.connection.send('network.continueRequest', {
      request: request.id,
      ...(overrides.url === undefined ? {} : { url: overrides.url }),
      ...(overrides.method === undefined ? {} : { method: overrides.method }),
      ...(headers === undefined ? {} : { headers: wireHeaders(headers) }),
      ...(overrides.postData === undefined ? {} : { body: { type: 'string' as const, value: overrides.postData } }),
    });
  }

  /** Answers a held request with a response the test wrote; a `path` body's type follows its extension. */
  private async fulfill(
    request: string,
    response: { status: number; headers: Record<string, string>; contentType?: string; body?: string; json?: unknown; path?: string },
  ): Promise<void> {
    const headers = { ...lowercaseNames(response.headers) };
    let body: Network.BytesValue;
    if (response.json !== undefined) {
      body = { type: 'string', value: JSON.stringify(response.json) };
      headers['content-type'] ??= 'application/json';
    } else if (response.path !== undefined) {
      body = { type: 'base64', value: (await readFile(response.path)).toString('base64') };
      const type = CONTENT_TYPES[path.extname(response.path).toLowerCase()];
      if (type !== undefined) headers['content-type'] ??= type;
    } else {
      body = { type: 'string', value: response.body ?? '' };
    }
    if (response.contentType !== undefined) headers['content-type'] = response.contentType;
    await this.connection.send('network.provideResponse', { request, statusCode: response.status, headers: wireHeaders(headers), body });
  }

  private onAuth(event: BidiEventParams<'network.authRequired'>): void {
    const credentials = this.options.credentials;
    if (!this.options.ours(event) || !event.isBlocked || credentials === undefined) return;
    // A second challenge for the same request means the credentials were refused; it gets the 401.
    const retry = this.answered.has(event.request.request);
    this.answered.add(event.request.request);
    void this.connection
      .send('network.continueWithAuth', retry
        ? { request: event.request.request, action: 'cancel' }
        : { request: event.request.request, action: 'provideCredentials', credentials: { type: 'password', ...credentials } })
      .catch((cause: unknown) => this.fail(cause));
  }

  private settle(event: { readonly request: Network.RequestData; readonly userContext?: string | null; readonly context: string | null }): void {
    if (!this.inflight.delete(event.request.request)) return;
    if (this.inflight.size === 0) this.lastSettled = Date.now();
  }

  /**
   * Resolves once no request has been in flight for 500 ms, Playwright's
   * `networkidle`. `track` must have run before the navigation it follows,
   * so the requests it started were counted.
   */
  async waitForIdle(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      if (this.inflight.size === 0 && Date.now() - this.lastSettled >= NETWORK_IDLE_MS) return;
      const wait = this.inflight.size === 0 ? NETWORK_IDLE_MS - (Date.now() - this.lastSettled) : 50;
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, wait)));
    }
  }

  /**
   * Resolves with the first response of the attempt's tab whose URL
   * `matches`, once its headers arrive. Its body is collected from the moment
   * of the call, so start the wait before the action that triggers the
   * response; reading it waits for the load to finish.
   */
  async waitForResponse(matches: (url: string) => boolean, signal: AbortSignal): Promise<ObservedResponse> {
    const connection = this.connection;
    let off: () => void = () => undefined;
    const started = new Promise<BidiEventParams<'network.responseStarted'>>((resolve) => {
      off = connection.on('network.responseStarted', (event) => {
        if (this.options.onPage(event.context) && matches(event.response.url)) resolve(event);
      });
    });
    let subscription: string | undefined;
    try {
      const collector = await this.collectResponses();
      subscription = (await connection.send('session.subscribe', { events: ['network.responseStarted'], ...(this.userContext === undefined ? {} : { userContexts: [this.userContext] }) })).subscription;
      const event = await raceAbort(started, signal, 'waitForResponse');
      const loaded = this.loaded(event.request.request);
      return {
        url: event.response.url,
        status: event.response.status,
        headers: headerRecord(event.response.headers),
        body: async () => {
          await loaded;
          const data = await connection.send('network.getData', { dataType: 'response', request: event.request.request, collector });
          return data.bytes.type === 'string' ? Buffer.from(data.bytes.value) : Buffer.from(data.bytes.value, 'base64');
        },
      };
    } finally {
      off();
      if (subscription !== undefined) await releaseQuietly(connection.send('session.unsubscribe', { subscriptions: [subscription] }));
    }
  }

  /** Settles once `request` finished loading, rejecting with the browser's error text when it failed. */
  private loaded(request: string): Promise<void> {
    const connection = this.connection;
    const done = new Promise<void>((resolve, reject) => {
      const offs = [
        connection.on('network.responseCompleted', (event) => {
          if (event.request.request === request) end(() => resolve());
        }),
        connection.on('network.fetchError', (event) => {
          if (event.request.request === request) end(() => reject(new Error(event.errorText)));
        }),
      ];
      const stop = (): void => {
        for (const each of offs) each();
        this.pendingBodies.delete(stop);
      };
      const end = (settle: () => void): void => {
        stop();
        settle();
      };
      this.pendingBodies.add(stop);
    });
    done.catch(() => undefined);
    return done;
  }

  /** The bound user context's response collector, added once however many waits ask at the same time. */
  private collectResponses(): Promise<string> {
    const userContext = this.userContext;
    this.collector ??= this.connection.send('network.addDataCollector', {
      dataTypes: ['response'],
      maxEncodedDataSize: MAX_COLLECTED_BODY,
      ...(userContext === undefined ? {} : { userContexts: [userContext] }),
    }).then(({ collector }) => collector);
    const pending = this.collector;
    pending.catch(() => {
      if (this.collector === pending) this.collector = undefined;
    });
    return pending;
  }

  /** Removes the bound user context's intercepts, collectors, and subscription. */
  private async release(): Promise<void> {
    const connection = this.connection;
    const removals = [
      this.intercept === undefined ? undefined : connection.send('network.removeIntercept', { intercept: this.intercept }),
      this.authIntercept === undefined ? undefined : connection.send('network.removeIntercept', { intercept: this.authIntercept }),
      this.collector?.then((collector) => connection.send('network.removeDataCollector', { collector })),
      this.requestCollector === undefined ? undefined : connection.send('network.removeDataCollector', { collector: this.requestCollector }),
      this.subscription === undefined ? undefined : connection.send('session.unsubscribe', { subscriptions: [this.subscription] }),
    ];
    this.intercept = this.authIntercept = this.collector = this.requestCollector = this.subscription = undefined;
    this.intercepts.clear();
    this.blank.clear();
    await Promise.all(removals.map(releaseQuietly));
  }

  /** Ends the attempt's network: listeners, routes, intercepts, collectors, and subscription. */
  async dispose(): Promise<void> {
    for (const off of this.listeners.splice(0)) off();
    for (const stop of this.pendingBodies) stop();
    this.routes = [];
    await this.change(() => this.release());
  }
}

/** BiDi headers as a record, names lowercased; a repeated name keeps its values joined, as Playwright reports them. */
function headerRecord(headers: readonly Network.Header[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.toLowerCase();
    const value = bytesText(header.value);
    out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`;
  }
  return out;
}

/** A BiDi bytes value as text. */
function bytesText(value: Network.BytesValue): string {
  return value.type === 'string' ? value.value : Buffer.from(value.value, 'base64').toString();
}


function wireHeaders(headers: Readonly<Record<string, string>>): Network.Header[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value: { type: 'string', value } }));
}

