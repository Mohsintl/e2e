# WebDriver BiDi vs Playwright

Experimental BiDi driver for `@e2e-dev/web` (`web({ driver: 'bidi' })` or `E2E_WEB_DRIVER=bidi`), compared against the Playwright driver on the same machine, the same browser binaries and launch flags, and the same engine contract.

## Approach

- **Client:** a thin BiDi client of our own (`src/bidi/connection.ts`) over Node's built-in `WebSocket`, typed with `webdriver-bidi-protocol`. No WebdriverIO: its `webdriver` package wants a driver binary per browser and adds a session layer the engine does not need.
- **Firefox:** native BiDi (`--remote-debugging-port=0`, `ws://…/session`). No geckodriver.
- **Chromium:** the `chromium-bidi` mapper over CDP, in a child process (`mapper-process.ts`) as chromedriver hosts it. No chromedriver. It boots in parallel with Chrome. Remote endpoints (`connect`, worker-scoped providers) go through the same mapper.
- **Binaries and flags:** both drivers launch what Playwright installed (Chromium headless shell 156, Playwright's Firefox 157 build). Chromium gets Playwright's switches and disabled features; Firefox gets the profile prefs Playwright's own BiDi launcher writes.
- **Same contract:** `BidiSurface` implements the hooks `PlaywrightSurface` does and reads pages with the same in-page reader, so observations match. Locate runs the contract's reference resolver (`resolveExpression`) over node-mode reads, after an in-page superset prefilter (role, then accessible name; attributes; text), so the resolver stays the only judge.

## Mapping

| Playwright | WebDriver BiDi | Status |
| --- | --- | --- |
| `launch` | spawn + `session.new` (Chromium via the mapper) | done |
| `connectOverCDP`, browser providers | mapper over the remote CDP endpoint | done for `connect.cdpEndpoint` and provider scope `worker`; persistent context (`reconnectEndpoint`, scope `attempt`) not built |
| `newContext` / `close` | `browser.createUserContext` / `removeUserContext` | done |
| `newPage`, viewport | `browsingContext.create`, `setViewport` | done |
| `goto` / `reload` / `goBack` / `goForward` | `browsingContext.navigate` / `reload` / `traverseHistory` + `browsingContext.load` | done |
| `waitUntil: 'networkidle'` | no BiDi wait; built on `network.beforeRequestSent` / `responseCompleted` / `fetchError`: no request in flight for 500 ms | done |
| `evaluate`, element handles | `script.callFunction` with shared ids (nothing to dispose) | done |
| `addInitScript` (config and mid-test) | `script.addPreloadScript` per user context | done |
| locators | in-page reads + `resolveExpression`; CSS/XPath via `browsingContext.locateNodes` | done; Playwright selector syntax (`text=`, `>>`) not supported |
| `frameLocator`, frames in observations | `contentWindow` → child context; boxes shifted by the frame's | done |
| click / dblclick / hover / mouse / keyboard | `input.performActions` + in-page actionability check | done |
| drag (HTML5 `dataTransfer`) | Chromium: CDP `Input.setInterceptDrags` + `dispatchDragEvent` through `goog:cdp`, as Playwright's Chromium driver does | done on Chromium; Firefox gap (below) |
| `fill` | in-page `execCommand('insertText')`: one trusted edit, no key events, as Playwright's `insertText` | done |
| `setInputFiles`, file chooser | `input.setFiles`; `input.fileDialogOpened` for a control that opens one | done |
| `selectOption`, `check` | in-page, as Playwright does | done |
| `screenshot` + mask + caret | `browsingContext.captureScreenshot` + in-page overlay, every frame | done |
| `route`, `fulfill` / `continue` / `abort` / `fallback`, `postData` | `network.addIntercept` (scoped to the attempt's tabs), `provideResponse` / `continueRequest` / `failRequest`, request data collector | done |
| `waitForResponse`, `response.text()` | `network.responseCompleted` + response data collector + `network.getData` | done |
| `extraHTTPHeaders` (site-scoped) | intercept + `continueRequest` headers for the app's site | done |
| `httpCredentials` | `authRequired` intercept + `continueWithAuth` | done |
| dialogs | `browsingContext.userPromptOpened` + `handleUserPrompt`, through the shared `DialogRouter` | done |
| downloads | `browser.setDownloadBehavior` + `downloadWillBegin` / `downloadEnd` | done |
| `userAgent`, `locale`, `timezoneId` | `emulation.setUserAgentOverride` / `setLocaleOverride` (+ `accept-language`) / `setTimezoneOverride` | done |
| `colorScheme`, `reducedMotion`, `emulateMedia` | `emulation.setMediaFeaturesOverride` | Chromium done; Firefox: config values as launch prefs, `emulateMedia` mid-test waits on Firefox 159 |
| permissions | `permissions.setPermission` per origin | done |
| `storageState` | `storage.getCookies` / `setCookie` + localStorage via an intercepted blank page | done (no IndexedDB) |
| app log | `log.entryAdded`, `network.responseCompleted` / `fetchError` | done |
| video | Firefox: native `browsingContext.startScreencast` (VP8 webm). Chromium: the mapper lacks it, so CDP `Page.startScreencast` through `goog:cdp`, encoded to VP9 webm with Playwright's ffmpeg | done |
| WebKit | no BiDi endpoint in Safari | out of scope, `BidiBrowserName` keeps the seam |

## Correctness

Built packages, real CLI. Testbed: 83 tests; web benchmark `tests/`: 91 tests.

| Suite | PW chromium | BiDi chromium | PW firefox | BiDi firefox |
| --- | --- | --- | --- | --- |
| testbed | 82 pass, 1 skip | **82 pass, 1 skip** | 81 pass, 1 fail, 1 skip | 79 pass, 3 fail, 1 skip |
| web benchmark | 91 | **91** | 91 | 89, 2 fail |
| testbed over remote CDP (`connect`) | | 82 pass, 1 skip | | |

Every remaining failure, justified:

- **Playwright Firefox, raw mouse drag on the pad** (testbed): fails on `main` too (3 of 3 runs at 1d671f678); Firefox reports `y` 19 for a fractional box where Chromium reports 20. Not this branch.
- **BiDi Firefox, HTML5 drag and drop** (2 testbed, 2 benchmark): Firefox's remote agent ends the drag session on pointer up without synthesizing `drop` (its `EventUtils.js`: "TODO: This should synthesize drop"). `dragstart`, `dragenter`, `dragover` fire; `drop` and `dragend` never do. Same on stock Firefox 156, headed and headless, any move timing. Upstream: [bug 1515879](https://bugzilla.mozilla.org/show_bug.cgi?id=1515879) (NEW), fix path [bug 2051461](https://bugzilla.mozilla.org/show_bug.cgi?id=2051461) (ASSIGNED), [w3c/webdriver#1488](https://github.com/w3c/webdriver/issues/1488). Pointer-event drags (the kanban board) pass. A synthesized in-page `DragEvent` sequence would pass the tests with untrusted events, so it is left out.
- **BiDi Firefox, `browser.emulateMedia`** (1 testbed): Firefox 157 does not implement `emulation.setMediaFeaturesOverride`; `prefers-color-scheme` landed in Firefox 159 ([bug 2064354](https://bugzilla.mozilla.org/show_bug.cgi?id=2064354), meta [bug 2064352](https://bugzilla.mozilla.org/show_bug.cgi?id=2064352)). Configured `colorScheme` / `reducedMotion` apply as launch prefs; a mid-test change refuses with that reason.

## Methodology

- `node packages/web/bench/bidi.ts --iterations 20 --cold-iterations 10` after `pnpm build`. Raw numbers: `bidi-results.json`.
- Drives the built `web()` engine through its contract hooks (`init`, `startAttempt`, `session.open`, `observe`, `locate`, `perform`, `keyboard`, `artifacts.screenshot`), the calls the runner and the agent loop make. No test runner in the timings.
- Pages: the testbed app (`/forms`, `/scroll`, `/todos`) and a generated heavy page (1,500 table rows, ~9k elements), on localhost.
- Cold: a fresh engine per iteration (`init` launches the browser). Warm: one browser, scenarios repeated in table order; "new context + page" recreates the attempt each iteration.
- Agent flow: on `/todos`, observe, find a node in the tree, act, observe again: 3 adds (fill + tap), check one, final observe with pixels, goal checked.
- Memory: peak RSS of node plus every descendant during the warm loop (BiDi Chromium includes the mapper process). CPU: node `process.cpuUsage`, and node plus browser from `ps` (a floor: a renderer that exits between samples loses its last slice).
- Apple M5 Pro x15, 48 GB, macOS 27, Node 24.19.0, headless, 2026-11-01.

## Results

### chromium

| Scenario (ms) | playwright p50 / p95 / mean | bidi p50 / p95 / mean | BiDi vs PW (p50) |
| --- | --- | --- | --- |
| cold launch (init) | 57.5 / 66.3 / 58.8 | 79.9 / 87.6 / 81.7 | 1.39x |
| cold first page (startAttempt → open /forms → observe) | 49.7 / 60.1 / 50.9 | 48.7 / 53.8 / 49.4 | 0.98x |
| new context + page (startAttempt → first open) | 39.1 / 40.0 / 38.9 | 34.1 / 37.5 / 34.6 | 0.87x |
| navigate: testbed /forms | 7.3 / 7.6 / 7.4 | 6.8 / 7.1 / 6.7 | 0.93x |
| observe: testbed /forms | 10.3 / 11.2 / 10.5 | 7.7 / 8.4 / 7.8 | 0.75x |
| locate role+name: testbed /forms | 14.2 / 14.8 / 14.3 | 4.6 / 4.9 / 4.6 | 0.32x |
| click/type sequence: forms (5 actions) | 109 / 111 / 110 | 70.4 / 71.6 / 71.0 | 0.65x |
| screenshot: testbed /forms | 24.1 / 25.8 / 24.2 | 25.6 / 26.5 / 26.5 | 1.06x |
| navigate: testbed /scroll (8k px) | 3.9 / 4.1 / 4.0 | 4.0 / 4.3 / 4.1 | 1.02x |
| navigate: heavy page (9k elements) | 15.2 / 16.1 / 15.4 | 15.4 / 15.8 / 15.5 | 1.01x |
| observe: heavy page | 162 / 169 / 164 | 173 / 179 / 174 | 1.07x |
| observe + pixels: heavy page | 346 / 368 / 348 | 172 / 190 / 175 | 0.50x |
| locate role+name: heavy page | 194 / 214 / 197 | 123 / 127 / 122 | 0.63x |
| locate + fill + tap: heavy page | 75.3 / 81.9 / 75.5 | 30.8 / 41.6 / 32.8 | 0.41x |
| screenshot: heavy page | 36.2 / 36.7 / 36.2 | 57.9 / 63.8 / 58.2 | 1.60x |
| observe: /forms right after a heavy observation | 75.5 / 79.9 / 76.0 | 5.6 / 6.4 / 5.8 | 0.07x |
| agent flow: todos (10 observe/act steps) | 375 / 380 / 371 | 145 / 161 / 147 | 0.39x |
| peak RSS, node + browser (MB) | 1349 | 1525 | |
| node CPU, warm loop (s) | 17.4 | 1.2 | |
| node + browser CPU, warm loop (s, floor) | 49.8 | 21.2 | |

### firefox

| Scenario (ms) | playwright p50 / p95 / mean | bidi p50 / p95 / mean | BiDi vs PW (p50) |
| --- | --- | --- | --- |
| cold launch (init) | 312 / 341 / 315 | 914 / 949 / 920 | 2.93x |
| cold first page (startAttempt → open /forms → observe) | 485 / 529 / 490 | 143 / 152 / 145 | 0.29x |
| new context + page (startAttempt → first open) | 109 / 123 / 123 | 121 / 138 / 125 | 1.11x |
| navigate: testbed /forms | 17.4 / 19.5 / 18.4 | 13.1 / 25.3 / 15.0 | 0.75x |
| observe: testbed /forms | 12.8 / 22.3 / 14.7 | 11.3 / 12.3 / 11.4 | 0.88x |
| locate role+name: testbed /forms | 17.6 / 23.2 / 18.9 | 7.0 / 7.5 / 6.7 | 0.40x |
| click/type sequence: forms (5 actions) | 172 / 192 / 175 | 77.2 / 80.7 / 77.2 | 0.45x |
| screenshot: testbed /forms | 12.4 / 20.5 / 14.0 | 11.2 / 21.9 / 12.4 | 0.90x |
| navigate: testbed /scroll (8k px) | 6.9 / 8.2 / 7.0 | 7.7 / 9.0 / 8.0 | 1.12x |
| navigate: heavy page (9k elements) | 51.0 / 52.7 / 50.9 | 50.7 / 52.3 / 51.6 | 0.99x |
| observe: heavy page | 147 / 157 / 148 | 166 / 174 / 167 | 1.13x |
| observe + pixels: heavy page | 469 / 488 / 471 | 102 / 114 / 104 | 0.22x |
| locate role+name: heavy page | 176 / 189 / 179 | 131 / 147 / 133 | 0.74x |
| locate + fill + tap: heavy page | 93.3 / 103 / 93.3 | 53.5 / 57.6 / 53.7 | 0.57x |
| screenshot: heavy page | 26.8 / 30.7 / 27.4 | 18.7 / 20.6 / 19.4 | 0.70x |
| observe: /forms right after a heavy observation | 81.1 / 85.1 / 81.8 | 8.6 / 9.8 / 8.8 | 0.11x |
| agent flow: todos (10 observe/act steps) | 580 / 846 / 631 | 268 / 301 / 270 | 0.46x |
| peak RSS, node + browser (MB) | 2394 | 2805 | |
| node CPU, warm loop (s) | 17.3 | 2.0 | |
| node + browser CPU, warm loop (s, floor) | 73.6 | 33.2 | |

"observe: /forms right after a heavy observation" isolates a Playwright cost: the next observation releases the previous generation's ~3k element handles, one protocol call each. BiDi shared ids need no release. The Playwright agent flow follows that row, so part of its gap is the same cost (268 ms p50 in an earlier ordering, 375 ms here; BiDi 145 ms both times).

## What changed since the first pass, and why

- **Locate on heavy pages: 3.5-4.7x slower → 1.3-2.4x faster.** The reader gained batched `roles`, `names`, and `nodes` modes (one setup per locate instead of per element), and the page prefilters candidates by role, name, attribute, and text as a superset before node reads.
- **Mapper unhandled rejection:** `CdpTargetManager` fires `Target.setAutoAttach` for tab targets in a `void (async () => …)()` with no catch; a tab closing mid-attach leaks a `CloseError` into whatever process hosts the mapper. It cannot be contained in-process without a global handler that would also swallow the harness's own reporting, so the mapper now runs in a child process that logs and survives it. Cost: cold launch 67 → 80 ms (it boots while Chrome starts); warm operations unchanged; worker node CPU 6.2 → 1.2 s.
- **Chromium memory:** the driver had launched with a startup tab (an extra renderer). With `--no-startup-window` and Playwright's disabled features, the browser holds 460 MB vs Playwright's 470 MB on the heavy page.
- **Firefox cold launch (~0.9 s vs 0.3 s):** Firefox's Remote Agent holds `session.new` until browser startup finishes (~800 ms after spawn: called 800 ms late it returns in 4 ms); Juggler does not wait. Startup prefs and a pre-warmed profile copy changed nothing. Paid once per worker.
- **Firefox memory (+150-180 MB):** one more content process than Juggler, for the startup window the Remote Agent opens (2 content processes before any attempt). Closing that window would quit Firefox on Linux and Windows, so it stays.
- **Shared remote browser:** intercepts are scoped to the attempt's tabs and prompts to its contexts; with several workers on one browser, global intercepts would hold other sessions' requests.

## Verdict

**Faster on BiDi:**

- The agent loop is 2.2-2.6x faster.
- Observing with pixels is 2-4.6x faster.
- Locate is faster on small and heavy pages.
- Locate plus actions is 1.7-2.4x faster.
- Node CPU in the warm loop is 9-15x lower.

**Slower or heavier on BiDi:**

- Firefox cold launch is about 3x slower, inherent to the Remote Agent and paid once per worker.
- Chromium cold launch is +22 ms (the mapper process).
- Chromium full-viewport screenshots of the heavy page are 1.6x slower.
- Firefox uses +150-180 MB.

**Worth switching?** On Chromium, plausibly: parity on both suites, including remote CDP, video, routing, and frames, with the agent loop at more than twice the speed. Not yet the default, because:

- the persistent remote context mode is not built;
- the driver has run only on this machine and CI has not exercised it;
- Firefox waits on two upstream items (HTML5 drag-and-drop, media emulation in 159).

Next steps: put BiDi Chromium in CI beside Playwright, build the persistent context mode, then decide on the default.
