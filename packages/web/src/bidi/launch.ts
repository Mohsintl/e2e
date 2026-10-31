/**
 * Launches a local browser and opens a WebDriver BiDi session on it. Firefox
 * speaks BiDi natively over a WebSocket; Chromium speaks CDP, so the
 * `chromium-bidi` mapper runs in this process and translates. Both launch the
 * binaries Playwright installed, so the two drivers compare one browser build.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BidiServer } from 'chromium-bidi/out/Default/gen/src/bidiMapper/BidiMapper.js';
import { MapperCdpConnection } from 'chromium-bidi/out/Default/gen/src/cdp/CdpConnection.js';
import { EngineError } from 'e2e/engine';
import { browserType } from '../browser-connection.ts';
import { headlessShellExecutable } from '../install.ts';
import { BidiConnection, webSocketTransport, type BidiTransport } from './connection.ts';

/** The browsers the BiDi driver launches. WebKit has no BiDi endpoint yet. */
export type BidiBrowserName = 'chromium' | 'firefox';

/** One launched browser with its open BiDi session. */
export interface BidiBrowser {
  readonly name: BidiBrowserName;
  /** The browser's version, as the session reports it. */
  readonly version: string;
  readonly connection: BidiConnection;
  /** Ends the session, kills the process, and removes its profile. */
  close(): Promise<void>;
}

export interface BidiLaunchOptions {
  readonly headed: boolean;
  readonly timeoutMs: number;
  /** Overrides the Playwright-installed binary. */
  readonly executablePath?: string;
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
        : await chromiumMapper(await endpointLine(child, CHROMIUM_ENDPOINT, options.timeoutMs), options.timeoutMs);
    const connection = new BidiConnection(transport);
    // Dialogs nobody handles are dismissed, as Playwright dismisses a dialog with no listener.
    const session = await connection.send('session.new', {
      capabilities: { alwaysMatch: { acceptInsecureCerts: true, unhandledPromptBehavior: { default: 'dismiss', beforeUnload: 'accept' } } },
    });
    return {
      name,
      version: session.capabilities.browserVersion,
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
  const prefs = Object.entries(FIREFOX_PREFS).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
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

/**
 * Runs the `chromium-bidi` mapper in this process over a CDP WebSocket and
 * returns the BiDi side of it as a transport. The mapper takes parsed
 * commands and hands back parsed messages; the transport keeps the text
 * framing the connection expects.
 */
async function chromiumMapper(cdpUrl: string, timeoutMs: number): Promise<BidiTransport> {
  const cdp = await webSocketTransport(cdpUrl, timeoutMs);
  let deliver: (message: string) => void = () => undefined;
  const closeHandlers: (() => void)[] = [];
  const cdpConnection = new MapperCdpConnection({
    setOnMessage: (handler) => cdp.onMessage((message) => void handler(message)),
    sendMessage: (message) => cdp.send(message),
    close: () => cdp.close(),
  });
  const browserClient = await cdpConnection.createBrowserSession();
  let toMapper: (command: never) => void = () => undefined;
  const server = await BidiServer.createAndStart(
    {
      setOnMessage: (handler) => {
        toMapper = (command) => void handler(command);
      },
      sendMessage: (message) => deliver(JSON.stringify(message)),
      close: () => undefined,
    },
    cdpConnection,
    browserClient,
    '',
  );
  cdp.onClose(() => {
    for (const handler of closeHandlers) handler();
  });
  return {
    // oxlint-disable-next-line e2e/no-unchecked-json -- our own serialized command, handed to the mapper parsed
    send: (message) => toMapper(JSON.parse(message) as never),
    onMessage: (handler) => {
      deliver = handler;
    },
    onClose: (handler) => closeHandlers.push(handler),
    close: () => {
      server.close();
      cdpConnection.close();
    },
  };
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
