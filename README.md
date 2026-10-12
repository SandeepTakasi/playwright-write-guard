# playwright-write-guard

A read-only safety net for Playwright tests and AI browser agents. It blocks every request whose method is not GET, HEAD or OPTIONS (unless you allow-list it) at the network layer, refuses destructive clicks inside the page before the app sees them, and writes a JSON audit log of every write it blocked or observed. Use it with Playwright Test through one import, or with Playwright MCP and the Playwright CLI either through a one-line `initPage` config entry or through a launcher that owns the browser the agent attaches to. It has no runtime dependencies and no build step. It is a safety net, not a security boundary: a restricted test account is the boundary.

## What it is and why

Pointing an automated browser at a real app is risky when the run should only look. A test that clicks through a settings page, or an agent asked to "find out what this dashboard shows", can press Save, Delete or Send, or fire a POST, and change real data.

This package puts a read-only guard in front of the browser:

- **Requests.** Any request whose method is not GET, HEAD or OPTIONS is blocked, unless a signature in your `allow` list says it is really a read (a read-only GraphQL endpoint, for example). Requests that are really writes but look like reads can be named in `writes`.
- **Clicks.** A click, form submit, or Enter or Space keypress on a control whose label is a destructive verb (Save, Delete, Publish, Send, Archive, Pay, Purchase, Log out and so on) is stopped inside the page before the app's own handlers run, and the page's console gets a `write-guard refused "<label>": <reason>` warning, so an agent that reads the console learns why nothing happened. Native confirmation dialogs are declined.
- **Log.** Every write it blocked, or only observed under the `observe` policy, is recorded as one JSON line.

What it guarantees, and what it does not:

- **Enforced:** every HTTP request the pages of a guarded context send is judged at the network layer, whatever triggered it. This is the main layer: a "Continue" button that submits a payment still sends a request, and that request is judged. WebSockets are the exception: by default a socket opens and each open is recorded as a `websocket` event, but its messages, writes included, are not judged or logged (`websockets: "block"` refuses the sockets the guard routes, and apps that need a socket then do not load).
- **Heuristic:** which requests count as writes, and which controls count as destructive.
  - Requests are judged by method, unless your `allow` and `writes` signatures say otherwise. Apps that read over POST (GraphQL, search APIs, server actions, long polling) stop working until those endpoints are allow-listed. A run under `observe` lists them (method, URL and content type; set `logBodies: true` to add the first 500 characters of each body, which can hold credentials, so it is off by default). It does not show request headers, so reads told apart only by a header have to be found in the app's own code or network panel. GETs with side effects (logout, unsubscribe, `?action=delete`) pass with no event unless a `writes` signature names them.
  - Controls are judged by label, and only real controls: buttons, links with an `href`, elements with a button, menuitem, link or tab role, and submit, button or image inputs. The click check is a second layer that stops the app before it starts a write. Its built-in verb list is short (save, delete, remove, publish, send, archive, pay, purchase, log out, sign out, logout): it still refuses some harmless controls such as "Remove filter" or "Save search", and misses writing controls such as "Place order" or "Add to cart". If it gets in the way, set `defaultControls: false` and name your app's own verbs in `controls.text`.
