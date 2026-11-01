/**
 * Launches a local browser, or attaches to a remote Chromium, and opens a
 * WebDriver BiDi session on it. Firefox speaks BiDi natively over a
 * WebSocket; Chromium speaks CDP, so the `chromium-bidi` mapper translates,
 * in a child process (`mapper-process.ts`). Local launches use the binaries
 * Playwright installed, so the two drivers compare one browser build.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { EngineError } from 'e2e/engine';
import { browserType } from '../browser-connection.ts';
import { headlessShellExecutable } from '../install.ts';
import { BidiConnection, webSocketTransport, type BidiTransport } from './connection.ts';
import { MAPPER_READY } from './mapper-process.ts';

/** The browsers the BiDi driver launches. WebKit has no BiDi endpoint yet. */
export type BidiBrowserName = 'chromium' | 'firefox';

/** One launched browser with its open BiDi session. */
export interface BidiBrowser {
  readonly name: BidiBrowserName;
  /** The browser's version, as the session reports it. */
  readonly version: string;
  readonly connection: BidiConnection;
  /** Ends the session; a launched browser's process is killed and its profile removed, an attached one is left running. */
  close(): Promise<void>;
}

export interface BidiLaunchOptions {
  readonly headed: boolean;
  readonly timeoutMs: number;
  /** Overrides the Playwright-installed binary. */
  readonly executablePath?: string;
  /** Firefox preferences for this launch, beside the driver's own. */
  readonly firefoxPrefs?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Chromium switches Playwright passes by default, kept here so both drivers
 * launch the same browser configuration.
 */
const CHROMIUM_ARGS = [
  '--disable-field-trial-config',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-back-forward-cache',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--allow-pre-commit-input',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--force-color-profile=srgb',
  '--metrics-recording-only',
  '--no-first-run',
  '--password-store=basic',
  '--use-mock-keychain',
  '--no-service-autorun',
  '--disable-search-engine-choice-screen',
  '--disable-infobars',
];

/** Firefox preferences beyond the Remote Agent's own recommended set, which it applies on start. */
const FIREFOX_PREFS: Readonly<Record<string, string | number | boolean>> = {
  'browser.shell.checkDefaultBrowser': false,
  'browser.tabs.warnOnClose': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'toolkit.telemetry.reportingpolicy.firstRun': false,
  'app.update.disabledForTesting': true,
  'dom.disable_open_during_load': false,
  // Wheel actions go through the path real wheels take, so a scroll shows on the next frame, as it does in Chromium.
  'remote.events.async.wheel.enabled': true,
};

/** Launches `name` and opens a BiDi session, bounded by `options.timeoutMs`. */
export async function launchBidiBrowser(name: BidiBrowserName, options: BidiLaunchOptions): Promise<BidiBrowser> {
  const profile = mkdtempSync(path.join(os.tmpdir(), `e2e-bidi-${name}-`));
  const child = name === 'firefox' ? spawnFirefox(profile, options) : spawnChromium(profile, options);
  const removeProfile = (): void => rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  try {
    const transport =
      name === 'firefox'
        ? await webSocketTransport(`${await endpointLine(child, FIREFOX_ENDPOINT, options.timeoutMs)}/session`, options.timeoutMs)
        : await chromiumMapper(endpointLine(child, CHROMIUM_ENDPOINT, options.timeoutMs), options.timeoutMs);
    const connection = new BidiConnection(transport);
    const version = await openSession(connection);
    return {
      name,
      version,
      connection,
      close: async () => {
        await Promise.race([
          connection.send('browser.close', {}).catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
        connection.close();
        await killed(child);
        removeProfile();
      },
    };
  } catch (cause) {
    await killed(child);
    removeProfile();
    if (cause instanceof EngineError) throw cause;
    throw new EngineError('ENGINE_FAILURE', `BiDi ${name} launch failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
      retryable: false,
      cause,
    });
  }
}

/**
 * Attaches to a running Chromium over CDP (a `ws://` DevTools URL, or the
 * `http://` endpoint that names one) through the mapper, the way a hosted
 * browser is reached. Closing ends the session and leaves the browser to its
 * host.
 */
export async function connectBidiOverCdp(endpoint: string, timeoutMs: number): Promise<BidiBrowser> {
  try {
    const transport = await chromiumMapper(webSocketDebuggerUrl(endpoint, timeoutMs), timeoutMs);
    const connection = new BidiConnection(transport);
    const version = await openSession(connection);
    return {
      name: 'chromium',
      version,
      connection,
      close: async () => {
        await Promise.race([connection.send('session.end', {}).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2_000))]);
        connection.close();
      },
    };
  } catch (cause) {
    if (cause instanceof EngineError) throw cause;
    throw new EngineError('ENGINE_FAILURE', `BiDi attach over CDP failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
      retryable: false,
      cause,
    });
  }
}

/** The browser-wide DevTools WebSocket URL of `endpoint`: as given for `ws(s)://`, read from `/json/version` for `http(s)://`. */
async function webSocketDebuggerUrl(endpoint: string, timeoutMs: number): Promise<string> {
  if (/^wss?:/i.test(endpoint)) return endpoint;
  const response = await fetch(new URL('/json/version', endpoint), { signal: AbortSignal.timeout(timeoutMs) });
  const version: unknown = await response.json();
  const url = typeof version === 'object' && version !== null ? Reflect.get(version, 'webSocketDebuggerUrl') : undefined;
  if (typeof url !== 'string') throw new Error(`${endpoint}/json/version names no webSocketDebuggerUrl`);
  return url;
}

/**
 * Opens the session and returns the browser's version. A user prompt stays
 * open for the driver to route (`browsingContext.userPromptOpened`), as
 * Playwright hands each dialog to its listener.
 */
async function openSession(connection: BidiConnection): Promise<string> {
  const session = await connection.send('session.new', {
    capabilities: { alwaysMatch: { acceptInsecureCerts: true, unhandledPromptBehavior: { default: 'ignore' } } },
  });
  return session.capabilities.browserVersion;
}

const FIREFOX_ENDPOINT = /WebDriver BiDi listening on (ws:\/\/\S+)/;
const CHROMIUM_ENDPOINT = /DevTools listening on (ws:\/\/\S+)/;

/** The binary to launch: the override, else the Playwright-installed build (headless shell for headless chromium). */
function executableFor(name: BidiBrowserName, options: BidiLaunchOptions): string {
  if (options.executablePath !== undefined) return options.executablePath;
  const full = browserType(name).executablePath();
  if (name === 'chromium' && !options.headed) return headlessShellExecutable(full) ?? full;
  return full;
}

function spawnFirefox(profile: string, options: BidiLaunchOptions): ChildProcess {
  const prefs = Object.entries({ ...FIREFOX_PREFS, ...options.firefoxPrefs }).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
  writeFileSync(path.join(profile, 'user.js'), `${prefs.join('\n')}\n`);
  const args = ['--remote-debugging-port=0', '--profile', profile, '-no-remote', ...(options.headed ? [] : ['--headless']), 'about:blank'];
  return spawn(executableFor('firefox', options), args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
}

function spawnChromium(profile: string, options: BidiLaunchOptions): ChildProcess {
  const args = [
    ...CHROMIUM_ARGS,
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    ...(options.headed ? [] : ['--headless', '--hide-scrollbars', '--mute-audio']),
    'about:blank',
  ];
  return spawn(executableFor('chromium', options), args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
}

/** Resolves with the endpoint the browser prints on stderr once it listens. */
function endpointLine(child: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`no endpoint within ${timeoutMs}ms`)), timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = pattern.exec(output);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      // Drained so a chatty browser never blocks on a full pipe.
      child.stderr?.removeAllListeners('data');
      child.stderr?.resume();
      resolve(match[1]);
    });
    child.once('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`browser exited with code ${String(code)} before listening: ${output.slice(-500)}`));
    });
  });
}

/** The mapper's entry point beside this module: the built `.js`, or the source when run from `src`. */
const MAPPER_ENTRY = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './mapper-process.ts' : './mapper-process.js', import.meta.url));

