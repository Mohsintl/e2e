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
import type { BidiConnection, BidiEventParams } from './connection.ts';

/** A request the browser holds for a route to decide. */
export interface InterceptedRequest {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  /** Header names lowercased, as Playwright reports a request's headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** The request body, when it has one the browser collected. */
  readonly postData?: string;
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
  /** The body the browser collected; rejects when it kept none (a redirect, an evicted body). */
  body(): Promise<Buffer>;
}

export interface AttemptNetworkOptions {
  /** Headers for every request bound for the app's site; names lowercased. */
  readonly siteHeaders: (url: string) => Readonly<Record<string, string>> | undefined;
  readonly credentials: { readonly username: string; readonly password: string } | undefined;
  /** Whether an event belongs to the attempt. */
  readonly ours: (event: { readonly userContext?: string | null; readonly context: string | null }) => boolean;
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
  private intercept: string | undefined;
  private authIntercept: string | undefined;
  private subscription: string | undefined;
  private collector: string | undefined;
  private requestCollector: string | undefined;
  private readonly inflight = new Set<string>();
  private lastSettled = Date.now();
  private readonly answered = new Set<string>();
  private readonly listeners: (() => void)[] = [];
  private ready: Promise<void> | undefined;

  constructor(
    private readonly connection: BidiConnection,
    private readonly userContext: () => string,
    private readonly options: AttemptNetworkOptions,
  ) {}

  /**
   * Starts what the attempt needs from the first request on: interception
   * for site headers, the basic-auth answer, and the request events every
   * later wait and route reads. Without headers, credentials, or routes,
   * nothing is intercepted.
   */
  start(interceptAll: boolean): Promise<void> {
    this.ready ??= this.subscribe(interceptAll);
    return this.ready;
  }

  private async subscribe(interceptAll: boolean): Promise<void> {
    const connection = this.connection;
    this.listeners.push(
      connection.on('network.beforeRequestSent', (event) => this.onRequest(event)),
      connection.on('network.responseCompleted', (event) => this.settle(event)),
      connection.on('network.fetchError', (event) => this.settle(event)),
      connection.on('network.authRequired', (event) => this.onAuth(event)),
    );
    const { subscription } = await connection.send('session.subscribe', {
      events: ['network.beforeRequestSent', 'network.authRequired'],
      userContexts: [this.userContext()],
    });
    this.subscription = subscription;
    if (interceptAll) await this.interceptRequests();
    if (this.options.credentials !== undefined) {
      this.authIntercept = (await connection.send('network.addIntercept', { phases: ['authRequired'] })).intercept;
    }
  }

  /** Holds every request for the routes, collecting request bodies for `postData`. */
  private async interceptRequests(): Promise<void> {
    if (this.intercept !== undefined) return;
    const connection = this.connection;
    const [{ intercept }, { collector }] = await Promise.all([
      connection.send('network.addIntercept', { phases: ['beforeRequestSent'] }),
      connection.send('network.addDataCollector', { dataTypes: ['request'], maxEncodedDataSize: MAX_COLLECTED_BODY, userContexts: [this.userContext()] }),
    ]);
    this.intercept = intercept;
    this.requestCollector = collector;
  }

  /** Registers a route for every request from now on; the newest route sees a request first. */
  async addRoute(route: NetworkRoute): Promise<void> {
    await this.start(false);
    await this.interceptRequests();
    this.routes.push(route);
  }

  /** Removes the routes `match` selects. */
  removeRoutes(match: (route: NetworkRoute) => boolean): void {
    this.routes = this.routes.filter((route) => !match(route));
  }

