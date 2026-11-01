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
| `goto` / `reload` / `goBack` / `goForward` | `browsingContext.navigate` / `reload` / `traverseHistory`, landed when the document reads complete on another history entry (same-URL `pushState` entries included) | done |
| `waitUntil: 'networkidle'` | no BiDi wait; built on `network.beforeRequestSent` / `responseCompleted` / `fetchError`: no request of the test's tab in flight for 500 ms | done |
| `evaluate`, element handles | `script.callFunction` with shared ids (nothing to dispose) | done |
| `addInitScript` (config and mid-test) | `script.addPreloadScript` per user context | done |
| locators | in-page reads + `resolveExpression` (labels and display values as Playwright reads them); CSS per open shadow root, XPath via `browsingContext.locateNodes` | done; Playwright selector syntax (`text=`, `>>`) and CSS combinators across a shadow root not supported |
| `frameLocator`, frames in observations | `contentWindow` → child context; boxes and pointer points mapped through each frame's offset and scale | done; rotated or mirrored frames refused for pointer actions |
| click / dblclick / hover / mouse / keyboard | `input.performActions` + in-page actionability (visible, enabled, stable, clipped by scroll containers, hit-tested through every frame); held modifiers tracked per tab | done |
| drag (HTML5 `dataTransfer`) | Chromium: CDP `Input.setInterceptDrags` + `dispatchDragEvent` through `goog:cdp`, as Playwright's Chromium driver does | done on Chromium; Firefox gap (below) |
| `fill` | in-page `execCommand('insertText')`: one trusted edit, no key events, as Playwright's `insertText` | done |
| `setInputFiles`, file chooser | `input.setFiles`; `input.fileDialogOpened` for a control that opens one | done |
| `selectOption`, `check` | in-page, as Playwright does | done |
| `screenshot` + mask + caret | `browsingContext.captureScreenshot` + in-page boxes in closed shadow roots (inside each top-layer element, or in a manual popover), verified to cover every field after capture | done |
| `route`, `fulfill` / `continue` / `abort` / `fallback`, `postData` | `network.addIntercept` (scoped to the attempt's tabs), `provideResponse` / `continueRequest` / `failRequest`, request data collector | done |
| `waitForResponse`, `response.text()` | `network.responseStarted` (headers) + the attempt's response collector; the body after `responseCompleted` / `fetchError` | done |
| `extraHTTPHeaders` (site-scoped) | intercept + `continueRequest` headers for the app's site | done |
| `httpCredentials` | `authRequired` intercept + `continueWithAuth` | done |
| dialogs | `browsingContext.userPromptOpened` + `handleUserPrompt`, through the shared `DialogRouter` | done |
| downloads | `browser.setDownloadBehavior` + `downloadWillBegin` / `downloadEnd` | done |
| `userAgent`, `locale`, `timezoneId` | `emulation.setUserAgentOverride` / `setLocaleOverride` (+ `accept-language`) / `setTimezoneOverride` | done |
| `colorScheme`, `reducedMotion`, `emulateMedia` | `emulation.setMediaFeaturesOverride` | Chromium done; Firefox: config values as launch prefs, `emulateMedia` mid-test waits on Firefox 159 |
| permissions | `permissions.setPermission` per origin | done |
| `storageState` | `storage.getCookies` / `setCookie` + localStorage and IndexedDB of every visited origin, read and written in a scratch tab on a blank page the network serves | done (IndexedDB values JSON or `Date`) |
| app log | `log.entryAdded`, `network.responseCompleted` / `fetchError` | done |
| video | Firefox: native `browsingContext.startScreencast` (VP8 webm). Chromium: the mapper lacks it, so CDP `Page.startScreencast` through `goog:cdp`, encoded to VP9 webm with Playwright's ffmpeg | done |
| WebKit | no BiDi endpoint in Safari | out of scope, `BidiBrowserName` keeps the seam |

## Correctness

Built packages, real CLI, after the last review round (c6fcde8f8). Testbed: 83 tests; web benchmark `tests/`: 91 tests.

| Suite | PW chromium | BiDi chromium | PW firefox | BiDi firefox |
| --- | --- | --- | --- | --- |
| testbed | 82 pass, 1 skip | **82 pass, 1 skip** | 81 pass, 1 fail, 1 skip | 79 pass, 1 skip (3 left out, below) |
| web benchmark | 91 | **91** | 91 | 89, 2 fail |

CI runs the BiDi testbed on Chromium and Firefox in the spec gate (`.github/workflows/spec.yml`, job `bidi`), Firefox with the three tests below left out.

Every remaining failure, justified:

- **Playwright Firefox, raw mouse drag on the pad** (testbed): fails on `main` too (3 of 3 runs at 1d671f678); Firefox reports `y` 19 for a fractional box where Chromium reports 20. Not this branch.
- **BiDi Firefox, HTML5 drag and drop** (2 testbed, 2 benchmark): Firefox's remote agent ends the drag session on pointer up without synthesizing `drop` (its `EventUtils.js`: "TODO: This should synthesize drop"). `dragstart`, `dragenter`, `dragover` fire; `drop` and `dragend` never do. Same on stock Firefox 156, headed and headless, any move timing. Upstream: [bug 1515879](https://bugzilla.mozilla.org/show_bug.cgi?id=1515879) (NEW), fix path [bug 2051461](https://bugzilla.mozilla.org/show_bug.cgi?id=2051461) (ASSIGNED), [w3c/webdriver#1488](https://github.com/w3c/webdriver/issues/1488). Pointer-event drags (the kanban board) pass. A synthesized in-page `DragEvent` sequence would pass the tests with untrusted events, so it is left out.
- **BiDi Firefox, `browser.emulateMedia`** (1 testbed): Firefox 157 does not implement `emulation.setMediaFeaturesOverride`; `prefers-color-scheme` landed in Firefox 159 ([bug 2064354](https://bugzilla.mozilla.org/show_bug.cgi?id=2064354), meta [bug 2064352](https://bugzilla.mozilla.org/show_bug.cgi?id=2064352)). Configured `colorScheme` / `reducedMotion` apply as launch prefs; a mid-test change refuses with that reason.

## Methodology

- `node packages/web/bench/bidi.ts --iterations 20 --cold-iterations 10 --testbed-runs 3` after `pnpm build`. Raw numbers go to `bench/bidi-results.json` (gitignored).
- Drives the built `web()` engine through its contract hooks (`init`, `startAttempt`, `session.open`, `observe`, `locate`, `perform`, `keyboard`, `artifacts.screenshot`), the calls the runner and the agent loop make. No test runner in the scenario timings.
- Pages: the testbed app (`/forms`, `/scroll`, `/todos`) and a generated heavy page (1,500 table rows, ~9k elements), on localhost.
- Drivers interleave: cold iterations alternate driver order, warm iterations run in blocks of 5 per driver in alternating order, testbed runs alternate. A drift of the machine lands on both.
- Each ratio carries a bootstrap 95% interval (2,000 resamples, fixed seed).
- Equal work: every iteration's observed node counts of `/forms` and the heavy page must match across drivers, and every pixel observation must return pixels, or the run fails without a report.
- Agent flow: on `/todos`, open the page, then observe, find a node in the tree, and act, 7 times (3 fills, 3 taps on Add, 1 checkbox), with a final observation with pixels and the goal checked. Attempt setup is outside the timing.
- Memory: peak RSS of node plus every descendant during the warm loop (BiDi Chromium includes the mapper process). CPU: node `process.cpuUsage`, and node plus browser from `ps` (a floor: a renderer that exits between samples loses its last slice).
- Apple M5 Pro x15, 48 GB, macOS 27, Node 24.19.0, headless, 2026-11-01.

## Results

### chromium

| Scenario (ms) | playwright p50 / p95 / mean | bidi p50 / p95 / mean | BiDi vs PW (p50, 95% CI) |
| --- | --- | --- | --- |
| cold launch (init) | 58.1 / 66.5 / 60.0 | 79.8 / 88.1 / 80.6 | 1.37x (1.28-1.40) |
| cold first page (startAttempt → open /forms → observe) | 49.8 / 59.3 / 51.0 | 48.2 / 50.0 / 48.7 | 0.97x (0.94-0.99) |
| new context + page (startAttempt → first open) | 38.9 / 41.2 / 38.5 | 34.8 / 39.0 / 35.7 | 0.89x (0.86-0.93) |
| navigate: testbed /forms | 7.4 / 7.6 / 7.4 | 6.6 / 6.9 / 6.5 | 0.90x (0.87-0.93) |
| observe: testbed /forms | 10.3 / 10.9 / 10.4 | 7.8 / 8.4 / 7.9 | 0.75x (0.74-0.76) |
| locate role+name: testbed /forms | 14.4 / 15.7 / 14.4 | 4.7 / 6.1 / 5.0 | 0.33x (0.32-0.33) |
| click/type sequence: forms (5 actions) | 108 / 125 / 111 | 71.3 / 88.0 / 75.6 | 0.66x (0.65-0.67) |
| screenshot: testbed /forms | 24.4 / 25.5 / 24.5 | 25.3 / 41.6 / 29.3 | 1.04x (1.03-1.05) |
| navigate: testbed /scroll (8k px) | 3.9 / 4.2 / 3.9 | 4.1 / 4.7 / 4.2 | 1.06x (1.04-1.08) |
| navigate: heavy page (9k elements) | 15.1 / 15.6 / 15.2 | 15.3 / 15.6 / 15.3 | 1.01x (1.00-1.02) |
| observe: heavy page | 162 / 167 / 163 | 173 / 175 / 173 | 1.07x (1.05-1.07) |
| observe + pixels: heavy page | 350 / 370 / 353 | 110 / 114 / 110 | 0.31x (0.31-0.32) |
| locate role+name: heavy page | 192 / 222 / 196 | 103 / 106 / 103 | 0.54x (0.53-0.55) |
| locate + fill + tap: heavy page | 74.3 / 83.5 / 75.1 | 39.2 / 44.2 / 38.9 | 0.53x (0.48-0.56) |
| screenshot: heavy page | 36.1 / 36.5 / 36.0 | 53.9 / 55.4 / 53.9 | 1.49x (1.48-1.51) |
| observe: /forms right after a heavy observation | 76.6 / 78.6 / 76.5 | 5.5 / 5.7 / 5.6 | 0.07x (0.07-0.07) |
| agent flow: todos (open, 7 actions, 8 observations) | 257 / 274 / 263 | 192 / 193 / 192 | 0.75x (0.70-0.75) |
| peak RSS, node + browser (MB) | 1371 | 1503 | |
| node CPU, warm loop (s) | 17.6 | 1.3 | |
| node + browser CPU, warm loop (s, floor) | 49.9 | 20.1 | |

### firefox

| Scenario (ms) | playwright p50 / p95 / mean | bidi p50 / p95 / mean | BiDi vs PW (p50, 95% CI) |
| --- | --- | --- | --- |
| cold launch (init) | 310 / 334 / 314 | 912 / 939 / 914 | 2.94x (2.84-2.99) |
| cold first page (startAttempt → open /forms → observe) | 485 / 494 / 485 | 152 / 170 / 153 | 0.31x (0.30-0.32) |
| new context + page (startAttempt → first open) | 110 / 313 / 150 | 126 / 141 / 130 | 1.15x (1.10-1.26) |
| navigate: testbed /forms | 17.5 / 48.6 / 20.5 | 13.9 / 23.2 / 16.3 | 0.79x (0.76-1.08) |
| observe: testbed /forms | 12.1 / 47.5 / 17.8 | 12.3 / 36.7 / 15.8 | 1.02x (0.88-1.05) |
| locate role+name: testbed /forms | 17.8 / 24.2 / 18.9 | 6.8 / 7.9 / 6.1 | 0.38x (0.23-0.43) |
| click/type sequence: forms (5 actions) | 172 / 266 / 188 | 79.5 / 92.0 / 82.7 | 0.46x (0.44-0.52) |
| screenshot: testbed /forms | 12.5 / 19.3 / 14.1 | 11.8 / 17.5 / 13.2 | 0.95x (0.83-1.02) |
| navigate: testbed /scroll (8k px) | 6.4 / 6.9 / 6.5 | 7.8 / 8.9 / 8.1 | 1.21x (1.16-1.33) |
| navigate: heavy page (9k elements) | 50.1 / 51.3 / 50.3 | 50.9 / 53.6 / 51.5 | 1.02x (1.01-1.04) |
| observe: heavy page | 146 / 154 / 148 | 166 / 179 / 168 | 1.14x (1.11-1.16) |
| observe + pixels: heavy page | 476 / 491 / 477 | 105 / 111 / 104 | 0.22x (0.21-0.22) |
| locate role+name: heavy page | 175 / 209 / 180 | 111 / 115 / 111 | 0.63x (0.62-0.64) |
| locate + fill + tap: heavy page | 93.6 / 108 / 94.3 | 52.2 / 58.8 / 52.9 | 0.56x (0.53-0.62) |
| screenshot: heavy page | 26.7 / 28.1 / 26.9 | 21.6 / 29.3 / 22.8 | 0.81x (0.77-0.83) |
| observe: /forms right after a heavy observation | 83.0 / 85.3 / 83.0 | 8.4 / 9.1 / 8.5 | 0.10x (0.10-0.10) |
| agent flow: todos (open, 7 actions, 8 observations) | 418 / 438 / 421 | 275 / 298 / 276 | 0.66x (0.63-0.68) |
| peak RSS, node + browser (MB) | 2327 | 2579 | |
| node CPU, warm loop (s) | 17.7 | 2.1 | |
| node + browser CPU, warm loop (s, floor) | 77.0 | 32.9 | |

"observe: /forms right after a heavy observation" isolates a Playwright cost: the next observation releases the previous generation's ~3k element handles, one protocol call each. BiDi shared ids need no release. The agent flow no longer follows that row's release directly (attempt setup now sits between them, untimed), so its gap is the steady per-step cost.

## Totals

| Total | playwright chromium | bidi chromium | playwright firefox | bidi firefox | BiDi vs PW chromium | BiDi vs PW firefox |
| --- | --- | --- | --- | --- | --- | --- |
| sum of p50s, every scenario (ms) | 1479 | 974 | 2611 | 2112 | -34% | -19% |
| sum of means, every scenario (ms) | 1499 | 985 | 2696 | 2133 | -34% | -21% |
| realistic test: cold launch + new page + 6 agent steps (ms) | 311 | 273 | 762 | 1262 | -12% | +65% |
| testbed wall clock, median of 3 (ms) | 17563 | 16885 | 21120 | 21036 | -4% | -0% |
| node CPU, warm loop (s) | 17.6 | 1.3 | 17.7 | 2.1 | -93% | -88% |
| node + browser CPU, warm loop (s, floor) | 49.9 | 20.1 | 77.0 | 32.9 | -60% | -57% |
| peak RSS, node + browser (MB) | 1371 | 1503 | 2327 | 2579 | +10% | +11% |

- **Sum of p50s / means:** every scenario of the tables above added up, cold rows included.
- **Realistic test:** one cold launch, one new context and page, and N agent steps, with N = 6: the testbed averages 6.25 steps per test (79 tests, `.e2e/report.json`, median 5). An agent step is the agent flow's p50, less one navigation, over its 7 actions (each with the observation before it). Firefox's BiDi cold launch (~0.9 s, inherent to the Remote Agent, below) dominates its row: it is paid once per worker, not per test.
- **Testbed wall clock:** the whole testbed through the CLI, same machine, the testbed's own concurrency, median of 3 interleaved runs per driver. All 12 runs passed; on Firefox both drivers leave out the same 4 tests (BiDi's 3 upstream gaps and the pad drag Playwright's Firefox fails on main).
- **Overall:** on Chromium BiDi is 34% faster summed over scenarios, 12% faster on a realistic test, and 4% faster on the whole testbed, with 93% less node CPU and 10% more memory. On Firefox it is 19-21% faster summed over scenarios and level on the testbed, but 65% slower on a single realistic test because of the cold launch, with 11% more memory.

## What changed since the first pass, and why

- **Locate on heavy pages: 3.5-4.7x slower → 1.3-2.4x faster.** The reader gained batched `roles`, `names`, and `nodes` modes (one setup per locate instead of per element), and the page prefilters candidates by role, name, attribute, and text as a superset before node reads.
- **Mapper unhandled rejection:** `CdpTargetManager` fires `Target.setAutoAttach` for tab targets in a `void (async () => …)()` with no catch; a tab closing mid-attach leaks a `CloseError` into whatever process hosts the mapper. It cannot be contained in-process without a global handler that would also swallow the harness's own reporting, so the mapper now runs in a child process that logs and survives it. Cost: cold launch 67 → 80 ms (it boots while Chrome starts); warm operations unchanged; worker node CPU 6.2 → 1.2 s.
- **Chromium memory:** the driver had launched with a startup tab (an extra renderer). With `--no-startup-window` and Playwright's disabled features, the browser holds 460 MB vs Playwright's 470 MB on the heavy page.
- **Firefox cold launch (~0.9 s vs 0.3 s):** Firefox's Remote Agent holds `session.new` until browser startup finishes (~800 ms after spawn: called 800 ms late it returns in 4 ms); Juggler does not wait. Startup prefs and a pre-warmed profile copy changed nothing. Paid once per worker.
- **Firefox memory (+150-180 MB):** one more content process than Juggler, for the startup window the Remote Agent opens (2 content processes before any attempt). Closing that window would quit Firefox on Linux and Windows, so it stays.
- **Shared remote browser:** intercepts are scoped to the attempt's tabs and prompts to its contexts; with several workers on one browser, global intercepts would hold other sessions' requests.

## Review rounds

Six rounds of line-by-line review of the full diff (an independent reviewer model, read-only), each fixed in focused commits before the next:

| Round | Critical | Important | Nit | Resolution |
| --- | --- | --- | --- | --- |
| 1 | 38 | 15 | 1 | all fixed; 2 partly resolved by justification (intercept scope when attached over CDP, no main-vs-branch run for a same-build driver comparison) |
| 2 | 2 | 24 | 2 | all fixed |
| 3 | 0 | 15 | 1 | all fixed |
| 4 | 0 | 10 | 3 | all fixed |
| 5 | 0 | 6 | 0 | all fixed |
| 6 | 1 | 4 | 0 | all fixed and verified in both browsers; the cap of 6 rounds left no seventh review of these fixes |

What the rounds changed most: screenshot masking fails closed (top layer, page CSS, scaled dialogs, coverage proven after capture); retry safety (`ACTION_MAY_HAVE_COMMITTED` after any dispatch, cancellation checked before every dispatch); ownership of every browser-side resource (launches, user contexts, intercepts, collectors, preload scripts, ffmpeg, scratch tabs) through cancellation and cleanup; saved sessions with every origin's localStorage and IndexedDB; locator parity (labels, display values, shadow roots, frames, transforms).

## Verdict

**Faster on BiDi:**

- The agent step is 1.3-1.5x faster (agent flow p50 0.66-0.75x).
- Observing with pixels is 3.2-4.5x faster.
- Locate is 1.6-3x faster on small and heavy pages; locate plus actions about 1.8-1.9x.
- Summed over every scenario, 34% (Chromium) and 19% (Firefox) less time.
- Node CPU in the warm loop is 8-14x lower.

**Slower or heavier on BiDi:**

- Firefox cold launch is about 3x slower (912 vs 310 ms), inherent to the Remote Agent and paid once per worker.
- Chromium cold launch is +22 ms (the mapper process).
- Chromium full-viewport screenshots of the heavy page are 1.5x slower.
- 10-11% more peak memory.

**Worth switching?** On Chromium, plausibly: parity on both suites, a CI gate on the testbed, and a faster agent loop and testbed. Not yet the default, because:

- the persistent remote context mode is not built;
- a few documented limits remain (Playwright selector chains, CSS combinators across shadow roots, rotated or mirrored frames);
- Firefox waits on two upstream items (HTML5 drag-and-drop, media emulation in 159).

Next steps: run BiDi Chromium beside Playwright in CI for a while, build the persistent context mode, then decide on the default.
