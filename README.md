# playwright-write-guard

A read-only safety net for Playwright tests and AI browser agents. It blocks every request whose method is not GET, HEAD or OPTIONS (unless you allow-list it) at the network layer, refuses destructive clicks inside the page before the app sees them, and writes a JSON audit log of every write it blocked or observed. Use it with Playwright Test through one import, or with Playwright MCP and the Playwright CLI either through a one-line `initPage` config entry or through a launcher that owns the browser the agent attaches to. It has no runtime dependencies and no build step. It is a safety net, not a security boundary: a restricted test account is the boundary.

## What it is and why

Pointing an automated browser at a real app is risky when the run should only look. A test that clicks through a settings page, or an agent asked to "find out what this dashboard shows", can press Save, Delete or Send, or fire a POST, and change real data.

This package puts a read-only guard in front of the browser:

- **Requests.** Any request whose method is not GET, HEAD or OPTIONS is blocked, unless a signature in your `allow` list says it is really a read (a read-only GraphQL endpoint, for example). Requests that are really writes but look like reads can be named in `writes`, and `writes` always wins: a request that matches both an `allow` and a `writes` signature is a write. The same rules judge the sends of `context.request` and `page.request`, and, in the Playwright Test fixture, the `request` fixture and Node's `fetch` inside a test: a GET goes through and a write is refused.
- **Clicks.** A click, form submit, or Enter or Space keypress on a control whose label is a destructive verb (Save, Delete, Publish, Send, Archive, Pay, Purchase, Log out and so on) is stopped inside the page before the app's own handlers run, and the page's console gets a `write-guard refused "<label>": <reason>` warning, so an agent that reads the console learns why nothing happened. A link that navigates is judged by its URL, not its text (see [Suspect GETs](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md#websocket-frames-and-suspect-gets)). Native confirmation dialogs are declined.
- **Log.** Every write it blocked, or only observed under the `observe` policy, is recorded as one JSON line, and so is every write one of your own routes mocked and every side-effecting GET it noticed (`suspect`).

What it guarantees, and what it does not:

- **Enforced:** every HTTP request the pages of a guarded context send is judged at the network layer, whatever triggered it, with the exceptions below. This is the main layer: a "Continue" button that submits a payment still sends a request, and that request is judged. WebSockets are the first exception: by default a socket opens and each open is recorded as a `websocket` event, but its messages, writes included, are not judged or logged. List patterns in `websocketWrites` to judge the text frames the page sends (see [WebSocket frames](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md#websocket-frames-and-suspect-gets)); `websockets: "block"` refuses the sockets the guard routes, and apps that need a socket then do not load. The others are sends from a page that is being left, HTTP from a `SharedWorker` and requests made with `fetchLater`, which Playwright does not route (next item).
- **Leaving pages, shared workers and `fetchLater`:** Playwright does not route a request a page starts while it is being left (a `navigator.sendBeacon` or a `keepalive` fetch from a `pagehide` or `unload` handler, or an ordinary `fetch` or XHR then), nor the HTTP of a `SharedWorker`, nor a request made with `fetchLater`, even from a page that stays open. Under `read-only`, the page script judges the writes of a leaving page itself, with the same `allow` list and rules as the network layer: an allowed write goes out, and any other is refused (the beacon returns `false`, the `fetch` rejects, the XHR throws) with a console warning. A frame counts as leaving when it, or a same-origin frame above it, is hidden or has fired `pagehide`, also with a cross-origin frame in between. A refusal is recorded nowhere, because a page that is being left cannot report reliably, and reads from a leaving page are not judged. Under `read-only` the page script also removes `window.SharedWorker` and `window.fetchLater` in every frame, so an app that checks for them falls back to a dedicated `Worker` (routed) or to `fetch` or `sendBeacon` (judged), and an app that calls them without checking does not load that part. Under `observe`, nothing is replaced or removed: unload-time sends, the HTTP of a `SharedWorker` and `fetchLater` requests are not judged and not recorded.
- **Heuristic:** which requests count as writes, and which controls count as destructive.
  - Requests are judged by method, unless your `allow` and `writes` signatures say otherwise. Apps that read over POST (GraphQL, search APIs, server actions, long polling) stop working until those endpoints are allow-listed. A run under `observe` lists them (method, URL, content type and header names; set `logBodies: true` to add the first 500 characters of each body, which can hold credentials, so it is off by default), and [a command drafts the allow entries from that log](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md#writing-an-allow-list). Events carry header names, never values, so reads told apart only by a header value have to be found in the app's own code or network panel. GETs with side effects (logout, unsubscribe, `?action=delete`) pass, but a GET whose path or query matches a short built-in pattern is recorded as a `suspect` event; it is never blocked. Other side-effecting GETs pass with no event unless a `writes` signature names them.
  - Controls are judged by label, and only real controls: buttons, links with an `href`, elements with a button, menuitem, link or tab role, and submit, button or image inputs. A link that navigates is judged by its URL instead of its label. The click check is a second layer that stops the app before it starts a write. Its built-in verb list is short (save, delete, remove, publish, send, archive, pay, purchase, log out, sign out, logout): it still refuses some harmless controls such as "Remove filter" or "Save search", and misses writing controls such as "Place order" or "Add to cart". If it gets in the way, set `defaultControls: false` and name your app's own verbs in `controls.text`.
- **Not covered:** anything outside the guarded context, such as other contexts, request clients the guard cannot reach, and code that removes the guard. See [What it cannot see](#what-it-cannot-see). The boundary is a restricted account: give the run credentials that cannot write, and use the guard to catch mistakes before they reach it.
- **Cost:** Playwright turns off the HTTP cache while a route is installed, so every load fetches every asset again. Service workers are blocked, so an app that waits for `navigator.serviceWorker.ready` hangs. Every WebSocket a page opens goes through Playwright's routing, which makes socket traffic noticeably slower.

See it work end to end, with a local page and a local server, in the walkthrough at [demo/README.md](demo/README.md) (`node demo/run.mjs`).

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
- `browser.newContext()` and `browser.newPage()` inside a test return a guarded context, created with `serviceWorkers: 'block'`, so tests with several users can create more contexts. Each one's record is attached as `write-guard-<n>.json`. In hooks and in fixture setup and teardown they still throw (a multi-user fixture that calls `browser.newContext()` fails at setup). `playwright.request.newContext()` and the browser types' `launch` and `connect` family still throw everywhere, because they make clients the guard cannot see.
- A test can mock a write: a `page.route` handler that `fulfill`s or `abort`s a POST runs, and the request never leaves the browser. The guard records it as a `mocked` event, which counts in `mocked`, not in `blocked`. A handler that passes the request on with `continue()` or `route.fetch()` is judged at that point, overrides included, so the write is still blocked. A mock is not the server: count writes on a real local server, not through a route that fulfills them.
- Blocked requests other than page navigations are aborted, which the page's console reports as `net::ERR_BLOCKED_BY_CLIENT` errors, so a test that asserts a clean console needs to filter those out. Under `read-only` each one also gets a `write-guard refused <METHOD> <URL>: <reason>` console warning in its frame, which such a test filters out too.
- Blocked writes do not fail a test by default. Set `writeGuardFailOnBlocked: true` (see below) to fail a test whose guard blocked something, or check the `blocked` count in the `write-guard.json` attachment. A write that one of your own routes fulfills or aborts is counted in `mocked`, not in `blocked`, so check `mocked` as well when the test must prove no write was attempted.

**Dialogs.** Under `read-only` the guard declines every dialog (`alert`, `confirm`, `prompt`, `beforeunload`) first, so a suite's own `accept` on the same dialog throws `Cannot accept dialog which is already handled!`, and its own `dismiss` throws `Cannot dismiss dialog which is already handled!`. The dialog is declined either way; catch the error so the test goes on:

```js
page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
```

A dismissed `beforeunload` keeps the page, so a test or an agent that leaves a page with unsaved changes (a `goto` elsewhere, a click on a link) stays on that page. A `page.goto` then throws `net::ERR_ABORTED`; a click on a link does not throw.

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

Without the `body` pattern, that signature would allow every request to the URL, mutations included. The pattern is anchored with `^\{`, so it matches only a single operation whose body starts with its name: a batched request (a JSON array) never matches, and neither does a body that puts `operationName` later. Check that your client sends `operationName` first, or the reads stay blocked (the safe direction). The pattern trusts your app's operation names, so list only names that read, and never leave a pattern unanchored.

An `allow` URL that matches the empty string (`.*`, `^`, `x?`) can match any URL, so the config is refused with `write-guard: allow[0].url: matches the empty string, so it can match any URL`. An `allow` URL that is not anchored with `^` still works, but `install` prints `write-guard: warning: allow[0].url "/api/": not anchored with ^, so it also matches any URL that merely contains a match` (the text names the URL, here `/api/`) once per distinct text per process, from Node and never in a page.

A `writes` signature always wins over `allow`. To let a GraphQL endpoint's reads through and still block its mutations, allow the URL and name the mutations in `writes` by a body pattern:

```json
{
  "allow": [{ "method": "POST", "url": "^https://app[.]example[.]test/graphql$" }],
  "writes": [{ "method": "POST", "url": "^https://app[.]example[.]test/graphql$", "body": "mutation" }]
}
```

Reads that differ from writes only in a header, such as Next.js server actions, can be allow-listed with a `headers` entry that names the exact action IDs that read, for example `{ "method": "POST", "url": "^https://app[.]example[.]test/items$", "headers": { "next-action": "^(7f3a9c21|1b2e44d0)$" } }`. Every server action sends a `next-action` header, writes included, so a pattern that matches any ID allows every action; and action IDs can change between builds, so re-check them after a deploy. Header names compare case-insensitively and each value is a regex tested against that header on the request.

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

Config mode depends on denying the agent its code-running and routing tools; the example below is for Claude Code. If your agent cannot deny tools that way, use launcher mode. Both modes were checked with Playwright MCP 0.0.83 driving the demo app: the agent's Delete click was refused in the page, its `fetch` DELETE was blocked at the network, and the server received no writes. The agent sees a refused click only as a warning count in the click's result: the reason is in the console messages (Playwright MCP's `browser_console_messages`). A blocked request other than a navigation reports `Failed to fetch` and, under `read-only`, also leaves a `write-guard refused <METHOD> <URL>: <reason>` warning in the console messages of its frame.

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
npx playwright-write-guard-browser [--config <path>] [--headed] [--host <h>] [--port <n>]
```

It prints `config: <path>` (or `config: none, using the defaults`) as its first line, then `endpoint: <ws endpoint>`. Attach the agent to it:

- Playwright MCP: start it with `--endpoint <ws endpoint>` and without `--isolated`. `--isolated` makes a new, unguarded context.
- Playwright CLI: `playwright-cli attach --endpoint=<ws endpoint>`.

The guard runs in the launcher's process, not the agent's. The agent's own `unroute` and `unrouteAll` cannot remove it, and a `page.route` handler that calls `continue()`, with or without overrides, is still judged, because page handlers run before the owner's context route and the request reaches the guard with the overrides applied. Playwright MCP's own route tool only sets the headers and status of mocked responses, so this mode survives the MCP route tools the config mode has to deny. It does not survive arbitrary client code: see "What it cannot see" below. Tabs the agent opens in that context are guarded too. Stop it with Ctrl+C.

## What it cannot see

The guard judges requests the browser sends through its context and clicks the page makes. These are outside it:

- Request clients it does not own: an attached client's own `page.request` and `context.request` in launcher mode, and `playwright.request.newContext()` called from an agent's run-code tool.
- An agent's run-code tool, and any browser the agent launches itself. In config mode, deny those tools as shown above.
- A Playwright Test run with `-c` from another directory without `WRITE_GUARD_CONFIG`, which falls back to the defaults.
- WebSocket messages, except the text frames `websocketWrites` names: under the default `websockets: "allow"`, each socket a page opens is recorded as a `websocket` event, and its messages (writes included, as in LiveView, Socket.IO or GraphQL subscriptions) are not judged or logged unless `websocketWrites` is set, and then only outbound text frames that match one of its patterns. Binary frames and messages the server sends to the page are never judged. `"block"` refuses every socket the guard routes, and apps that need a socket then do not load.
- WebSockets opened by dedicated or shared workers: they are not routed, so they are neither recorded nor blocked, under either setting.
- A caller's own `routeWebSocket` registered after the guard in the same process takes precedence: no open is recorded, and `websockets: "block"` does not refuse that socket. In launcher mode an attached client cannot register its own `routeWebSocket`: Playwright throws `Another client is already routing WebSockets`.
- The page's `WebSocket`: under both settings Playwright replaces it with its routed implementation, which an app that inspects or subclasses it can notice, and which makes socket traffic noticeably slower.
- WebRTC and WebTransport.
- Redirects after the first URL: only the request the page, a request client or Node's `fetch` made is judged, not where the server redirects it.
- Drag-and-drop, and handlers that act without a `click`: pointer or mouse handlers that act before it, `dblclick` and `auxclick` handlers, and key handlers other than the Enter or Space keydown the guard judges (for example a `keyup` handler for Space on a `role=button`). The network layer still judges what they send.
- Client-side-only destructive actions that no click or submit reaches.
- Toggles: `role=switch` and `role=checkbox` elements and checkbox inputs, and `change` events, are not judged (a `<button role=switch>` is still a button and is judged by its label).
- Mistakes in the config: requests are classified only as well as the config, so a write sent as GET, or a read sent as POST, needs a `writes` or `allow` signature.
- GET requests with side effects: only a GET or HEAD whose path plus query matches the built-in suspect pattern or a `suspectGets` pattern is recorded, as `suspect`, and it is never blocked. Any other pass with no event unless a `writes` signature names them, and `observe` does not list ordinary GETs. The built-in pattern is short: it misses paths such as `/items/7:delete`, and it also marks harmless GETs such as the static asset `/static/icons/delete-icon.svg`.
- Reads that send no query text (persisted GraphQL queries without an operation name): when nothing in the method, URL, headers or body tells such a read from a write, a signature that allows the endpoint allows its mutations too.
- Request bodies in the log unless `logBodies` is `true`, and header values: events record the method, URL, content type and header names, so an `observe` run shows which endpoints were written to and which headers they carried, not with what. `logBodies: true` adds the first 500 characters of each body, and is off by default because bodies can hold credentials and personal data.
- Bodies sent as `form` or `multipart` through an `APIRequestContext`, and Node `fetch` bodies that are not strings (streams, `FormData`, `URLSearchParams`, Blob, buffers) or that belong to a `Request` given to `fetch`: they are not judged by body, so a `body` signature cannot see them (the method, URL and headers still are).
- A request client's own `extraHTTPHeaders`: they are not part of the request the guard judges (nor is a `content-type` the client sets itself for `data`), although browser egress sees a context's `extraHTTPHeaders`. A `headers` signature set up for a header the client adds on its own therefore does not match a request client's send.
- Values the guard reads once and Playwright or `fetch` reads again (an options getter, a `Request`'s `url()`, an object with its own `toString`): they can return something else the second time, so the request sent can differ from the one judged.
- A `fetch` function or `APIRequestContext` captured before the guard wrapped it: calls through the captured reference are not judged. Only `context.request`, `page.request`, the fixture's `request`, Node's `fetch` inside a test and what you pass to `guardRequestClient` or `guardFetch` are wrapped.
- In launcher mode, mocking a blocked write from a client's `context.route`: that handler runs after the guard's catch-all, so it never receives a blocked write. A client's `page.route` can mock one.
- Mocks outside the guard's process: a write that one of your own routes fulfills or aborts in the guard's process is recorded as `mocked`, but in launcher mode a client's routes run in the client's process, so their mocks are not recorded. A `fulfill` or `abort` of a request that already went through `route.fetch()` records nothing (the fetch was judged), and a GET that a route fulfills or aborts is never recorded as `suspect`. A mock is not counted in `blocked` or `observed`, so a broad stub such as `page.route('**/api/**', ...)` keeps its writes out of those counts; look at `mocked`.
- A `request` fixture send in a `beforeAll` or `afterAll` hook: it is judged but not recorded, because no test guard exists there, so a run's record and log do not list it.
- `writeGuardFailOnBlocked` counts only recorded blocks: it does not fail a test for a `request` fixture send refused in a `beforeAll` or `afterAll` hook, or for a leaving page's refusals, because neither is recorded. `mocked`, `suspect` and `observe` events never count either.
- The launcher's browser and context options: it takes no storage state, proxy, `ignoreHTTPSErrors` or HTTP credentials.
- The HTTP cache: Playwright turns it off while a route is installed, so every load fetches every asset again.
- Service workers: they are blocked, so `register()` resolves but `navigator.serviceWorker.ready` never settles, and an app that waits for it hangs.
- In launcher mode, any context other than `contexts()[0]`: `--isolated`, or `browser.newContext()` from an agent's run-code tool, makes a new, unguarded context.
- In launcher mode, a client's `context.route` overrides are not judged again: that handler runs after the guard, in the client's process, so a `continue()` or `fallback()` that rewrites the method, URL or body (a GET rewritten to DELETE) reaches the server.
- In launcher mode, a client's `route.fetch()` from any route handler (`page.route` or `context.route`) is not seen: it is sent through the client's own `APIRequestContext`, which the guard cannot reach.
- Code in the same process that calls Playwright's prototype methods directly (for example `Object.getPrototypeOf(context).route` or `.unrouteAll`, `Object.getPrototypeOf(route).continue`, `Object.getPrototypeOf(context.request).fetch`, or Playwright's private `_innerFetch`, which go around the guard's wrapper on `APIRequestContext`) or removes the guard's own `page` or `dialog` listeners (`context.removeAllListeners('page')` leaves new pages' routes unwrapped; `context.removeAllListeners('dialog')` lets a caller accept a dialog) goes around the guard's wrappers: the route it registers is not wrapped (its `continue()` can send a POST), `unrouteAll` removes the guard, and a `continue` with overrides skips the override judging.
- Routes and dialog listeners registered before `install`: a `page.route` whose `continue()` sends a write, a `context.route` whose overrides are not judged, and a page `dialog` listener that accepts all run outside the guard's wrappers.
- Navigating links are judged by their URL, not by their label or icons: an `a` with a real `href` whose text or icon class says Delete is not refused in the page unless its URL is suspect (the network layer still judges the request its navigation sends). Anchors whose `href` is empty, starts with `#` or is a `javascript:` URL, and elements with `role=link`, are still judged by label and icons.
- Controls the page does not judge: anchors without `href`, `<input type=reset>`, `summary`, plain elements that have only an `onclick` attribute or a `tabindex` (rows, cards), controls inside closed shadow roots, and plain text outside any control. The network layer still judges any request they send. Open shadow roots are judged through the event's composed path, using the shadow host's label when the control has none. An image input is never found by the submit fallback, so a `requestSubmit()` with no submitter on a form whose only submit control is an image input is not judged in the page (the network layer still judges the request).
- A document loaded with `page.setContent()`: the guard's in-page listeners do not carry over into it, so a destructive click there is not refused in the page. The network layer still judges any request it sends.
- Node's own `http`, `https` and `net` modules in the test process.
- Under `observe`, writes a page sends while it is being left (a `navigator.sendBeacon` or a `keepalive` fetch from a `pagehide` or `unload` handler, or an ordinary `fetch` or XHR then), the HTTP of a `SharedWorker`, and requests made with `fetchLater`, even from a page that stays open: Playwright does not route them, so they are neither judged nor recorded.
- A write that a caller's slow route is still holding when `page.close()` runs, and a write that a live page or its dedicated worker starts at the instant its page or context closes: Playwright no longer tracks the frame, so the request goes out unjudged, under `read-only` too (without the guard, a route sees no such write either). Apart from that instant, a dedicated worker's requests are routed.
- A cross-origin frame that sends when its parent tells it to (a `postMessage` from the parent's `pagehide` handler, say): it has not fired `pagehide` itself and cannot read its parent, so it is not leaving, and on `page.close()` its write goes out unjudged, under `read-only` too.
- Reads from a leaving frame: under `read-only` only its writes are judged in the page. A GET, HEAD or OPTIONS goes through unjudged, a suspect GET included.
- A leaving frame's write whose body the page cannot read (a `Blob` or a `FormData`, or the body of a `Request` given to `fetch`): it is judged with no body, so a `body` signature never matches it, and a beacon carries no headers in the page's view, so a `headers` signature (a content type, say) does not match one either. Such a write is refused unless an `allow` signature without a `body` or `headers` matches it.
- Everything a leaving frame sends under `read-only`: a refusal is a console warning and an allowed write goes out, but neither is recorded or counted, so the record and the log do not list them. After a `page.goto`, the warning may not reach `page.on('console')`.
- In a headed browser, a background tab under `read-only`: it is `hidden`, so it counts as leaving, and its writes are judged in the page as above instead of at the network layer (not recorded, and a `Blob` or `FormData` body fails a `body` signature).
- The console warning for a blocked request: it goes through the page's own `console.warn`, evaluated in the request's frame, so a page that replaces `console.warn` can hide the message. A request with no frame to run in, such as a worker's, gets no warning either, and the page sees only the network error.

It also refuses too much, which is the safe direction but can stop a run:

- The built-in verbs match harmless controls too, because a label matches as a whole word anywhere in it ("Remove filter", "Save search", "Send feedback", "Pay attention").
- A link that navigates is refused in the page when its URL matches the suspect pattern, although following it may only read: a link to `/logout`, or to any URL with an `action=` query parameter, is refused, and so is a slugged URL that holds a built-in word, such as a help link to `/help/delete-a-repository`. Links judged by label (an empty, `#` or `javascript:` href, and `role=link`) are refused when their text holds a built-in verb ("Delete a repository" as a `#` link).
- Under `read-only`, `window.SharedWorker` and `window.fetchLater` are removed in every frame: an app that checks for them falls back to a dedicated `Worker`, `fetch` or `sendBeacon`, and an app that calls them without checking does not load that part.
- Under `read-only`, a dismissed `beforeunload` keeps the page: a test or an agent that leaves a page with unsaved changes stays on it, and a `page.goto` away from it throws `net::ERR_ABORTED` (a click on a link does not throw).
- A real control whose label contains a verb is refused even when it only reads. Text fields are never refused (a typed space or Enter goes through; Enter still submits a form implicitly, and that submit is judged by its submit button).

It is a safety net, not a security boundary. A restricted test account is the boundary: give the run credentials that cannot write, and use the guard to catch the mistakes that slip past.

## Documentation

- [API reference](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/api.md): every entry point, the config keys, the decision rules, the installer, the fixture, the launcher, the suggest command, and the same list of limits.
- [Guide](https://github.com/SandeepTakasi/playwright-write-guard/blob/main/docs/guide.md): logging in, WebSocket frames and suspect GETs, the audit log, and writing an allow list.

## License

MIT. See [LICENSE](LICENSE). Written by Venkata Sandeep Takasi.