  private onRequest(event: BidiEventParams<'network.beforeRequestSent'>): void {
    if (!this.options.ours(event)) return;
    this.inflight.add(event.request.request);
    const intercepts: readonly string[] = event.intercepts ?? [];
    if (!event.isBlocked || this.intercept === undefined || !intercepts.includes(this.intercept)) return;
    void this.route(event).catch(() => undefined);
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

  private async postData(request: Network.RequestData): Promise<{ postData?: string }> {
    if (this.requestCollector === undefined || (request.bodySize ?? 0) === 0) return {};
    const data = await this.connection
      .send('network.getData', { dataType: 'request', request: request.request, collector: this.requestCollector })
      .catch(() => undefined);
    if (data === undefined) return {};
    return { postData: data.bytes.type === 'string' ? data.bytes.value : Buffer.from(data.bytes.value, 'base64').toString() };
  }

  /** Lets a held request go on, with its overrides and, for the app's site, the configured headers. */
  private async continue(
    request: InterceptedRequest,
    overrides: { url?: string; method?: string; headers?: Record<string, string>; postData?: string } = {},
  ): Promise<void> {
    const site = this.options.siteHeaders(overrides.url ?? request.url);
    const headers = overrides.headers === undefined && site === undefined ? undefined : { ...lowercase(overrides.headers ?? request.headers), ...site };
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
    const headers = { ...lowercase(response.headers) };
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
      .catch(() => undefined);
  }

  private settle(event: { readonly request: Network.RequestData; readonly userContext?: string | null; readonly context: string | null }): void {
    if (!this.inflight.delete(event.request.request)) return;
    if (this.inflight.size === 0) this.lastSettled = Date.now();
  }

  /**
   * Resolves once no request has been in flight for 500 ms, Playwright's
   * `networkidle`. `start` must have run before the navigation it follows,
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
   * Resolves with the first response whose URL `matches` that completes from
   * now on. Its body is collected from the moment of the call, so start the
   * wait before the action that triggers the response.
   */
  async waitForResponse(matches: (url: string) => boolean, signal: AbortSignal): Promise<ObservedResponse> {
    const collecting = this.collectResponses();
    let off: () => void = () => undefined;
    const completed = new Promise<BidiEventParams<'network.responseCompleted'>>((resolve) => {
      off = this.connection.on('network.responseCompleted', (event) => {
        if (this.options.ours(event) && matches(event.response.url)) resolve(event);
      });
    });
    try {
      await collecting;
      const event = await raceAbort(completed, signal, 'waitForResponse');
      const collector = this.collector;
      return {
        url: event.response.url,
        status: event.response.status,
        headers: headerRecord(event.response.headers),
        body: async () => {
          const data = await this.connection.send('network.getData', {
            dataType: 'response',
            request: event.request.request,
            ...(collector === undefined ? {} : { collector }),
          });
          return data.bytes.type === 'string' ? Buffer.from(data.bytes.value) : Buffer.from(data.bytes.value, 'base64');
        },
      };
    } finally {
      off();
    }
  }

  private async collectResponses(): Promise<void> {
    if (this.collector !== undefined) return;
    const { collector } = await this.connection.send('network.addDataCollector', {
      dataTypes: ['response'],
      maxEncodedDataSize: MAX_COLLECTED_BODY,
      userContexts: [this.userContext()],
    });
    this.collector = collector;
  }

  /** Removes the attempt's intercepts, collectors, and subscription; a request still held is let through. */
  async dispose(): Promise<void> {
    for (const off of this.listeners.splice(0)) off();
    this.routes = [];
    const connection = this.connection;
    await Promise.all([
      this.intercept === undefined ? undefined : connection.send('network.removeIntercept', { intercept: this.intercept }).catch(() => undefined),
      this.authIntercept === undefined ? undefined : connection.send('network.removeIntercept', { intercept: this.authIntercept }).catch(() => undefined),
      this.collector === undefined ? undefined : connection.send('network.removeDataCollector', { collector: this.collector }).catch(() => undefined),
      this.requestCollector === undefined ? undefined : connection.send('network.removeDataCollector', { collector: this.requestCollector }).catch(() => undefined),
      this.subscription === undefined ? undefined : connection.send('session.unsubscribe', { subscriptions: [this.subscription] }).catch(() => undefined),
    ]);
  }
}

/** BiDi headers as a record, names lowercased; a repeated name keeps its values joined, as Playwright reports them. */
function headerRecord(headers: readonly Network.Header[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.toLowerCase();
    const value = header.value.type === 'string' ? header.value.value : Buffer.from(header.value.value, 'base64').toString();
    out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`;
  }
  return out;
}

function lowercase(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

function wireHeaders(headers: Readonly<Record<string, string>>): Network.Header[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value: { type: 'string', value } }));
}

