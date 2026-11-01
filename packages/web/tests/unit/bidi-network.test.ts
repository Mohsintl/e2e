/**
 * One attempt's network on the BiDi driver against a scripted peer:
 * intercepts scoped to the attempt's tabs, routes newest first with
 * fallback, site headers, failures on unawaited paths, basic-auth answers,
 * the `networkidle` window, and response waits.
 */

import { describe, expect, it } from 'vitest';
import { AttemptNetwork, type NetworkRoute } from '../../src/bidi/network.ts';
import { FakeBidi, settle } from '../helpers/bidi-fake.ts';

const SITE = 'http://app.test';

function network(
  fake: FakeBidi,
  options: { holdAll?: boolean; credentials?: { username: string; password: string }; exclusive?: boolean; ours?: (context: string | null) => boolean; onPage?: (context: string | null) => boolean } = {},
) {
  const failures: Error[] = [];
  let intercepts = 0;
  fake.on('network.addIntercept', () => ({ result: { intercept: `intercept-${(intercepts += 1)}` } }));
  fake.on('network.addDataCollector', { result: { collector: 'collector-1' } });
  fake.on('session.subscribe', { result: { subscription: 'subscription-1' } });
  const net = new AttemptNetwork(fake.connection, {
    siteHeaders: (url) => (url.startsWith(SITE) ? { 'x-preview': 'token' } : undefined),
    credentials: options.credentials,
    ours: (event) => options.ours?.(event.context) ?? true,
    onPage: (context) => options.onPage?.(context) ?? true,
    exclusive: options.exclusive ?? false,
    onFailure: (error) => failures.push(error),
    holdAll: options.holdAll ?? false,
  });
  return { net, failures };
}

function request(id: string, url: string, intercepts: string[] = ['intercept-1']): Record<string, unknown> {
  return {
    context: 'tab',
    isBlocked: intercepts.length > 0,
    navigation: null,
    redirectCount: 0,
    timestamp: 0,
    intercepts,
    request: { request: id, url, method: 'GET', headers: [{ name: 'Accept', value: { type: 'string', value: '*/*' } }], cookies: [], headersSize: 0, bodySize: 0, timings: {} },
  };
}

function route(predicate: (url: URL) => boolean, handle: NetworkRoute['handle']): NetworkRoute {
  return { predicate, handle };
}

