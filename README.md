# playwright-write-guard

A read-only safety net for Playwright tests and AI browser agents: it blocks writes before they reach your app and logs what it blocked.

![A real Claude Code session, asked to delete and refund test orders in a signed-in store admin, has all four clicks refused by the guard, stops and explains, while the server receives 0 writes](https://raw.githubusercontent.com/SandeepTakasi/playwright-write-guard/main/docs/demo.gif)

*A real, unscripted Claude Code run through Playwright MCP, filmed with [`demo/shop/film.mjs`](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/demo/README.md): every line on the left is the agent's own, and the log on the right shows what reached the server.*

## Quickstart

**An AI agent** (Playwright MCP, starting already logged in):

```
npm i -D playwright-write-guard
npx playwright install chromium
npx playwright-write-guard-browser --storage-state state.json
```

The launcher prints `endpoint: ws://...`. Point Playwright MCP at that endpoint with `--endpoint` (and without `--isolated`), then ask the agent to look around:

```
npx @playwright/mcp@0.0.83 --endpoint ws://127.0.0.1:<port>/<id>
```

`--print-mcp-config` also prints the JSON to paste into an MCP client's settings. `state.json` is a saved login (see [logging in](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md#logging-in)); drop `--storage-state` if the app needs no login.

**Playwright Test:**

```
npm i -D playwright-write-guard
npx playwright install chromium
```

```js
import { test, expect } from 'playwright-write-guard/test';
```

That one import is the whole change. If the click check refuses a control your app uses for reading, set `"defaultControls": false` in `write-guard.config.json` and name your own verbs in `controls.text`.

## Overview

It blocks every request whose method is not GET, HEAD or OPTIONS (unless you allow-list it) at the network layer, refuses destructive clicks inside the page, and writes a JSON audit log. Use it with Playwright Test, or with Playwright MCP and the Playwright CLI through an `initPage` entry or a launcher. No runtime dependencies, no build step. It is a safety net, not a security boundary: a restricted test account is the boundary.

## What it is and why

Pointing an automated browser at a real app is risky when the run should only look. A test that clicks through a settings page, or an agent asked to "find out what this dashboard shows", can press Save, Delete or Send, or fire a POST, and change real data.

This package puts a read-only guard in front of the browser:

- **Requests.** Any request whose method is not GET, HEAD or OPTIONS is blocked, unless a signature in your `allow` list says it is really a read (a read-only GraphQL endpoint, for example). Requests that are really writes but look like reads can be named in `writes`, and `writes` always wins: a request that matches both an `allow` and a `writes` signature is a write. The same rules judge the sends of `context.request` and `page.request`, and, in the Playwright Test fixture, the `request` fixture and Node's `fetch` inside a test: a GET goes through and a write is refused.
- **Clicks.** A click, form submit, or Enter or Space keypress on a control whose label is a destructive verb (Save, Delete, Publish, Send, Archive, Pay, Purchase, Log out and so on) is stopped inside the page before the app's own handlers run, and the page's console gets a `write-guard refused "<label>": <reason>` warning, so an agent that reads the console learns why nothing happened. A link that navigates is judged by its URL, not its text (see [Suspect GETs](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md#websocket-frames-and-suspect-gets)). Native confirmation dialogs are declined.
- **Log.** Every write it blocked, or only observed under the `observe` policy, is recorded as one JSON line, and so is every write one of your own routes mocked and every side-effecting GET it noticed (`suspect`).

What it guarantees, and what it does not:

- **Enforced:** every HTTP request the pages of a guarded context send is judged at the network layer, whatever triggered it, with the exceptions below. This is the main layer: a "Continue" button that submits a payment still sends a request, and that request is judged. WebSockets are the first exception: by default a socket opens and each open is recorded as a `websocket` event, but its messages, writes included, are not judged or logged. List patterns in `websocketWrites` to judge the text frames the page sends (see [WebSocket frames](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md#websocket-frames-and-suspect-gets)); `websockets: "block"` refuses the sockets the guard routes, and apps that need a socket then do not load. The others are sends from a page that is being left, HTTP from a `SharedWorker` and requests made with `fetchLater`, which Playwright does not route (next item).
- **Leaving pages, shared workers and `fetchLater`:** Playwright does not route a request a page starts while being left, the HTTP of a `SharedWorker`, or a `fetchLater` request. Under `read-only` the page script judges a leaving page's writes itself and removes `window.SharedWorker` and `window.fetchLater`; under `observe` none of them is judged or recorded. The details are in the [guide](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md#leaving-pages-shared-workers-and-fetchlater).
- **Heuristic:** which requests count as writes, and which controls count as destructive.
  - Requests are judged by method, unless your `allow` and `writes` signatures say otherwise. Apps that read over POST (GraphQL, search APIs, server actions, long polling) stop working until those endpoints are allow-listed. A run under `observe` lists them (method, URL, content type and header names; set `logBodies: true` to add the first 500 characters of each body, which can hold credentials, so it is off by default), and [a command drafts the allow entries from that log](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md#writing-an-allow-list). Events carry header names, never values, so reads told apart only by a header value have to be found in the app's own code or network panel. GETs with side effects (logout, unsubscribe, `?action=delete`) pass, but a GET whose path or query matches a short built-in pattern is recorded as a `suspect` event; it is never blocked. Other side-effecting GETs pass with no event unless a `writes` signature names them.
  - Controls are judged by label, and only real controls: buttons, links with an `href`, elements with a button, menuitem, link or tab role, and submit, button or image inputs. A link that navigates is judged by its URL instead of its label. The click check is a second layer that stops the app before it starts a write. Its built-in verb list is short (save, delete, remove, publish, send, archive, pay, purchase, refund, log out, sign out, logout): it still refuses some harmless controls such as "Save search", and misses writing controls such as "Place order" or "Add to cart". A short built-in list of view-only labels (`Remove filter`, `Clear filters`, `Clear search`, `Remove columns`, whole labels only) is exempt; `defaultExceptions: false` turns it off. If the check still gets in the way, set `defaultControls: false` and name your app's own verbs in `controls.text`.
- **Not covered:** anything outside the guarded context, such as other contexts, request clients the guard cannot reach, and code that removes the guard. See [What it cannot see](#what-it-cannot-see). The boundary is a restricted account: give the run credentials that cannot write, and use the guard to catch mistakes before they reach it.
- **Cost:** Playwright turns off the HTTP cache while a route is installed, so every load fetches every asset again. Service workers are blocked, so an app that waits for `navigator.serviceWorker.ready` hangs. Every WebSocket a page opens goes through Playwright's routing, which makes socket traffic noticeably slower.

See it work end to end, with a local page and server, in the walkthrough at [demo/README.md](demo/README.md) (`node demo/run.mjs`).

## Install

```
npm i -D playwright-write-guard
npx playwright install chromium
```

It needs Node 20 or newer and Playwright 1.64 or newer: `@playwright/test` for the fixture, and `playwright-core` for the launcher (`playwright-write-guard/browser`) and its command `playwright-write-guard-browser`. Using the `initPage` entry with an agent needs a Node that can `require` an ES module (see below).

## Use with Playwright Test

Swap one import:

```js
// before
// import { test, expect } from '@playwright/test';
import { test, expect } from 'playwright-write-guard/test';

test('lists items without changing them', async ({ page }) => {
  await page.goto('https://app.example.test/items');
  await expect(page.getByRole('list')).toBeVisible();
});
```

Tests that only read through the page keep working. Under both policies, these change:

- The `request` fixture, `page.request` and `context.request` work: a GET goes through, and a write is judged like a browser request. Under `read-only` it rejects without being sent, with `write-guard: POST <url> through APIRequestContext is refused under read-only`, and is recorded as a blocked `request` event (`via: "request-client"`); under `observe` it is recorded and sent. In a `beforeAll` or `afterAll` hook there is no test guard: a `request` fixture send there is judged (and refused under `read-only`) but not recorded.
- Node's global `fetch` is judged the same way while the test's own function runs (events carry `via: "node-fetch"`). In hooks and in fixture setup and teardown it still throws.
- `browser.newContext()` and `browser.newPage()` inside a test return a guarded context (record attached as `write-guard-<n>.json`); in hooks and fixture setup they throw, and so do `playwright.request.newContext()` and the browser types' `launch` and `connect` family. See [the guide](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md#playwright-test-details).
- A test can mock a write: a `page.route` handler that `fulfill`s or `abort`s it runs, and the guard records a `mocked` event (not `blocked`). A mock is not the server: count writes on a real local server.
- Blocked requests other than page navigations are aborted, which the page's console reports as `net::ERR_BLOCKED_BY_CLIENT` errors, so a test that asserts a clean console needs to filter those out. Under `read-only` each one also gets a `write-guard refused <METHOD> <URL>: <reason>` console warning in its frame, which such a test filters out too.
- Blocked writes do not fail a test by default. Set `writeGuardFailOnBlocked: true` (see below) to fail a test whose guard blocked something, or check the `blocked` count in the `write-guard.json` attachment. A write that one of your own routes fulfills or aborts is counted in `mocked`, not in `blocked`, so check `mocked` as well when the test must prove no write was attempted.

**Dialogs.** Under `read-only` the guard declines every dialog first, so a suite's own `accept` or `dismiss` on it throws (catch the error), and a dismissed `beforeunload` keeps the page. See [Dialogs](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md#dialogs).

The fixture guards each test's context, created with `serviceWorkers: 'block'`. By default it reads `write-guard.config.json` from the directory you run Playwright in. Every key is optional; a small example that lets two named GraphQL queries through and blocks everything else, mutations included:

```json
{
  "policy": "read-only",
  "allow": [
    {
      "method": "POST",
      "url": "^https://app[.]example[.]test/graphql$",
      "body": "^\\{\"operationName\":\"(ListItems|GetItem)\""
    }
  ],
  "controls": { "icons": ["icon-trash"] }
}
```

Without the `body` pattern, that signature would allow every request to the URL, mutations included. The pattern is anchored with `^\{`, so a batched request (a JSON array) never matches; list only operation names that read, and never leave a pattern unanchored. More in the [guide](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md#allow-and-writes-examples).

An `allow` URL that matches the empty string (`.*`, `^`, `x?`) is refused, and one not anchored with `^` prints a warning. A `writes` signature always wins over `allow`, so a GraphQL endpoint's reads can be allowed while its mutations stay blocked, and reads that differ from writes only in a header (Next.js server actions) can be allowed by exact action ID. Examples of both are in the [guide](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md#allow-and-writes-examples).

To set the config in the test file instead, use `test.use`:

```js
test.use({ writeGuardConfig: { policy: 'read-only', allow: [] } });
```

To fail a test whose guard blocked something, set the option `writeGuardFailOnBlocked` (off by default) with `test.use({ writeGuardFailOnBlocked: true })`, or in the config's `use`.

Each test attaches what the guard saw as `write-guard.json` (open it from the HTML report or the test's attachments). Its `config_file` names the config file that was loaded, or is `null` when none was read. The fixture never writes a JSONL log file; use that attachment instead.

If you run Playwright with `-c` from another directory, the fixture will not find `write-guard.config.json` and silently falls back to the defaults. Set `WRITE_GUARD_CONFIG` to the config file's path:

```
WRITE_GUARD_CONFIG=/path/to/write-guard.config.json npx playwright test -c config/playwright.config.mjs
```

The sections on [logging in](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md#logging-in) and [writing an allow list](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md#writing-an-allow-list) are in the guide.

## Use with AI agents

Pick one mode for a given browser. Using both at once is refused: the second guard throws `write-guard: this context is already guarded by another process; use one mode, not both`, and Playwright MCP then fails every tool call with that message.

Config mode depends on denying the agent its code-running and routing tools (the example below is for Claude Code); if your agent cannot, use launcher mode. Both modes were checked with Playwright MCP 0.0.83 driving the demo app: the agent's Delete click was refused in the page, its `fetch` DELETE was blocked at the network, and the server received no writes. The agent sees a refused click only as a warning count in the click's result; the reason is in the console messages (`browser_console_messages`). A blocked request other than a navigation reports `Failed to fetch` and, under `read-only`, also leaves a `write-guard refused <METHOD> <URL>: <reason>` warning in the console messages of its frame.

### Config mode: the `initPage` entry

Playwright MCP and the Playwright CLI can run a script on every new tab before any tool acts. Point them at this package's entry. For Playwright MCP, put this in a file and pass it with `--config`; for the Playwright CLI, put it in `.playwright/cli.config.json`:

```json
{
  "browser": {
    "initPage": ["/absolute/path/to/node_modules/playwright-write-guard/src/init-page.mjs"],
    "contextOptions": { "serviceWorkers": "block" }
  }
}
```

The entry is loaded with `require`, so the agent server's Node must be able to `require` an ES module: Node 20.19 or newer, or 22.12 or newer. The guard reads its config with `loadConfig()` from the agent server's working directory; set `WRITE_GUARD_CONFIG` to an absolute path when in doubt. The audit log is written there too.

In this mode the guard lives in the same process as the agent's tools, so the agent can remove it with its own code-running and routing tools. Deny those tools. In Claude Code, add these to `permissions.deny`:

```json
{
  "permissions": {
    "deny": [
      "mcp__playwright__browser_run_code_unsafe",
      "mcp__playwright__browser_route",
      "mcp__playwright__browser_unroute",
      "Bash(playwright-cli run-code:*)",
      "Bash(playwright-cli route:*)",
      "Bash(playwright-cli unroute:*)"
    ]
  }
}
```

Without those entries the agent can remove the guard.

### Launcher mode: a guarded browser the agent attaches to

The launcher starts Chromium, guards its one context, and prints a WebSocket endpoint:

```
npx playwright-write-guard-browser [--config <path>] [--headed] [--host <h>] [--port <n>] [--storage-state <path>] [--proxy <url>] [--ignore-https-errors] [--print-mcp-config]
```

`--storage-state` starts the browser logged in from a saved session file, `--proxy` sends its traffic through a proxy, and `--ignore-https-errors` accepts self-signed certificates (see [logging in](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md#logging-in)). It prints `config: <path>` (or `config: none, using the defaults`) as its first line, then `endpoint: <ws endpoint>`. Attach the agent to it:

- Playwright MCP: start it with `--endpoint <ws endpoint>` and without `--isolated`. `--isolated` makes a new, unguarded context.
- Playwright CLI: `playwright-cli attach --endpoint=<ws endpoint>`.

The guard runs in the launcher's process, not the agent's. The agent's own `unroute` and `unrouteAll` cannot remove it, and a `page.route` handler that calls `continue()`, with or without overrides, is still judged, because page handlers run before the owner's context route and the request reaches the guard with the overrides applied. Playwright MCP's own route tool only sets the headers and status of mocked responses, so this mode survives the MCP route tools the config mode has to deny. It does not survive arbitrary client code: see "What it cannot see" below. Tabs the agent opens in that context are guarded too. Stop it with Ctrl+C.

## What it cannot see

The five limits that matter most. It is a safety net, not a security boundary.

| Limit | What it means |
|---|---|
| Not a security boundary | Code in the guarded process, or an agent's own run-code tool or browser, can go around it. Give the run a restricted account that cannot write. |
| WebSocket messages | Judged only for text frames that match `websocketWrites`; by default a socket is recorded when it opens and its messages are not judged. |
| GETs that write | A GET is never blocked for its path; only a short built-in pattern (and `suspectGets`) records one as `suspect`. |
| Clicks are judged by their labels | A control is refused or let through by the words on it, so a harmless "Save search" is refused and a writing "Place order" is missed. The network layer is the main layer. |
| Sends from a page being left, a `SharedWorker` or `fetchLater` | Playwright does not route them. Under `read-only` the page script judges and refuses them but records nothing; under `observe` they are neither judged nor recorded. |

The [full list of limits](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/limits.md) has the rest, from redirects and toggles to the launcher's other contexts.

## Documentation

- [API reference](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/api.md): every entry point, the config keys, the decision rules, the installer, the fixture, the launcher, the suggest command, and the same list of limits.
- [Guide](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md): logging in, WebSocket frames and suspect GETs, the audit log, and writing an allow list.
- [Changelog](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/CHANGELOG.md): what changed in each release.

## License

MIT. See [LICENSE](LICENSE). Written by Venkata Sandeep Takasi.