/**
 * Starts the `chromium-bidi` mapper in a child process at once, so it loads
 * while the browser starts, hands it `cdpUrl` when that resolves, and
 * returns the BiDi side of it, one JSON message per stdio line. Resolves
 * once the mapper serves.
 */
async function chromiumMapper(cdpUrl: Promise<string>, timeoutMs: number): Promise<BidiTransport> {
  const child = spawn(process.execPath, [MAPPER_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => {
    errors = `${errors}${chunk.toString()}`.slice(-2_000);
  });
  child.stdin.on('error', () => undefined);
  const closeHandlers: (() => void)[] = [];
  child.once('exit', () => {
    for (const handler of closeHandlers) handler();
  });
  let deliver: (message: string) => void = () => undefined;
  let url: string;
  try {
    url = await cdpUrl;
  } catch (cause) {
    child.kill('SIGKILL');
    throw cause;
  }
  child.stdin.write(`${url}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the chromium-bidi mapper did not start within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the chromium-bidi mapper exited with code ${String(code)}: ${errors.trim()}`));
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (line !== MAPPER_READY) {
        deliver(line);
        return;
      }
      clearTimeout(timer);
      resolve({
        send: (message) => {
          if (child.stdin.writable) child.stdin.write(`${message}\n`);
        },
        onMessage: (handler) => {
          deliver = handler;
        },
        onClose: (handler) => closeHandlers.push(handler),
        close: () => {
          child.stdin.end();
          setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
        },
      });
    });
  });
}

/** Kills the browser's process group and resolves once it exited. */
function killed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  });
}
