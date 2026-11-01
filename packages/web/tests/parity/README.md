# Behavior parity

Playwright's own page tests, rewritten against the e2e public API, so the
Playwright and WebDriver BiDi drivers of `web()` can be held to the same
behavior. Adapted from microsoft/playwright `tests/page` (and
`tests/library/download.spec.ts`) at `v1.64.1`, the version
`playwright-core` is pinned to. Copyright Microsoft Corporation, Apache
License 2.0: see `LICENSE` and `NOTICE`.

- `tests/*.e2e.ts`: one file per Playwright spec. Each keeps the original
  test's title, inputs, and assertions; `page.click(selector)` becomes a
  locator tap, `page.setContent(html)` a page the server serves (`content()`).
  A test whose API e2e does not expose is left out; the file header lists them.
- `assets/`: Playwright's `tests/assets` files the tests load, unchanged.
- `server.mjs`: serves `assets/`, plus the routes Playwright's test server sets
  per test as fixed paths. `127.0.0.1` and `localhost` on its port are the two
  origins of the cross-origin cases.

A test skipped on BiDi names the browser or protocol gap and links it,
usually to Playwright's own BiDi expectations
(`tests/bidi/expectations/*.txt` at the same tag).

```sh
pnpm build
cd packages/web/tests/parity
E2E_WEB_DRIVER=playwright BROWSER=chromium node ../../node_modules/e2e/dist/cli/bin.js run
E2E_WEB_DRIVER=bidi BROWSER=firefox node ../../node_modules/e2e/dist/cli/bin.js run
```

`PARITY_PORT` (default 4311) moves the server. Parallel runs each need their
own `PARITY_PORT` and `--output .e2e-<name>`, and must not share a browser:
`page-screenshot` writes its goldens into the shared `tests/` snapshot folder.