describe('AttemptNetwork', () => {
  it('holds requests only for the attempt’s tabs, and starts over on a new user context', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake, { holdAll: true });
    await net.bind('user-1');
    expect(fake.commands('network.addIntercept')).toEqual([]);
    await net.addContext('tab-1');
    await net.addContext('tab-2');
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toEqual([
      { phases: ['beforeRequestSent'], contexts: ['tab-1'] },
      { phases: ['beforeRequestSent'], contexts: ['tab-1', 'tab-2'] },
    ]);
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toEqual(['intercept-1']);
    await net.bind('user-2');
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toEqual(['intercept-1', 'intercept-2']);
    expect(fake.commands('session.subscribe').at(-1)?.params).toEqual({ events: ['network.beforeRequestSent', 'network.authRequired'], userContexts: ['user-2'] });
  });

  it('runs the newest matching route first and passes a fallback to the next', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    await net.addContext('tab');
    const order: string[] = [];
    await net.addRoute(route(() => true, async (_request, decisions) => {
      order.push('older');
      await decisions.fulfill({ status: 201, headers: {}, json: [{ name: 'Stubbed' }] });
    }));
    await net.addRoute(route((url) => url.pathname === '/api/users', async (_request, decisions) => {
      order.push('newer');
      await decisions.fallback();
    }));
    fake.emit('network.beforeRequestSent', request('r1', `${SITE}/api/users`));
    await settle();
    await settle();
    expect(order).toEqual(['newer', 'older']);
    expect(fake.commands('network.provideResponse')[0]?.params).toEqual({
      request: 'r1',
      statusCode: 201,
      headers: [{ name: 'content-type', value: { type: 'string', value: 'application/json' } }],
      body: { type: 'string', value: '[{"name":"Stubbed"}]' },
    });
  });

  it('lets an unmatched request through, adding the site headers only for the app’s site', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake, { holdAll: true });
    await net.bind('user-1');
    await net.addContext('tab');
    fake.emit('network.beforeRequestSent', request('site', `${SITE}/page`));
    fake.emit('network.beforeRequestSent', request('other', 'https://cdn.test/lib.js'));
    await settle();
    const continued = fake.commands('network.continueRequest').map((command) => command.params);
    expect(continued).toContainEqual({
      request: 'site',
      headers: [{ name: 'accept', value: { type: 'string', value: '*/*' } }, { name: 'x-preview', value: { type: 'string', value: 'token' } }],
    });
    expect(continued).toContainEqual({ request: 'other' });
  });

  it('releases a held request whose route failed and reports the failure, but not a request the page already dropped', async () => {
    const fake = new FakeBidi();
    const { net, failures } = network(fake);
    await net.bind('user-1');
    await net.addContext('tab');
    await net.addRoute(route(() => true, async () => {
      throw new Error('handler exploded');
    }));
    fake.emit('network.beforeRequestSent', request('r1', `${SITE}/a`));
    await settle();
    await settle();
    expect(fake.commands('network.failRequest').map((command) => command.params)).toEqual([{ request: 'r1' }]);
    expect(failures.map((error) => error.message)).toEqual(['handler exploded']);
    net.removeRoutes(() => true);
    fake.on('network.continueRequest', { error: 'no such request', message: 'gone' });
    fake.emit('network.beforeRequestSent', request('r2', `${SITE}/b`));
    await settle();
    await settle();
    expect(failures).toHaveLength(1);
  });

  it('answers a basic-auth challenge once, then lets a refused one through as the 401', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake, { credentials: { username: 'ada', password: 'secret' } });
    await net.bind('user-1');
    await net.addContext('tab');
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toContainEqual({ phases: ['authRequired'], contexts: ['tab'] });
    const challenge = { ...request('r1', `${SITE}/private`), response: { status: 401 } };
    fake.emit('network.authRequired', challenge);
    fake.emit('network.authRequired', challenge);
    await settle();
    expect(fake.commands('network.continueWithAuth').map((command) => command.params)).toEqual([
      { request: 'r1', action: 'provideCredentials', credentials: { type: 'password', username: 'ada', password: 'secret' } },
      { request: 'r1', action: 'cancel' },
    ]);
  });

  it('waits for 500 ms with no request in flight before calling the network idle', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    await net.track();
    fake.emit('network.beforeRequestSent', request('r1', `${SITE}/slow`, []));
    const started = Date.now();
    let idle = false;
    const waiting = net.waitForIdle(AbortSignal.timeout(5_000)).then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(idle).toBe(false);
    fake.emit('network.responseCompleted', { ...request('r1', `${SITE}/slow`, []), response: { url: `${SITE}/slow`, status: 200 } });
    await waiting;
    expect(Date.now() - started).toBeGreaterThanOrEqual(690);
  });

  it('resolves a response wait on the headers of the first match in the tab, and reads its body once loaded', async () => {
    const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: '[1,2,3]' } } });
    const { net } = network(fake, { onPage: (context) => context === 'tab' });
    await net.bind('user-1');
    const waiting = net.waitForResponse((url) => url.endsWith('/api/users'), AbortSignal.timeout(5_000));
    await settle();
    const started = (id: string, url: string, context = 'tab') => ({
      ...request(id, url, []),
      context,
      response: { url, status: 200, headers: [{ name: 'Content-Type', value: { type: 'string', value: 'application/json' } }] },
    });
    fake.emit('network.responseStarted', started('other', `${SITE}/other`));
    fake.emit('network.responseStarted', started('popup', `${SITE}/api/users`, 'popup'));
    fake.emit('network.responseStarted', started('users', `${SITE}/api/users`));
    const response = await waiting;
    expect(response).toMatchObject({ url: `${SITE}/api/users`, status: 200, headers: { 'content-type': 'application/json' } });
    let read = false;
    const body = response.body().then((bytes) => {
      read = true;
      return bytes.toString();
    });
    await settle();
    expect(read).toBe(false);
    fake.emit('network.responseCompleted', started('users', `${SITE}/api/users`));
    await expect(body).resolves.toBe('[1,2,3]');
    expect(fake.commands('network.getData')[0]?.params).toEqual({ dataType: 'response', request: 'users', collector: 'collector-1' });
    expect(fake.commands('session.unsubscribe')).toHaveLength(1);
  });

  it('rejects a body read with the browser’s error when the load failed', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    await settle();
    fake.emit('network.responseStarted', { ...request('cut', `${SITE}/cut`, []), response: { url: `${SITE}/cut`, status: 200, headers: [] } });
    const response = await waiting;
    fake.emit('network.fetchError', { ...request('cut', `${SITE}/cut`, []), errorText: 'net::ERR_CONTENT_LENGTH_MISMATCH' });
    await expect(response.body()).rejects.toThrow('net::ERR_CONTENT_LENGTH_MISMATCH');
  });

  it('adds one response collector for concurrent waits', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    const first = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    const second = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    await settle();
    fake.emit('network.responseStarted', { ...request('r', `${SITE}/r`, []), response: { url: `${SITE}/r`, status: 200, headers: [] } });
    await Promise.all([first, second]);
    expect(fake.commands('network.addDataCollector')).toHaveLength(1);
    await net.bind('user-2');
    expect(fake.commands('network.removeDataCollector')).toHaveLength(1);
  });

  it('on a browser of its own, holds every tab with one intercept and lets another user context’s requests go untouched', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake, { holdAll: true, exclusive: true, ours: (context) => context !== 'foreign' });
    await net.bind('user-1');
    await net.addContext('tab-1');
    await net.addContext('tab-2');
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toEqual([{ phases: ['beforeRequestSent'] }]);
    fake.emit('network.beforeRequestSent', { ...request('popup', `${SITE}/popup`), context: 'popup' });
    fake.emit('network.beforeRequestSent', { ...request('foreign', `${SITE}/x`), context: 'foreign' });
    await settle();
    expect(fake.commands('network.continueRequest').map((command) => command.params)).toEqual([
      { request: 'popup', headers: [{ name: 'accept', value: { type: 'string', value: '*/*' } }, { name: 'x-preview', value: { type: 'string', value: 'token' } }] },
      { request: 'foreign' },
    ]);
  });

  it('decides a request an intercept it since replaced still holds', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake, { holdAll: true });
    await net.bind('user-1');
    await net.addContext('tab-1');
    await net.addContext('tab-2');
    fake.emit('network.beforeRequestSent', request('held', `${SITE}/held`, ['intercept-1']));
    await settle();
    expect(fake.commands('network.continueRequest').map((command) => command.params['request'])).toEqual(['held']);
  });

  it('answers a blank-served tab’s documents before any route, and fails its other requests', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    let routed = 0;
    await net.addRoute(route(() => true, async () => {
      routed += 1;
    }));
    const undo = await net.serveBlank('scratch');
    fake.emit('network.beforeRequestSent', { ...request('doc', `${SITE}/`), context: 'scratch', navigation: 'nav-1' });
    fake.emit('network.beforeRequestSent', { ...request('img', `${SITE}/a.png`), context: 'scratch' });
    await settle();
    expect(routed).toBe(0);
    expect(fake.commands('network.provideResponse').map((command) => command.params['request'])).toEqual(['doc']);
    expect(fake.commands('network.failRequest').map((command) => command.params['request'])).toEqual(['img']);
    await undo();
    fake.emit('network.beforeRequestSent', { ...request('later', `${SITE}/`), context: 'scratch', navigation: 'nav-2' });
    await settle();
    expect(routed).toBe(1);
  });
});
