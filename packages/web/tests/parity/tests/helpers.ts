/** What the parity tests share: the server's two origins, inline pages, and which driver and browser run. */

import { test } from '@e2e-dev/web';

const port = Number(process.env['PARITY_PORT'] ?? 4311);

/** The app's origin, Playwright's `server.PREFIX`. */
export const PREFIX = `http://127.0.0.1:${port}`;

/** Another origin on the same server, Playwright's `server.CROSS_PROCESS_PREFIX`. */
export const CROSS = `http://localhost:${port}`;

/** The driver under test. */
export const driver = (process.env['E2E_WEB_DRIVER'] ?? 'playwright') as 'playwright' | 'bidi';

/** The browser under test. */
export const browserName = (process.env['BROWSER'] ?? 'chromium') as 'chromium' | 'firefox';

/** A path that serves `html` as a page, for Playwright's `page.setContent(html)`. */
export function content(html: string): string {
  return `/content?html=${Buffer.from(html).toString('base64url')}`;
}

/**
 * Skips the running test on the BiDi driver in `browser` (both when
 * omitted) for a gap of the browser or the protocol, never one of ours;
 * `reason` names it and links the upstream report.
 */
export function bidiGap(reason: string, browser?: 'chromium' | 'firefox'): void {
  test.skip(driver === 'bidi' && (browser === undefined || browser === browserName), reason);
}