- **Not covered:** anything outside the guarded context, such as other contexts, request clients the guard cannot reach, and code that removes the guard. See [What it cannot see](#what-it-cannot-see). The boundary is a restricted account: give the run credentials that cannot write, and use the guard to catch mistakes before they reach it.
- **Cost:** Playwright turns off the HTTP cache while a route is installed, so every load fetches every asset again. Service workers are blocked, so an app that waits for `navigator.serviceWorker.ready` hangs. Every WebSocket a page opens goes through Playwright's routing, which makes socket traffic noticeably slower.

See it work end to end, with a local page and a local server, in the walkthrough at [demo/README.md](demo/README.md) (`node demo/run.mjs`).

## Install

```
npm i -D playwright-write-guard
npx playwright install chromium
```

It needs Node 20 or newer and Playwright 1.59 or newer: `@playwright/test` for the fixture, and `playwright-core` for the launcher and its command. Using the `initPage` entry with an agent needs a Node that can `require` an ES module (see below).

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

Tests that only read through the page keep working. Under read-only, these change:

- The `request` fixture fails the test at setup, and `page.request` and `context.request` refuse every send, GET included.
- While a test runs, `browser.newContext()`, `browser.newPage()` and the global `fetch` in the test process throw, so tests with several users, or that post results from inside a test, need another approach.
- A test can mock a write: a `page.route` handler that `fulfill`s or `abort`s a POST runs, and the request never leaves the browser. A handler that passes the request on with `continue()` or `route.fetch()` is judged at that point, overrides included, so the write is still blocked. A mock is not the server: count writes on a real local server, not through a route that fulfills them.
- Blocked requests other than page navigations are aborted, which the page's console reports as `net::ERR_BLOCKED_BY_CLIENT` errors, so a test that asserts a clean console needs to filter those out.
- Blocked writes do not fail a test. Check the `blocked` count in the `write-guard.json` attachment if you want them to. A write that one of your own routes fulfills or aborts is a mock and is not counted, so a broad stub such as `page.route('**/api/**', ...)` can hide writes from that count: keep stubs narrow.

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

Reads that differ from writes only in a header, such as Next.js server actions, can be allow-listed with a `headers` entry that names the exact action IDs that read, for example `{ "method": "POST", "url": "^https://app[.]example[.]test/items$", "headers": { "next-action": "^(7f3a9c21|1b2e44d0)$" } }`. Every server action sends a `next-action` header, writes included, so a pattern that matches any ID allows every action; and action IDs can change between builds, so re-check them after a deploy. Header names compare case-insensitively and each value is a regex tested against that header on the request.

To set the config in the test file instead, use `test.use`:

```js
test.use({ writeGuardConfig: { policy: 'read-only', allow: [] } });
```

Each test attaches what the guard saw as `write-guard.json` (open it from the HTML report or the test's attachments). The fixture never writes a JSONL log file; use that attachment instead.

If you run Playwright with `-c` from another directory, the fixture will not find `write-guard.config.json` and silently falls back to the defaults. Set `WRITE_GUARD_CONFIG` to the config file's path:

```
WRITE_GUARD_CONFIG=/path/to/write-guard.config.json npx playwright test -c config/playwright.config.mjs
```

## Use with AI agents

Pick one mode for a given browser. Using both at once is refused: the second guard throws `write-guard: this context is already guarded by another process; use one mode, not both`, and Playwright MCP then fails every tool call with that message.

Config mode depends on denying the agent its code-running and routing tools; the example below is for Claude Code. If your agent cannot deny tools that way, use launcher mode. Both modes were checked with Playwright MCP 0.0.83 driving the demo app: the agent's Delete click was refused in the page, its `fetch` DELETE was blocked at the network, and the server received no writes. The agent sees a refused click only as a warning count in the click's result: the reason is in the console messages (Playwright MCP's `browser_console_messages`), and a blocked request only reports `Failed to fetch`.

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

It prints `endpoint: <ws endpoint>`. Attach the agent to it:

- Playwright MCP: start it with `--endpoint <ws endpoint>` and without `--isolated`. `--isolated` makes a new, unguarded context.
- Playwright CLI: `playwright-cli attach --endpoint=<ws endpoint>`.

The guard runs in the launcher's process, not the agent's. The agent's own `unroute` and `unrouteAll` cannot remove it, and a `page.route` handler that calls `continue()`, with or without overrides, is still judged, because page handlers run before the owner's context route and the request reaches the guard with the overrides applied. Playwright MCP's own route tool only sets the headers and status of mocked responses, so this mode survives the MCP route tools the config mode has to deny. It does not survive arbitrary client code: see "What it cannot see" below. Tabs the agent opens in that context are guarded too. Stop it with Ctrl+C.

## Logging in

Logging in is a write, so under read-only a login form is blocked: the page shows `write-guard blocked POST .../login`. Token refreshes that POST are blocked too. Ways in:

- **Playwright Test:** log in from a setup project that imports `@playwright/test`, not this package, save the session with `storageState`, and give it to the guarded project. The fixture wraps Playwright's own context, so `storageState` works as usual.

  ```js
  // playwright.config.mjs
  import { defineConfig } from '@playwright/test';
  export default defineConfig({
    projects: [
      { name: 'login', testMatch: /login\.setup\.mjs/ },
      { name: 'read-only', dependencies: ['login'], use: { storageState: 'state.json' } },
    ],
  });
  ```

  ```js
  // login.setup.mjs: imports @playwright/test, so it is not guarded
  import { test } from '@playwright/test';
  test('log in', async ({ page }) => {
    await page.goto('https://app.example.test/login');
    // fill in the form with the read-only test account's credentials
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForURL('**/home');
    await page.context().storageState({ path: 'state.json' });
  });
  ```

  `state.json` holds a live session: keep it out of version control. If the app renews its session token with a POST, the session expires during the run and the app looks broken ("session expired"); allow-list that refresh endpoint as below.
- **Allow-list the login endpoints**, in any mode: `{ "method": "POST", "url": "^https://app[.]example[.]test/login$" }`, plus the token refresh endpoint if a session must last. Keep these narrow: everything they match is let through.
- **Playwright MCP in config mode:** start it with `--isolated --storage-state <file>` to begin already logged in (Playwright MCP reads a storage state only for isolated sessions).
- **Launcher mode** takes no context or launch options yet (no storage state, proxy, `ignoreHTTPSErrors` or HTTP credentials): allow-list the login endpoints, or use config mode.

## The audit log

When `log` is a path (default `write-guard.jsonl`, relative to the process's working directory), each blocked or observed write is appended as one JSON object per line, as it happens, and so is each WebSocket opened under the default `websockets: "allow"`. The file is created when missing and never truncated. Allowed requests and controls are not logged. Set `"log": null` to turn it off.

A blocked request, a refused control and a WebSocket open look like this (one line each in the file):

```json
{"kind":"request","action":"block","reason":"POST is not a read method; policy read-only","method":"POST","url":"https://app.example.test/items","contentType":"application/json","at":"2026-01-15T09:30:00.000Z"}
{"kind":"control","action":"block","reason":"\"Delete item\" matches a destructive label; policy read-only","label":"Delete item","at":"2026-01-15T09:30:02.000Z"}
{"kind":"websocket","action":"open","url":"wss://app.example.test/live","at":"2026-01-15T09:30:03.000Z"}
```

A request event carries `method`, `url` and, when the request has a `content-type` header, `contentType`. With `logBodies: true` it also carries `body`, the first 500 characters of the request body; that is off by default because bodies can hold credentials and personal data, so treat a log that has them as sensitive. A control event carries `label` and none of the request fields. A websocket event carries only its `url`. `reason` is a human-readable note whose wording may change. Under the `observe` policy the same events are recorded with `"action":"observe"` and the write goes through, which is a way to find out what a run would have blocked. The full event shape is in the API below.

## What it cannot see

The guard judges requests the browser sends through its context and clicks the page makes. These are outside it:

- Request clients it does not own: an attached client's own `page.request` and `context.request` in launcher mode, and `playwright.request.newContext()` called from an agent's run-code tool.
- An agent's run-code tool, and any browser the agent launches itself. In config mode, deny those tools as shown above.
- A Playwright Test run with `-c` from another directory without `WRITE_GUARD_CONFIG`, which falls back to the defaults.
- WebSocket messages: under the default `websockets: "allow"`, each socket a page opens is recorded as a `websocket` event, but its messages (writes included, as in LiveView, Socket.IO or GraphQL subscriptions) are not judged or logged. `"block"` refuses every socket the guard routes, and apps that need a socket then do not load.
- WebSockets opened by dedicated or shared workers: they are not routed, so they are neither recorded nor blocked, under either setting.
- A caller's own `routeWebSocket` registered after the guard in the same process takes precedence: no open is recorded, and `websockets: "block"` does not refuse that socket. In launcher mode an attached client cannot register its own `routeWebSocket`: Playwright throws `Another client is already routing WebSockets`.
- The page's `WebSocket`: under both settings Playwright replaces it with its routed implementation, which an app that inspects or subclasses it can notice, and which makes socket traffic noticeably slower.
- WebRTC and WebTransport.
- Redirects after the first URL: only the request the page made is judged, not where the server redirects it.
- Drag-and-drop, and pointer or mouse handlers that act before `click`.
- Client-side-only destructive actions that no click or submit reaches.
- Mistakes in the config: requests are classified only as well as the config, so a write sent as GET, or a read sent as POST, needs a `writes` or `allow` signature.
- GET requests with side effects (logout, unsubscribe or confirm links, `?action=delete`) pass with no event unless a `writes` signature names them, and `observe` does not list GETs.
- Reads that send no query text (persisted GraphQL queries without an operation name): when nothing in the method, URL, headers or body tells such a read from a write, a signature that allows the endpoint allows its mutations too.
- Request bodies in the log unless `logBodies` is `true`, and request headers other than the content type: events record the method, URL and content type, so an `observe` run shows which endpoints were written to, not with what. `logBodies: true` adds the first 500 characters of each body, and is off by default because bodies can hold credentials and personal data.
- In launcher mode, mocking a blocked write from a client's `context.route`: that handler runs after the guard's catch-all, so it never receives a blocked write. A client's `page.route` can mock one.
- Writes that one of your own routes fulfills or aborts: they never leave the browser and are not recorded, so a broad stub such as `page.route('**/api/**', ...)` can hide writes from the log and from the `blocked` count.
- The launcher's browser and context options: it takes no storage state, proxy, `ignoreHTTPSErrors` or HTTP credentials.
- The HTTP cache: Playwright turns it off while a route is installed, so every load fetches every asset again.
- Service workers: they are blocked, so `register()` resolves but `navigator.serviceWorker.ready` never settles, and an app that waits for it hangs.
- In launcher mode, any context other than `contexts()[0]`: `--isolated`, or `browser.newContext()` from an agent's run-code tool, makes a new, unguarded context.
- In launcher mode, a client's `context.route` overrides are not judged again: that handler runs after the guard, in the client's process, so a `continue()` or `fallback()` that rewrites the method, URL or body (a GET rewritten to DELETE) reaches the server.
- In launcher mode, a client's `route.fetch()` from any route handler (`page.route` or `context.route`) is not seen: it is sent through the client's own `APIRequestContext`, which the guard cannot reach.
- Code in the same process that calls Playwright's prototype methods directly (for example `Object.getPrototypeOf(context).route` or `.unrouteAll`, `Object.getPrototypeOf(route).continue`, or `Object.getPrototypeOf(context.request).fetch`, which goes around the read-only lock on `APIRequestContext`) or removes the guard's own `page` or `dialog` listeners (`context.removeAllListeners('page')` leaves new pages' routes unwrapped; `context.removeAllListeners('dialog')` lets a caller accept a dialog) goes around the guard's wrappers: the route it registers is not wrapped (its `continue()` can send a POST), `unrouteAll` removes the guard, and a `continue` with overrides skips the override judging.
- Routes and dialog listeners registered before `install`: a `page.route` whose `continue()` sends a write, a `context.route` whose overrides are not judged, and a page `dialog` listener that accepts all run outside the guard's wrappers.
- Under `observe`, sends through `context.request`, `page.request` and the `request` fixture are neither blocked nor recorded (only read-only locks them), so an observe run does not list them.
- Controls the page does not judge: anchors without `href`, `<input type=reset>`, `summary`, plain elements that have only an `onclick` attribute or a `tabindex` (rows, cards), controls inside closed shadow roots, and plain text outside any control. The network layer still judges any request they send. Open shadow roots are judged through the event's composed path, using the shadow host's label when the control has none. An image input is never found by the submit fallback, so a `requestSubmit()` with no submitter on a form whose only submit control is an image input is not judged in the page (the network layer still judges the request).
- A document loaded with `page.setContent()`: the guard's in-page listeners do not carry over into it, so a destructive click there is not refused in the page. The network layer still judges any request it sends.
- Node's own `http`, `https` and `net` modules in the test process.

It also refuses too much, which is the safe direction but can stop a run:

- The built-in verbs match harmless controls too, because a label matches as a whole word anywhere in it ("Remove filter", "Save search", "Send feedback", "Pay attention").
- Links are judged by their text too: a link whose text holds a built-in verb ("Delete a repository" in a help page, "Archive" in a navigation bar) is refused in the page, although following it only reads.
- A real control whose label contains a verb is refused even when it only reads. Text fields are never refused (a typed space or Enter goes through; Enter still submits a form implicitly, and that submit is judged by its submit button).

It is a safety net, not a security boundary. A restricted test account is the boundary: give the run credentials that cannot write, and use the guard to catch the mistakes that slip past.

## API

The package has five entry points, each with its own type declarations:

| Import | Exports |
|---|---|
| `playwright-write-guard` | `compileConfig`, `decideRequest`, `decideControl`, `decideFrame`, `decideSuspect` |
| `playwright-write-guard/install` | `install`, `loadConfig` |
| `playwright-write-guard/test` | `test`, `expect` |
| `playwright-write-guard/init-page` | the default export, an `initPage` function |
| `playwright-write-guard/browser` | `startGuardedBrowser` |

It also installs two commands: `playwright-write-guard-browser`, which starts a guarded browser (see the launcher below), and `playwright-write-guard-suggest`, which drafts `allow` entries from an audit log (see the suggest command below). It needs Node 20 or newer and Playwright 1.59 or newer (`@playwright/test` for the fixture; `playwright-core` is needed at runtime only by `playwright-write-guard/browser` and `playwright-write-guard-browser`, and the other entry points use the context Playwright gives them).

### Config

Every key is optional, and unknown keys are ignored:

```json
{
  "policy": "read-only",
  "allow": [],
  "writes": [],
  "controls": { "text": [], "icons": [] },
  "defaultControls": true,
  "websockets": "allow",
  "websocketWrites": [],
  "suspectGets": [],
  "defaultSuspectGets": true,
  "log": "write-guard.jsonl",
  "logBodies": false
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `policy` | `"read-only"` or `"observe"` | `"read-only"` | `read-only` blocks writes and destructive controls; `observe` records them and lets them through |
| `allow` | list of Sig | `[]` | requests that are never writes |
| `writes` | list of Sig | `[]` | requests that are writes even when their method is GET, HEAD or OPTIONS |
| `controls.text` | list of regex sources | `[]` | extra label patterns that make a control destructive |
| `controls.icons` | list of class name prefixes | `[]` | a control with a class starting with one of these is destructive |
| `defaultControls` | boolean | `true` | include the 11 built-in verbs (listed under Writes and controls) in the label pattern; `false` drops them |
| `websockets` | `"allow"` or `"block"` | `"allow"` | `allow` records each WebSocket open and lets it connect; `block` refuses every WebSocket |
| `websocketWrites` | list of regex sources | `[]` | under `websockets: "allow"`, an outbound WebSocket text frame matching any of these is a write: dropped under `read-only`, recorded and forwarded under `observe`. Compiled with no flags (case-sensitive) and tested unanchored against the frame's text. Empty: frames are not judged |
| `suspectGets` | list of regex sources | `[]` | extra patterns that mark a GET or HEAD as suspect (recorded, never blocked), added to the built-in suspect pattern. Compiled case-insensitive and tested unanchored against the URL's path plus query |
| `defaultSuspectGets` | boolean | `true` | include the built-in suspect pattern (shown under Writes and controls); `false` drops it |
| `log` | path or `null` | `"write-guard.jsonl"` | the JSONL audit log, relative to the process's working directory; `null` turns it off |
| `logBodies` | boolean | `false` | add `body`, the first 500 characters of the request body, to request events, and `frame`, the first 500 characters of the frame, to WebSocket frame events (in `record()` and the log); off by default because bodies and frames can hold credentials and personal data |

A **Sig** (request signature) is `{ "method": M, "url": U, "body": B, "headers": H }`:

- `method` is `"*"` or a method name: a string matching `^[A-Za-z][A-Za-z0-9-]*$` (for example `POST`, `delete`, `REPORT` or `M-SEARCH`), compiled to upper case. `*` matches any method; a method name matches that method exactly, compared with the request's method in upper case.
- `url` is a regex source, compiled with no flags (case-sensitive) and tested, unanchored, against the full request URL. Use `^` and `$` to anchor it, and escape dots: `"^https://api[.]example[.]com/graphql$"`.
- `body` is optional (absent or `null` means the Sig names no body): a regex source, compiled the same way and tested against the request body. A signature with a `body` never matches a request that has no body (a body that is `null` or absent).
- `headers` is optional (absent or `null` means the Sig names no headers): an object mapping a header name to a regex source, for example `{ "Next-Action": "^[0-9a-f]+$" }`. Header names compare case-insensitively (they are compiled to lower case). Each value is compiled with no flags and tested, unanchored, against the value of that header on the request. A Sig with `headers` matches a request only when every header it names is present on the request and its value matches.
- A request matches a Sig when its method, its URL, (when the Sig has one) its body and (when the Sig names any) every named header all match.

### Writes and controls

**A request is a write** when its method, upper-cased, is not GET, HEAD or OPTIONS, or it matches a `writes` signature, **and** it matches no `allow` signature. The method is upper-cased before the GET, HEAD or OPTIONS check. `allow` always wins: `{ "method": "POST", "url": "^https://app[.]example[.]com/graphql" }` in `allow` lets a read-only GraphQL endpoint through.

**A request is suspect** when its method, upper-cased, is GET or HEAD and its URL matches the suspect pattern. The suspect pattern is the built-in pattern (unless `defaultSuspectGets` is `false`) plus every `suspectGets` source, joined into one case-insensitive regex. It is tested, unanchored, against the URL's path plus query (`pathname` followed by `search`, never the origin or the hash) when the URL parses as an absolute URL, and against the URL as given when it is relative or does not parse. The built-in pattern is:

`(?:^|[/._-])(?:(?:log|sign)[-_]?out|unsubscribe|confirm|delete|remove)(?:$|[/._?&#-])|[?&]action=`

So `/logout`, `/users/sign_out`, `/unsubscribe?t=1` and `/items?action=delete` are suspect, and `/catalog` and `/deleted-items` are not. A suspect request is never blocked at the network: wherever a GET or HEAD is allowed (browser egress, request clients, Node's `fetch`), a suspect one is recorded as a `suspect` event and proceeds. With no built-in pattern and no `suspectGets`, nothing is suspect. A `writes` signature still makes a GET a write.

**A control is destructive** when its label matches the label pattern, or it has a class starting with one of the `controls.icons` prefixes. The label pattern is the built-in verbs (unless `defaultControls` is `false`) plus every `controls.text` source, joined into one case-insensitive regex. The built-in verbs match as whole words, case-insensitive (`Save` and `Delete item` match, `Saved` does not):

`save`, `delete`, `remove`, `publish`, `send`, `archive`, `pay`, `purchase`, `log out`, `sign out`, `logout`

There are no built-in icons: icon libraries differ per app, so name yours in `controls.icons` (for example `"icon-trash"`). An empty label never matches the label pattern; with `defaultControls: false` and no `controls.text`, only icons can make a control destructive.

In the page, a **control** is an element matching the control selector `button, a[href], [role=button], [role=menuitem], [role=link], [role=tab], input[type=submit], input[type=button], input[type=image]`. The page judges three events, and only when they have a control:

- **Click:** the control is the first element of `event.composedPath()` that matches the control selector. The path runs from the click target outward and crosses open shadow roots. When no element on it matches, the click is not judged.
- **Form submit:** the control is `event.submitter`. When there is none (as with `form.requestSubmit()` called without a submitter), it is the first element of the form's `form.elements` matching `button:not([type]), button[type=submit], input[type=submit]`. When there is none of those either, the submit is not judged.
- **Enter or Space keydown:** judged only when `document.activeElement` itself matches the control selector, and that element is the control. A keydown in a text field, or with focus on any other element, is never judged.

A control's **label** is the first non-empty, trimmed value of its `aria-label` attribute, its `innerText`, its `title` attribute and its `value`. When that is empty and the control is inside a shadow root, the label is the same rule applied to that shadow root's host (so `<x-btn>Delete</x-btn>`, whose shadow root holds a `<button>` with a `<slot>`, is labelled `Delete`). Its **icons** are every class name on the control and on each of its descendants.

Every control is judged by its label and icons with `decideControl`, except a **link that navigates**. When the control is an `a` element with an `href` attribute (whatever its `role`), the page reads that attribute and trims it:

- An `a[href]` is non-navigating when its `href`, trimmed, is empty or starts with `#`, or when, with the `href` resolved against `document.baseURI` (`new URL(href, document.baseURI)`), the resolved URL's protocol is `javascript:` (so tabs or newlines inside the scheme cannot escape the rule). A non-navigating link is judged by its label and icons like any other control.
- Otherwise the link navigates, and it is judged by its URL, never by its label or icons. The URL is the trimmed `href` resolved against the document's base URL (`new URL(href, document.baseURI).href`; the base URL is the page's URL unless a `<base>` element sets another), or the trimmed `href` as written when that throws. It is checked with `decideSuspect({ method: 'GET', url })`. A suspect link is treated as a destructive control with its label: under `read-only` its event is stopped and the console warning is written, as below, and under either policy it is reported as a control event whose `action` is `"block"` under `read-only` and `"observe"` under `observe`, and whose `reason` is the one `decideSuspect` returned. Any other navigating link is not judged in the page; the request its navigation sends is judged at the network layer.

Elements matching `[role=link]` that are not `a` elements with an `href` keep the label rule.

Not judged in the page, by design: anchors without `href`, navigating links whose URL is not suspect, `<input type=reset>`, `summary`, plain elements that have only an `onclick` attribute or a `tabindex` (rows, cards), and controls inside closed shadow roots (the path stops at the shadow host). The network layer still judges every request any of them sends.

### The decision core: `playwright-write-guard`

```js
import { compileConfig, decideRequest, decideControl, decideFrame, decideSuspect } from 'playwright-write-guard';

const config = compileConfig({
  allow: [{ method: 'POST', url: '^https://app[.]example[.]com/graphql' }],
  websocketWrites: ['"event":"delete_item"'],
});
decideRequest({ method: 'POST', url: 'https://app.example.com/items', body: '{}' }, config);
// { action: 'block', reason: '...' }
decideControl({ label: 'Delete item', icons: [] }, config);
// { action: 'block', reason: '...' }
decideFrame('{"event":"delete_item","id":7}', config);
// { action: 'block', reason: '...' }
decideSuspect({ method: 'GET', url: 'https://app.example.com/logout' }, config);
// { suspect: true, reason: '...' }
```

- `compileConfig(raw)` validates a raw config (`null` and `undefined` mean `{}`), applies every default and compiles every pattern. On anything malformed it throws an `Error` whose message is `write-guard: <path>: <message>`, where `<path>` names the offending key the way the config spells it (`policy`, `allow[0].method`, `controls.text[2]`, `allow[0].headers.Next-Action`), or `config` for the whole value. Malformed means:
  - a config that is not an object;
  - a `policy` or `websockets` outside its allowed values;
  - `websocketWrites` or `suspectGets` that is not a list, which throws `write-guard: <key>: must be a list` (for example `write-guard: websocketWrites: must be a list`);
  - a `websocketWrites` or `suspectGets` entry that is not a non-empty string, which throws `write-guard: <key>[<i>]: must be a non-empty regex string` (for example `write-guard: websocketWrites[0]: must be a non-empty regex string`), or that does not compile (a `websocketWrites` entry with no flags, a `suspectGets` entry case-insensitive), which throws `write-guard: <key>[<i>]: does not compile: <message>`;
  - `defaultSuspectGets` that is not a boolean, which throws `write-guard: defaultSuspectGets: must be a boolean`;
  - a Sig `method` that is neither `"*"` nor a string matching `^[A-Za-z][A-Za-z0-9-]*$`, which throws `write-guard: <path>.method: must be "*" or a method name` (for example `write-guard: allow[0].method: must be "*" or a method name`);
  - `allow`, `writes`, `controls.text` or `controls.icons` that is not a list;
  - a Sig that is not an object;
  - a `url`, a `body` other than `null`, or a `controls.text` entry that is not a non-empty string or does not compile;
  - a Sig `headers` other than `null` that is not an object, which throws `write-guard: <path>.headers: must be an object` (for example `write-guard: allow[0].headers: must be an object`);
  - a `headers` value that is not a non-empty string or does not compile, which throws the same messages as `url` (`must be a non-empty regex string`, `does not compile: <message>`), with the header name as written in the config as the path (for example `write-guard: allow[0].headers.Next-Action: must be a non-empty regex string`);
  - a `controls.icons` entry that is not a non-empty string;
  - `controls` that is not an object;
  - `defaultControls` that is not a boolean;
  - `logBodies` that is not a boolean, which throws `write-guard: logBodies: must be a boolean`;
  - `log` that is neither a non-empty string nor `null`.

  The result is `{ policy, allow, writes, text, icons, websockets, websocketWrites, suspect, log, logBodies }`: `allow` and `writes` hold `{ method, url: RegExp, body: RegExp | null, headers: Array<{ name: string, value: RegExp }> }`, where `method` is `"*"` or the method name in upper case and `headers` holds one entry per named header, its `name` in lower case (empty when the Sig names none); `text` is the label pattern (`null` when there is none); `icons` is `controls.icons`; `websocketWrites` is a `RegExp[]`, one per source, each compiled with no flags (empty by default); `suspect` is the suspect pattern, a single case-insensitive `RegExp` made of the built-in pattern (unless `defaultSuspectGets` is `false`) and every `suspectGets` source, each wrapped in `(?:...)` and joined with `|`, or `null` when there are none; `logBodies` is `false` unless the config sets it to `true`.
- `decideRequest({ method, url, body, headers }, compiled)` returns `{ action, reason }`. `body` is `null` or absent when the request has none. `headers` is an object of header name to value, names in any case (`decideRequest` lower-cases them itself), absent when the request has none, in which case no Sig that names headers matches. For a write, `action` is `"block"` under `read-only` and `"observe"` under `observe`; for anything else it is `"allow"`.
- `decideControl({ label, icons }, compiled)` returns `{ action, reason }`. For a destructive control, `action` is `"block"` under `read-only` and `"observe"` under `observe`; for anything else it is `"allow"`.
- `decideFrame(text, compiled)` returns `{ action, reason }` for one outbound WebSocket frame. When `text` is a string that matches any `compiled.websocketWrites` pattern (tested unanchored), `action` is `"block"` under `read-only` and `"observe"` under `observe`. A string that matches none, and a frame that is not a string (a binary frame), are always `"allow"`. With an empty `websocketWrites`, every frame is `"allow"`.
- `decideSuspect({ method, url }, compiled)` returns `{ suspect, reason }`, where `suspect` is a boolean. It is `true` only when `method`, upper-cased, is `GET` or `HEAD`, `compiled.suspect` is not `null`, and `compiled.suspect` matches the tested string: the URL's `pathname` followed by its `search` when `new URL(url)` parses it, else `url` as given (a relative or unparsable URL). It never depends on the policy: a suspect request is recorded, never blocked, by the callers described under the installer.
- `reason` is a short human-readable explanation; its wording is not part of the API.

`compileConfig`, `decideControl` and `decideSuspect` reference nothing outside their own arguments, because the installer injects their source text into every page. `decideFrame` runs only in Node, in the process that called `install`.

### The installer: `playwright-write-guard/install`

`install(context, config?)` guards one Playwright `BrowserContext` and returns `Promise<GuardHandle>`. It compiles `config` (default `{}`) with `compileConfig`, so a malformed config throws before anything is installed. A second call on the same context returns the first call's handle and ignores its own `config`. It:

1. Registers one catch-all `context.route`, matching every URL, before anything else. Page handlers run before context handlers, and context handlers run in reverse order of registration, so in the guard's process the catch-all is the last of the handlers registered after `install`.
2. Wraps `context.route` and the `route` of every page in the context, present and future. A handler registered through them receives every request, blocked writes included, and gets a route on which:
   - `continue(options)` and `fetch(options)` are egress points, judged as in step 3;
   - `fallback(options)` is not judged: it passes the request to the next handler with its overrides applied, so the next handler's `route.request()` reflects them, and they are judged at the egress where the request finally leaves;
   - `fulfill(options)` and `abort(errorCode)` are mock points. Before calling Playwright's own `fulfill` or `abort` with the same arguments, the guard judges the request as that handler received it, with `decideRequest`: the method (upper-cased), URL, body and headers of `route.request()`, which reflects earlier `fallback` overrides. The body is `route.request().postData()`, judged as none when it cannot be decoded; the headers are `route.request().headers()`, names lower-cased. The arguments of `fulfill` and `abort` play no part. When the action is not `allow` (`block` or `observe`, under either policy), the guard records a `request` event with `action: "mocked"` and the usual request fields; either way the call then proceeds unchanged, so a test can still mock a write by fulfilling it. One exception: a `fulfill` or `abort` of a request that already reached egress through `fetch()`, by any handler, records nothing, because that request was judged at that egress. A request a caller fulfills or aborts is never recorded as `suspect`. Mocked events count in `mocked`, never in `blocked`, `observed` or `routed_requests`.

   The wrapped `unroute` and `unrouteAll` remove only the caller's own handlers, never the guard's. This applies in the fixture, the `initPage` entry and a direct `install`; in launcher mode it covers only the launcher's own process (see below), so a launcher client's own route that fulfills or aborts a write runs in the client's process and records nothing.
3. Judges each request at **egress**, the point where it would leave the browser. There are three egress points: (a) the guard's catch-all, reached when every handler before it fell back; (b) a caller's `route.continue(options)`; (c) a caller's `route.fetch(options)`. Each egress judges the effective request with `decideRequest`:
   - At (a) and (b), for each of method, URL and body, the effective value is the one in `options` when given, else the request's as it reached that point (`route.request()`, which reflects earlier `fallback` overrides). A `postData` Buffer is read as UTF-8 and any other non-string `postData` as its JSON encoding; a body that cannot be decoded is judged as none. The effective method is upper-cased.
   - At (a) and (b), headers are a whole set, never merged: the effective headers are `options.headers` when given (Playwright replaces the full set), else `route.request().headers()`, with names lower-cased.
   - At (c), the guard judges what Playwright 1.64's `route.fetch(options)` sends: it passes the merged options `m = { request: route.request(), data: options.postData, ...options }` to the context's request client, so the effective request (method, URL, headers and body) is that of an `APIRequestContext` send with those merged options `m`, by the same rule as under Request clients below, with the context client's `baseURL` (the `baseURL` option the context was created with). `route.request()` reflects earlier `fallback` overrides; because `...options` comes last, `options.url`, `options.method`, `options.headers`, `options.data` and `options.request` override it.
   - At every egress, the event's `contentType` is the effective `content-type` header, and its `headerNames` are the effective header names.
   - On `block`: (a) and (b) fulfill a request whose resource type is `document` with status 403, content type `text/html; charset=utf-8`, and a short HTML page reading `write-guard blocked <METHOD> <URL>` (the effective method and URL, HTML-escaped), so a blocked navigation shows why instead of a browser error page, and abort any other request with `'blockedbyclient'`, which the page sees as a network error; (c) rejects with `write-guard: route.fetch of <METHOD> <URL> is refused under read-only`, with the effective method and URL.
   - On `allow`, when the effective method is GET or HEAD and `decideSuspect({ method, url }, compiled)` returns `suspect: true` for the effective method and URL, the guard records a `request` event with `action: "suspect"` and the reason `decideSuspect` returned. A suspect request is never blocked.
   - On `allow` or `observe` (`observe` records the event first, and so does a suspect `allow`): (a) proceeds with `route.fallback()`, never `continue()`, so handlers registered behind it (a launcher client's `context.route`) still run; (b) and (c) call Playwright's own `continue` or `fetch` with the same options.
   - Each egress attempt records at most one event (none when the request is allowed and not suspect). `routed_requests` counts each request once, at its first egress; a request a caller fulfills or aborts without reaching an egress is not counted.
4. Registers one `context.routeWebSocket`, matching every URL, under both `websockets` settings and either policy:
   - Under `"allow"`, each socket is recorded as `{ kind: "websocket", action: "open", url, at }` and connected with `ws.connectToServer()`. When `websocketWrites` is empty, that is all the route does (as in 0.2.x), and no message is judged or logged.
   - Under `"allow"` with a non-empty `websocketWrites`, the route keeps the server side that `ws.connectToServer()` returns and judges each message the page sends with `decideFrame(message, compiled)`, in order: on `"block"` the message is dropped (never forwarded to the server) and recorded as `{ kind: "websocket", action: "block", reason, url, at }`; on `"observe"` it is recorded the same way with `action: "observe"` and then forwarded; on `"allow"` it is forwarded with no event. A binary message is always forwarded. With `logBodies: true`, a frame event also carries `frame`, the first 500 characters of the message. Messages the server sends to the page are never judged and always arrive. Dropping a message does not close the socket.
   - Under `"block"`, each socket is closed with code 1008 without connecting to the server, and recorded as a `request` event with `action: "block"` and the socket's `url` (no `method`).

   No socket or frame counts in `routed_requests`. An `open` event counts in neither `blocked` nor `observed`; a frame event counts in `blocked` or `observed` by its `action`. Because the guard always routes sockets: under both settings Playwright replaces the page's `WebSocket` with its routed implementation; in launcher mode an attached client cannot register its own `routeWebSocket` (Playwright throws `Another client is already routing WebSockets`); in the guard's process a caller's own `routeWebSocket` registered later takes precedence, and then no open is recorded, no frame is judged, and `"block"` does not refuse that socket; sockets opened by dedicated or shared workers are not routed, so they are neither recorded nor blocked, and their frames are not judged.
5. Adds an init script that runs before any page script, with capture-phase `click`, `submit` and `keydown` (Enter or Space) listeners on `window` that find the control as described under Writes and controls and judge it: with `decideSuspect` when it is a link that navigates, else with `decideControl`. The script carries the source of `compileConfig`, `decideControl` and `decideSuspect`, compiled from the same raw config. Under `read-only` a destructive control's event (a suspect link's included) is stopped (`preventDefault` and `stopImmediatePropagation`), so the app never sees it and a suspect link does not navigate, and the page calls its original `console.warn`, which the script captures before any page script runs, with exactly `write-guard refused "<label>": <reason>`, where `<label>` is the control's label cut to 120 characters and `<reason>` is the reason `decideControl` (or, for a link, `decideSuspect`) returned. Under `observe` the event goes through and nothing is written to the console. Either way the page reports the event through the binding `__writeGuardReport`, which the script captures before any page script can replace it.
6. Under `read-only`, dismisses every dialog (`alert`, `confirm`, `prompt`, `beforeunload`) on every page, so a native confirmation before a delete is declined.
7. Under both policies, judges every send through the context's request client. It wraps `context.request` once, as `guardRequestClient(context.request, { baseURL })` does (below), with `baseURL` the `baseURL` option the context was created with, and makes `context.request` and the `request` of every page in the context, present and future, return that one wrapper. A page's `request` is the same object as its context's (Playwright 1.64), so each send is judged once and records at most one event. Every property that is not a send method stays readable, with methods bound to the raw client. This wrapper exists only in the process that called `install`.

**Request clients.** A request client is an `APIRequestContext` (wrapped by step 7, by `guardRequestClient`, and by the fixture's `request`) or Node's `fetch` (wrapped by `guardFetch`, and by the fixture while a test runs). Each send is judged with `decideRequest` on its effective request, under both policies:

- **An `APIRequestContext` send** is a call to `fetch`, `get`, `post`, `put`, `patch`, `delete` or `head` on the wrapper; every property that is not one of these send methods reads through to the client, with methods bound to the raw client. The guard builds the merged options `m` that Playwright 1.64 builds before it sends, judges what Playwright would send, and reads its effective request from `m`:
  - Merged options: for `fetch(a, options)`, `m = { url: a when a is a string, request: a otherwise, ...options }`. For `get`, `post`, `put`, `patch`, `delete` and `head`: the same, followed by `method: NAME`, the method's name in upper case (`m = { url: a when a is a string, request: a otherwise, ...options, method: NAME }`). Because `...options` comes after the first argument, `options.url`, `options.request` and `options.headers` override what the first argument gave, and so does `options.method` for `fetch`; a `request` here is a Playwright `Request`, given as the first argument or as `options.request`.
  - Method: `m.method || m.request?.method() || 'GET'`, upper-cased.
  - URL: `m.url !== undefined ? m.url : m.request.url()` (an `APIRequestContext` rejects URL objects). It is resolved against the client's `baseURL` when one is set (`new URL(url, baseURL)`, so an absolute URL stays as it is), else parsed alone (`new URL(url)`); when resolving against `baseURL` throws (an invalid `baseURL`), it is parsed alone. Then `m.params`, when given, is applied as Playwright 1.64 applies it: a string or `URLSearchParams` whose string form is non-empty replaces the query (`u.search = String(params)`); an empty one leaves the URL unchanged; any other non-null object appends (an array included) its `Object.entries`, skipping `undefined` (`u.searchParams.append(name, String(value))`, in `Object.entries` order); any other value leaves the URL unchanged (a number, or `null`). The judged URL is the resulting URL with its fragment removed (`u.hash = ''` before reading `href`), the URL a server receives, and the event's `url` has that form. Only when parsing alone throws too (a relative URL with no `baseURL` or with an invalid one, or an unparsable URL) is the URL judged as the raw string, with no params applied.
  - Headers: `m.headers || m.request?.headers()`, else none; entries whose value is `undefined` are skipped (Playwright does not send them), and names are lower-cased. The effective `content-type` header is the first entry whose name lower-cases to `content-type`, as Playwright reads it. Headers the client adds itself (its `extraHTTPHeaders`, a `content-type` it sets for `data`) are not part of the effective request.
  - Body: `m.data` when it is not `undefined`: a string as is, except that when the effective `content-type` header is exactly `application/json` (no parameters) and the string does not parse as JSON (`JSON.parse` throws), it is judged as its `JSON.stringify` encoding, which is what Playwright sends; a Buffer as UTF-8; any other value as its `JSON.stringify` encoding. Else, when neither `m.form` nor `m.multipart` is given (Playwright tests each for a truthy value), `m.request?.postDataBuffer()` read as UTF-8, so the body of a given `Request` is judged; `null` when that returns `null` or there is no `m.request`. Else `null`: a `form` or `multipart` body is not judged by body.
- **A Node `fetch(input, init)` call.** Its effective request:
  - Method: `init.method`, else the `method` property of `input` when it is a Request, else `GET`, upper-cased. A given input is a Request only when `input instanceof globalThis.Request`.
  - URL: `input` when it is a string, its `url` property when it is a Request (`input instanceof globalThis.Request`), and `String(input)` for any other input (for an ordinary `URL` that equals its `href`); when that parses as an absolute URL, the judged URL is its `href` with its fragment removed (`u.hash = ''` before reading `href`), the URL a server receives, and the event's `url` has that form; else the raw string.
  - Body: `init.body` when it is a string, else `null` (a stream, `FormData`, `URLSearchParams`, Blob or buffer body, and the body of a given `Request`, are not judged by body).
  - Headers: `init.headers`, else the `headers` of `input` when it is a Request (`input instanceof globalThis.Request`), else none; each (a plain object, an array of name and value pairs, or a `Headers`) is normalised through `new Headers(h)`, so repeated names are joined with `, ` as fetch sends them, and then passed with lower-cased names.
- **The decision.** On `block`, the send rejects without sending, with `write-guard: <METHOD> <URL> through <via> is refused under read-only`, where `<METHOD>` and `<URL>` are the effective method and URL and `<via>` is `APIRequestContext` or `fetch` (for example `write-guard: POST https://app.example.test/items through APIRequestContext is refused under read-only`). On `observe`, it records the event and sends. On `allow`, it sends, and first records a `suspect` event when `decideSuspect` says the effective method and URL are suspect. A send is passed on with its original arguments, untouched.
- **The event** is a `request` event with the effective `method`, `url`, `contentType`, `headerNames` and (with `logBodies: true`) `body`, plus `via`: `"request-client"` for an `APIRequestContext`, `"node-fetch"` for Node's `fetch`. These events count in `blocked`, `observed` or `suspect` by their `action`, never in `routed_requests`.

If the binding `__writeGuardReport` is already registered on the context, another process guards it (as when an agent attached to the launcher also loads the `initPage` entry), and `install` throws `write-guard: this context is already guarded by another process; use one mode, not both`. That check happens before anything is installed, so a refused `install` leaves nothing behind.

`install` cannot change how the context was created: create it with `serviceWorkers: 'block'`, or a service worker can send requests the guard never sees. The fixture, the launcher and the `initPage` config below all do.

**Events.** Every blocked or observed write is one event, and so is every write a caller's route mocks, every suspect GET or HEAD, every blocked or observed WebSocket frame, and every WebSocket opened under `websockets: "allow"`:

```ts
{ kind: 'request', action: 'block' | 'observe' | 'mocked' | 'suspect', reason: string,
  method?: string, url: string, via?: 'request-client' | 'node-fetch',
  contentType?: string, headerNames?: string[], body?: string, at: string }
{ kind: 'control', action: 'block' | 'observe', reason: string, label: string, at: string }
{ kind: 'websocket', action: 'open', url: string, at: string }
{ kind: 'websocket', action: 'block' | 'observe', reason: string, url: string, frame?: string, at: string }
```

- A request event's `action` is `"block"` or `"observe"` for a write judged at an egress point or a request-client send (the `decideRequest` action), `"mocked"` for a write a caller's route fulfilled or aborted (installer step 2), and `"suspect"` for an allowed GET or HEAD that `decideSuspect` marks suspect (step 3 and the request clients).
- A request event carries the effective `method` (upper case) and `url`; a socket refused under `websockets: "block"` carries its `url` and no `method`. It carries `contentType` when the effective request has a `content-type` header, and, only with `logBodies: true`, `body`: the first 500 characters of the effective request body, when the request has one.
- Every request event that has a `method` carries `headerNames`: the effective request's header names, lower-cased, without duplicates, sorted with `Array.prototype.sort` (code unit order); `[]` when it has none. Header values are never recorded. A socket refused under `websockets: "block"` has no `headerNames`.
- A request event carries `via` only when it comes from a request client: `"request-client"` for an `APIRequestContext` send, `"node-fetch"` for a Node `fetch` call. Events of requests the browser sent have no `via`.
- A control event carries `label` (trimmed, at most 120 characters) and none of the request fields. A suspect link (see Writes and controls) is a control event.
- A websocket `open` event carries `url` and no `reason`. A websocket frame event (`"block"` or `"observe"`) carries `reason` and the socket's `url`, and, only with `logBodies: true`, `frame`: the first 500 characters of the frame's text.
- `at` is an ISO 8601 timestamp. Allowed requests that are not suspect, allowed frames and allowed controls produce no event.

**The handle.**

- `record()` returns `{ installed: true, policy, routed_requests, blocked, observed, mocked, suspect, events }`: `routed_requests` counts the requests the guard judged at browser egress, each once, at its first egress, and no WebSockets, mocks or request-client sends; `blocked` and `observed` count request, control and websocket events by their `action` (`"block"` or `"observe"`), and websocket `open` events count in neither; `mocked` counts request events with `action: "mocked"`, and `suspect` request events with `action: "suspect"`. Each event counts in at most one of `blocked`, `observed`, `mocked` and `suspect`.
- `close()` resolves after the last pending log append and returns the final `record()`. The guard stays active until the context closes.
- `guardRequestClient(client, { baseURL })` returns a wrapper over the `APIRequestContext` `client` whose sends are judged as described under Request clients, with this guard's config, and recorded in this guard's record and log with `via: "request-client"`. `baseURL` is optional; without it, a relative URL is judged as the raw string. Every property that is not a send method reads through to `client`, with methods bound to the raw client. The fixture uses it for the `request` fixture.
- `guardFetch(fetchFn)` returns a function with `fetchFn`'s signature that judges each call as described under Request clients, with this guard's config, records it in this guard's record and log with `via: "node-fetch"`, and then either rejects or returns `fetchFn(input, init)` called with the same arguments. The fixture uses it for Node's global `fetch` while a test runs.

**The audit log.** When `config.log` is a path, each event is appended to that file as one JSON line, as it happens. The path is relative to the process's working directory; the file is created when missing and never truncated.

**`loadConfig(path?)`** returns a raw config to pass to `install`. It reads, synchronously with `fs.readFileSync`, the first of: `path`; else the file named by the environment variable `WRITE_GUARD_CONFIG`; else `write-guard.config.json` when that file exists; else it uses `{}`. Relative paths resolve against the process's working directory. A file named by `path` or `WRITE_GUARD_CONFIG` must exist, or `loadConfig` throws. When the environment variable `WRITE_GUARD_POLICY` is set to a non-empty value, it overrides `policy`. The result is validated with `compileConfig`, so a file that does not parse as JSON, an invalid config or an invalid `WRITE_GUARD_POLICY` throws. A file that cannot be read throws `write-guard: <file>: cannot be read: <system message>`, and a file that does not parse throws `write-guard: <file>: is not valid JSON: <parser message>`, where `<file>` is the path as resolved. Every entry point below that defaults to `loadConfig()` therefore honours `WRITE_GUARD_CONFIG` and `WRITE_GUARD_POLICY`; a config you pass explicitly to `install`, `test.use` or `startGuardedBrowser` is used as given.

### The Playwright Test fixture: `playwright-write-guard/test`

```js
import { test, expect } from 'playwright-write-guard/test';

test.use({ writeGuardConfig: { policy: 'read-only', allow: [] } });

test('lists items without changing them', async ({ page }) => {
  await page.goto('https://app.example.com/items');
  await expect(page.getByRole('list')).toBeVisible();
});
```

- `test` and `expect` are Playwright Test's, extended with one option fixture, `writeGuardConfig`, settable with `test.use`. It defaults to `loadConfig()`, which resolves relative to the working directory: running Playwright with `-c` from another directory needs `WRITE_GUARD_CONFIG` to find the config.
- The `context` fixture is created with `serviceWorkers: 'block'` and guarded with `install`, with `log` forced to `null` (the fixture never writes a log file). That also judges every send through `context.request` and `page.request` (installer step 7). A test whose effective `serviceWorkers` option is not `'block'` fails at fixture setup with an error starting `write-guard: serviceWorkers is`, because a service worker could send requests the guard never sees. This is the test's guard: its record is `write-guard.json`.
- The `request` fixture works under both policies. Playwright creates it with `playwright.request.newContext()` (the one call of that method the fixture lets through), and the fixture hands it over as `guardRequestClient(request, { baseURL })` from the guard of the `context` fixture (0.2.x already forces a context in every guarded test), with `baseURL` the `baseURL` fixture. In a test and its `beforeEach` and `afterEach` hooks that is the test's guard, and the events (`via: "request-client"`) are in `write-guard.json`; in a `beforeAll` or `afterAll` hook Playwright sets up a `context` for that hook, and that context's guard judges the sends. Each send is judged as described under Request clients, so a GET goes through and, under `read-only`, a write rejects without sending.
- While a guarded test's own function runs (not a `beforeAll`, `afterAll`, `beforeEach` or `afterEach` hook), Node's global `fetch` is replaced by the test guard's `guardFetch(fetch)`, so each call is judged as described under Request clients and its events (`via: "node-fetch"`) are in `write-guard.json`.
- While a guarded test's own function runs, `browser.newContext(options)` returns a guarded context: it creates the context with `serviceWorkers` set to `'block'` (when `options.serviceWorkers` is given with any other value, it throws the same `write-guard: serviceWorkers is ...` error as above, before creating anything), then guards it with `install`, using the test's config with `log` forced to `null`, before returning it. At the end of the test, each such context's `record()` is attached as `write-guard-<n>.json` (`application/json`), numbered from 2 in the order the contexts were created. `browser.newPage(options)` goes through that same `newContext` (Playwright 1.64 calls it internally), so its page's context is guarded and numbered the same way; `newPage` attaches nothing of its own. Playwright's own creation of the test's context is outside this wrapper, and is not numbered.
- Under both policies, in a guarded worker, these throw an error starting `write-guard:` because they would make a browser context, request context or connection the guard cannot see:
  - outside a guarded test's own function (in any hook, `beforeAll`, `afterAll`, `beforeEach` or `afterEach`, and in fixture setup and teardown), `browser.newContext`, `browser.newPage` and Node's global `fetch`, as in 0.2.x, except Playwright's own creation of the test's context;
  - everywhere, `playwright.request.newContext`, except Playwright's own creation of the `request` fixture;
  - everywhere, the browser types' `launch`, `launchPersistentContext`, `launchServer`, `connect` and `connectOverCDP`.
- Each test attaches its guard's `record()` as `write-guard.json` (`application/json`), and each context it created with `browser.newContext` or `browser.newPage` as `write-guard-<n>.json`.

### The `initPage` entry: `playwright-write-guard/init-page`

The default export is `async ({ page }) => install(page.context(), loadConfig())`, and is idempotent per context: every new tab calls it, and the context is guarded once. Playwright MCP and the Playwright CLI run each `browser.initPage` entry with `require(path).default({ page })` in their own process for every new tab, before any tool acts. Load it with this config (MCP's `--config` file, or the CLI's `.playwright/cli.config.json`):

```json
{
  "browser": {
    "initPage": ["/absolute/path/to/node_modules/playwright-write-guard/src/init-page.mjs"],
    "contextOptions": { "serviceWorkers": "block" }
  }
}
```

Because it is loaded with `require`, nothing in its import graph uses top-level await, and Node must support `require` of ES modules: Node 20.19 or newer, or 22.12 or newer. `loadConfig()` resolves against the agent server's working directory, so set `WRITE_GUARD_CONFIG` to an absolute path when in doubt. The log, when on, is written there too.

In this mode the guard lives in the same process as the agent's tools, so the agent can remove it. Deny the tools that can, for example in Claude Code's `permissions.deny`:

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

### The launcher: `playwright-write-guard/browser`

`startGuardedBrowser({ config, headless = true, host = '127.0.0.1', port = 0, title = 'write-guard' })` returns `Promise<{ wsEndpoint, browser, context, guard, close() }>`. It launches Chromium with `playwright-core`, creates one context with `serviceWorkers: 'block'`, guards it with `install(context, config)` (`config` defaults to `loadConfig()`), and calls `browser.bind(title, { host, port })`; `wsEndpoint` is the `endpoint` that returns, `ws://<host>:<port>/<id>` (`port: 0` lets the OS pick a free port). `guard` is the install handle. `close()` waits for `guard.close()`, then closes the context and the browser.

A client attaches with `chromium.connect(wsEndpoint)` and sees the guarded context as `contexts()[0]`. The guard runs in the launcher's process, so the client's own `unroute` and `unrouteAll()` cannot remove it, and a `page.route` handler that calls `continue()`, with or without overrides, is still judged (page handlers run before the owner's context route, and the request reaches the guard's catch-all with the overrides applied). New tabs the client opens in that context are guarded. A client's `page.route` handler can `fulfill` or `abort` a write, so it can mock one; that handler runs in the client's process, so the mock is not recorded as `mocked`. A client's `context.route` handler runs after the guard's catch-all, in the client's process: it receives only requests the catch-all already judged and let through, so it cannot mock a blocked write, its `continue()` or `fallback()` overrides are not judged again, and its `route.fetch()` is not seen; see "What it cannot see" below. The client cannot register its own `routeWebSocket`, because the guard already routes every WebSocket (Playwright throws `Another client is already routing WebSockets`).

The command does the same from a shell:

```
npx playwright-write-guard-browser [--config <path>] [--headed] [--host <h>] [--port <n>]
```

`--config` is passed to `loadConfig` (so without it, `WRITE_GUARD_CONFIG` and `write-guard.config.json` apply), `--headed` sets `headless` to false, and `--host` and `--port` default to `127.0.0.1` and `0`. It prints `endpoint: <ws endpoint>` on a line of its own, then how to attach: Playwright MCP with `--endpoint <ws endpoint>` and without `--isolated` (which uses `contexts()[0]`), or the Playwright CLI with `playwright-cli attach --endpoint=<ws endpoint>`. It stays up until SIGINT or SIGTERM, then closes the browser and exits 0. An unknown flag or a flag missing its value prints the usage line and exits 1.

### The suggest command: `playwright-write-guard-suggest`

```
npx playwright-write-guard-suggest <log.jsonl>
```

It reads an audit log and drafts `allow` entries for the writes it lists. It reads only that file and never writes one.

- **Input.** It reads the file as UTF-8 and splits it into lines. A line that does not parse with `JSON.parse` (an empty line included) is skipped, and so is a parsed line that is not an object with a non-empty string `method` (control events, websocket events, refused sockets). Of the rest it keeps `request` events whose `action` is `"observe"`, `"block"` or `"mocked"`; `suspect` events are skipped. An event whose `url` does not parse as an absolute URL (`new URL(url)` throws) is skipped too.
- **Grouping.** Kept events are grouped by `method` and by origin plus path: `u.origin + u.pathname` for `u = new URL(url)`, so the query and the hash are dropped.
- **Output.** It prints to stdout one JSON document, `JSON.stringify({ allow }, null, 2)` followed by a newline. `allow` holds one entry per group, `{ "method": M, "url": "^<origin and path, escaped>(?:[?#]|$)" }`, where escaped means each of the characters `\ ^ $ . * + ? ( ) [ ] { } |` is preceded by a backslash. Entries are sorted by `url`, then by `method`, both in code unit order. With nothing kept, `allow` is `[]`.
- **Hints.** It prints to stderr one line per entry, in the same order: `<count> x <METHOD> <origin and path>`, where `<count>` is the number of events in the group and the origin and path are not escaped. When any event in the group has `next-action` in its `headerNames`, the line goes on with `: carries next-action, pin its action IDs with a headers entry`; otherwise, when the path ends with `/graphql`, with `: GraphQL, add an anchored body pattern`. It then exits 0.
- **Errors.** With no argument, more than one argument, or a file that is missing or cannot be read, it prints `usage: playwright-write-guard-suggest <log.jsonl>` to stderr, nothing to stdout, and exits 1.

For a log holding three blocked `POST https://app.example.test/graphql?op=1` events, stdout is:

```json
{
  "allow": [
    {
      "method": "POST",
      "url": "^https://app\\.example\\.test/graphql(?:[?#]|$)"
    }
  ]
}
```

and stderr is `3 x POST https://app.example.test/graphql: GraphQL, add an anchored body pattern`. Each entry allows every request with its method to its path, whatever the body or headers, so the output is a draft to review: narrow each entry with a `body` or `headers` pattern, and drop any that is a real write, before putting it in `allow`.

### What it cannot see

- `APIRequestContext` objects the guard cannot reach: an attached client's own `page.request` and `context.request` in launcher mode, and `playwright.request.newContext()` called from an agent's run-code tool.
- An agent's run-code tool, and any browser the agent launches itself.
- A Playwright Test run with `-c` from another directory without `WRITE_GUARD_CONFIG`: the fixture finds no config file and falls back to the defaults.
- WebSocket messages: under the default `websockets: "allow"`, each socket a page opens is recorded as a `websocket` event, but its messages (writes included) are not judged or logged. `"block"` refuses every socket the guard routes.
- WebSockets opened by dedicated or shared workers: they are not routed, so they are neither recorded nor blocked, under either setting.
- A caller's own `routeWebSocket` registered after the guard in the same process takes precedence: no open is recorded, and `websockets: "block"` does not refuse that socket. In launcher mode an attached client cannot register its own `routeWebSocket`: Playwright throws `Another client is already routing WebSockets`.
- The page's `WebSocket`: under both settings Playwright replaces it with its routed implementation, which is noticeably slower.
- WebRTC and WebTransport.
- Redirects after the first URL: only the request the page made is judged, not where the server redirects it.
- Drag-and-drop, and pointer or mouse handlers that act before `click`.
- Client-side-only destructive actions that no click or submit reaches.
- Requests are classified only as well as the config: a write sent as GET, or a read sent as POST, needs a `writes` or `allow` signature.
- GET requests with side effects pass with no event unless a `writes` signature names them, and `observe` does not list GETs.
- Reads that send no query text (persisted GraphQL queries without an operation name): when nothing in the method, URL, headers or body tells such a read from a write, a signature that allows the endpoint allows its mutations too.
- Request bodies unless `logBodies` is `true`, and request headers other than the content type: events record the method, URL and content type. `logBodies` is off by default because bodies can hold credentials and personal data.
- In launcher mode, mocking a blocked write from a client's `context.route`: that handler runs after the guard's catch-all, so it never receives a blocked write. A client's `page.route` can mock one.
- Writes that one of your own routes fulfills or aborts: they never leave the browser and are not recorded, so a broad stub such as `page.route('**/api/**', ...)` can hide writes from the log and from the `blocked` count.
- The launcher's browser and context options: it takes no storage state, proxy, `ignoreHTTPSErrors` or HTTP credentials.
- The HTTP cache: Playwright turns it off while a route is installed.
- Service workers: `register()` resolves but `navigator.serviceWorker.ready` never settles.
- Any context other than `contexts()[0]` in launcher mode: `--isolated`, or `browser.newContext()` from an agent's run-code tool, makes a new, unguarded context.
- A client's `context.route` overrides in launcher mode are not judged again: that handler runs after the guard, in the client's process, so a `continue()` or `fallback()` that rewrites the method, URL or body (a GET rewritten to DELETE) reaches the server.
- A client's `route.fetch()` from any route handler (`page.route` or `context.route`) in launcher mode is not seen: it is sent through the client's own `APIRequestContext`, which the guard cannot reach.
- Code in the same process that calls Playwright's prototype methods directly (for example `Object.getPrototypeOf(context).route` or `.unrouteAll`, `Object.getPrototypeOf(route).continue`, or `Object.getPrototypeOf(context.request).fetch`, which goes around the read-only lock on `APIRequestContext`) or removes the guard's own `page` or `dialog` listeners (`context.removeAllListeners('page')` leaves new pages' routes unwrapped; `context.removeAllListeners('dialog')` lets a caller accept a dialog) goes around the guard's wrappers: the route it registers is not wrapped (its `continue()` can send a POST), `unrouteAll` removes the guard, and a `continue` with overrides skips the override judging.
- Routes and dialog listeners registered before `install`: a `page.route` whose `continue()` sends a write, a `context.route` whose overrides are not judged, and a page `dialog` listener that accepts all run outside the guard's wrappers.
- Under `observe`, sends through `context.request`, `page.request` and the `request` fixture are neither blocked nor recorded (only read-only locks them), so an observe run does not list them.
- Controls the page does not judge: anchors without `href`, `<input type=reset>`, `summary`, plain elements that have only an `onclick` attribute or a `tabindex` (rows, cards), controls inside closed shadow roots, and plain text outside any control. The network layer still judges any request they send. Open shadow roots are judged through the event's composed path, using the shadow host's label when the control has none. An image input is never found by the submit fallback, so a `requestSubmit()` with no submitter on a form whose only submit control is an image input is not judged in the page (the network layer still judges the request).
- A document loaded with `page.setContent()`: the guard's in-page listeners do not carry over into it, so a destructive click there is not refused in the page. The network layer still judges any request it sends.
- Node's own `http`, `https` and `net` modules in the test process.
- Links whose text holds a built-in verb are refused in the page even when following them only reads (a help page link "Delete a repository", a navigation item "Archive").

It is a safety net, not a security boundary. A restricted test account is the boundary.

## License

MIT. See [LICENSE](LICENSE). Written by Venkata Sandeep Takasi.
