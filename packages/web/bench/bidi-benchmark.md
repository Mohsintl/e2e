# WebDriver BiDi vs Playwright

Experimental BiDi driver for `@e2e-dev/web` (`web({ driver: 'bidi' })` or `E2E_WEB_DRIVER=bidi`), benchmarked against the Playwright driver on the same machine, same browser binaries, same engine contract.

## Approach

- **Client:** own thin BiDi client (`src/bidi/connection.ts`, ~150 lines) over Node's built-in `WebSocket`, typed with `webdriver-bidi-protocol`. No WebdriverIO: its `webdriver` package wants a driver binary per browser and adds a session layer the engine does not need.
- **Firefox:** native BiDi (`--remote-debugging-port=0`, `ws://…/session`). No geckodriver.
- **Chromium:** `chromium-bidi` mapper run in-process over a CDP WebSocket, the way Puppeteer does. No chromedriver.
- **Binaries:** both drivers launch what Playwright installed (Chromium headless shell 156, Playwright's Firefox 157 build, which also speaks BiDi). Chromium flags mirror Playwright's defaults.
- **Same contract:** `BidiSurface` implements the hooks `PlaywrightSurface` does and reads pages with the same in-page reader (`in-page/read-semantics.ts`), so the observation tree is identical. Locate runs the contract's reference resolver (`resolveExpression`) over node-mode reads.

## Mapping

| Playwright use | BiDi equivalent | Status |
| --- | --- | --- |
| `chromium/firefox.launch` | spawn + `session.new` (mapper for Chromium) | done |
| `browser.newContext` / `context.close` | `browser.createUserContext` / `removeUserContext` | done |
| `context.newPage`, viewport | `browsingContext.create`, `setViewport` | done |
| `page.goto/reload/goBack/goForward` | `browsingContext.navigate/reload/traverseHistory` + `browsingContext.load` | done |
| `page.evaluate`, element handles | `script.callFunction` with shared ids (no handle disposal) | done |
| `addInitScript` (closed shadow roots, config init scripts) | `script.addPreloadScript` per user context | done (config only; `browser.addInitScript` mid-test not yet) |
| locators (`getByRole`, `getByText`, ..., `e2e-*` engines) | in-page node reads + `resolveExpression`; CSS/XPath via `browsingContext.locateNodes` | done; Playwright selector syntax (`text=`, `>>`) not supported |
| `click/dblclick/hover/dragTo`, `mouse.*` | `input.performActions` pointer source + in-page actionability check | done |
| `fill` | in-page select + `execCommand('insertText')` (one trusted edit, no key events, as Playwright's `insertText`) | done |
| `keyboard.type/press/down/up` | `input.performActions` key source | done |
| `mouse.wheel` | wheel source | done |
| `setInputFiles` | `input.setFiles` | file input/label only; chooser-opening buttons not yet (`input.fileDialogOpened`) |
| `selectOption`, `check` | in-page, as Playwright does | done |
| `page.screenshot` + mask + caret | `browsingContext.captureScreenshot` + in-page overlay | done |
| `storageState` save/restore | `storage.getCookies/setCookie` + localStorage via `network.addIntercept`/`provideResponse` | done (no IndexedDB) |
| cookies | `storage.*` | done |
| console / errors / failed requests (app log) | `log.entryAdded`, `network.responseCompleted/fetchError` | done |
| dialogs | `unhandledPromptBehavior: dismiss` | auto-dismiss only; `browser.onDialog` not yet (`browsingContext.userPromptOpened/handleUserPrompt`) |
| `route`, `waitForResponse` | `network.addIntercept`, `continueRequest/provideResponse`, `addDataCollector` + `getData` | not yet |
| frames (`frameLocator`, frame stitching in observations) | `browsingContext.getTree` children + per-context calls | not yet; iframes stay boundary nodes, observation marked truncated |
| downloads | `browser.setDownloadBehavior`, `browsingContext.downloadWillBegin/End` | not yet |
| `emulateMedia`, locale, timezone, userAgent | `emulation.*` (partial support across browsers) | not yet, refused at config load |
| `extraHTTPHeaders`, `httpCredentials` | `network.setExtraHeaders`, `authRequired` intercept + `continueWithAuth` | not yet, refused at config load |
| permissions | `permissions.setPermission` | not yet |
| video (CDP screencast) | **no BiDi equivalent** | gap |
| `waitUntil: 'networkidle'` | **no BiDi equivalent** | refused |
| CDP attach (`connect`), browser providers | BiDi needs a BiDi endpoint, hosted browsers serve CDP | gap |
| WebKit | no BiDi endpoint in Safari yet | out of scope, `BidiBrowserName` keeps the seam |

Known issues: Firefox does not start an HTML5 drag-and-drop session from BiDi pointer actions (2 testbed drag tests fail). The in-process `chromium-bidi` mapper can leak an unhandled rejection when a tab closes while a target is attaching (seen once per testbed run); chromedriver avoids this by running the mapper in its own process.

## Correctness: testbed suite (83 tests)

| Driver | chromium | firefox |
| --- | --- | --- |
| Playwright | 82 pass, 1 skip | 81 pass, 1 fail (raw mouse drag on the pad), 1 skip |
| BiDi | 66 pass, 16 fail, 1 skip | 63 pass, 19 fail, 1 skip |

Every BiDi chromium failure is a "not yet" row above (route, waitForResponse, onDialog, downloads, frames, addInitScript, emulateMedia, chooser upload). Firefox adds the 2 drag-and-drop tests and `scrollUntilVisible` on a node (a wheel over a scrollable node did not move it in Firefox; not investigated yet).

## Methodology

- `node packages/web/bench/bidi.ts --iterations 20 --cold-iterations 10` after `pnpm build`. Raw numbers: `bidi-results.json`.
- Drives the built `web()` engine through its contract hooks (`init`, `startAttempt`, `session.open`, `observe`, `locate`, `perform`, `keyboard`, `artifacts.screenshot`), the calls the runner and the agent loop make. No test runner overhead.
- Pages: the testbed app (`/forms`, `/scroll`, `/todos`) and a generated heavy page (1,500 table rows, ~9k elements), all on localhost.
- Cold: a fresh engine per iteration (`init` launches the browser). Warm: one browser, scenarios repeated; "new context + page" recreates the attempt each iteration.
- Agent flow: on `/todos`, observe, find a node in the tree, act, observe again: 3 adds (fill + tap), check one, final observe with pixels, goal checked.
- Memory: peak RSS of node plus every descendant, sampled during the warm loop. CPU: node `process.cpuUsage`, and node plus browser processes from `ps` (a floor: renderers that exit between samples lose their last slice).
- Apple M5 Pro x15, 48 GB, macOS 27, Node v24.19.0, headless, 2026-11-01.

## Results

### chromium

| Scenario (ms) | playwright p50 / p95 / mean | bidi p50 / p95 / mean | BiDi vs PW (p50) |
| --- | --- | --- | --- |
| cold launch (init) | 59.8 / 74.9 / 61.9 | 66.8 / 74.4 / 67.6 | 1.12x |
| cold first page (startAttempt → open /forms → observe) | 50.6 / 61.8 / 51.9 | 44.8 / 45.9 / 44.8 | 0.89x |
| new context + page (startAttempt → first open) | 39.7 / 46.9 / 40.2 | 33.0 / 35.2 / 33.6 | 0.83x |
| navigate: testbed /forms | 7.3 / 8.1 / 7.5 | 6.7 / 7.1 / 6.6 | 0.91x |
| observe: testbed /forms | 10.4 / 11.6 / 10.6 | 7.3 / 7.7 / 7.3 | 0.70x |
| locate role+name: testbed /forms | 14.3 / 16.4 / 14.6 | 5.0 / 5.6 / 5.1 | 0.35x |
| click/type sequence: forms (5 actions) | 109 / 122 / 111 | 54.0 / 55.0 / 53.9 | 0.50x |
| screenshot: testbed /forms | 24.3 / 25.9 / 24.3 | 41.5 / 43.0 / 41.6 | 1.71x |
| navigate: testbed /scroll (8k px) | 3.9 / 4.2 / 3.9 | 3.9 / 4.4 / 4.0 | 1.01x |
| navigate: heavy page (9k elements) | 15.1 / 16.3 / 15.3 | 15.2 / 16.3 / 15.4 | 1.01x |
| observe: heavy page | 161 / 164 / 161 | 169 / 171 / 169 | 1.05x |
| observe + pixels: heavy page | 348 / 368 / 350 | 159 / 161 / 159 | 0.46x |
| locate role+name: heavy page | 191 / 202 / 194 | 677 / 692 / 679 | 3.54x |
| locate + fill + tap: heavy page | 74.4 / 82.9 / 74.5 | 427 / 433 / 427 | 5.74x |
| screenshot: heavy page | 36.4 / 53.6 / 39.0 | 64.5 / 69.8 / 64.1 | 1.77x |
| observe: /forms right after a heavy observation | 74.7 / 78.5 / 75.1 | 5.3 / 8.7 / 6.4 | 0.07x |
| agent flow: todos (10 observe/act steps) | 374 / 387 / 370 | 146 / 148 / 146 | 0.39x |
| peak RSS, node + browser (MB) | 1419 | 1786 | |
| node CPU, warm loop (s) | 17.1 | 6.2 | |
| node + browser CPU, warm loop (s, floor) | 49.3 | 42.0 | |

### firefox

| Scenario (ms) | playwright p50 / p95 / mean | bidi p50 / p95 / mean | BiDi vs PW (p50) |
| --- | --- | --- | --- |
| cold launch (init) | 308 / 335 / 311 | 911 / 946 / 915 | 2.96x |
| cold first page (startAttempt → open /forms → observe) | 479 / 506 / 486 | 146 / 155 / 149 | 0.30x |
| new context + page (startAttempt → first open) | 111 / 121 / 122 | 124 / 140 / 127 | 1.12x |
| navigate: testbed /forms | 17.6 / 19.9 / 17.0 | 14.0 / 20.5 / 15.3 | 0.80x |
| observe: testbed /forms | 11.8 / 14.7 / 13.8 | 11.4 / 15.2 / 12.0 | 0.97x |
| locate role+name: testbed /forms | 17.7 / 25.0 / 19.1 | 9.0 / 10.1 / 8.8 | 0.51x |
| click/type sequence: forms (5 actions) | 171 / 196 / 176 | 74.7 / 78.5 / 73.7 | 0.44x |
| screenshot: testbed /forms | 12.4 / 23.2 / 14.3 | 11.4 / 24.2 / 13.8 | 0.92x |
| navigate: testbed /scroll (8k px) | 6.6 / 8.1 / 6.8 | 8.0 / 9.8 / 8.3 | 1.22x |
| navigate: heavy page (9k elements) | 50.8 / 53.3 / 51.3 | 50.6 / 55.3 / 51.4 | 1.00x |
| observe: heavy page | 146 / 160 / 147 | 165 / 186 / 169 | 1.13x |
| observe + pixels: heavy page | 469 / 491 / 472 | 97.5 / 110 / 103 | 0.21x |
| locate role+name: heavy page | 173 / 198 / 177 | 818 / 849 / 823 | 4.73x |
| locate + fill + tap: heavy page | 93.7 / 107 / 93.8 | 544 / 577 / 546 | 5.81x |
| screenshot: heavy page | 26.8 / 29.5 / 27.3 | 20.0 / 29.1 / 21.4 | 0.75x |
| observe: /forms right after a heavy observation | 82.1 / 84.2 / 82.3 | 18.0 / 33.1 / 18.7 | 0.22x |
| agent flow: todos (10 observe/act steps) | 582 / 851 / 634 | 269 / 280 / 269 | 0.46x |
| peak RSS, node + browser (MB) | 2484 | 2905 | |
| node CPU, warm loop (s) | 17.6 | 4.4 | |
| node + browser CPU, warm loop (s, floor) | 73.7 | 60.4 | |

Rows run in table order within each iteration. "observe: /forms right after a heavy observation" isolates a Playwright cost: the next observation releases the previous generation's ~3k element handles, one protocol call each. BiDi shared ids need no release. The Playwright agent flow (which follows that row) ranged 268-374 ms p50 across two full runs; BiDi was 146 ms both times.

## Verdict

**Faster on BiDi:**
- The agent loop. The todos flow is 2-2.5x faster on both browsers, mostly from cheaper actions (BiDi actionability is one in-page call, Playwright retries through its injected script) and no handle bookkeeping.
- Observation with pixels: 2.2x (chromium) to 4.8x (firefox) faster. Playwright's masked screenshot with `animations: 'disabled'` is the expensive part.
- Small-page locate and action sequences: 2-3x faster.
- Firefox cold first page: 3x faster.
- Node CPU in the warm loop: 3-4x lower, even with the Chromium mapper running in-process.

**Slower on BiDi:**
- Locate on a heavy page: 3.5-4.7x slower. The BiDi locate reads every element in node mode for a role query, where Playwright's role engine narrows first. This is the driver, not the protocol. Fix: prefilter candidates by implicit role in the page, or use `browsingContext.locateNodes` with an `accessibility` locator.
- Firefox cold launch: 3x slower (Remote Agent startup, 0.9 s vs Juggler's 0.3 s). Paid once per worker.
- Chromium screenshots: 1.7x slower (mapper overhead plus the in-page mask round trips).
- Memory: +20-25% peak RSS (mapper in node; Firefox Remote Agent).

**Worth switching?** Not yet as the default. Raw speed is real for the agent loop, but the gaps are user-facing: request routing, `waitForResponse`, dialogs, frames, downloads, emulation, video (no BiDi equivalent), and hosted CDP browsers (`connect`, providers) cover a large share of real suites. Worth continuing as an opt-in driver: fix heavy-page locate, add network interception, dialogs, and frames (all have BiDi commands), then rerun this benchmark and the testbed. Video and CDP-only hosted browsers keep Playwright needed regardless.
