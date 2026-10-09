# playwright-write-guard

A read-only safety net for Playwright tests and AI browser agents. It blocks every request whose method is not GET, HEAD or OPTIONS (unless you allow-list it) at the network layer, refuses destructive clicks inside the page before the app sees them, and writes a JSON audit log of every write it blocked or observed. Use it with Playwright Test through one import, or with Playwright MCP and the Playwright CLI either through a one-line `initPage` config entry or through a launcher that owns the browser the agent attaches to. It has no runtime dependencies and no build step. It is a safety net, not a security boundary: a restricted test account is the boundary.

## What it is and why

Pointing an automated browser at a real app is risky when the run should only look. A test that clicks through a settings page, or an agent asked to "find out what this dashboard shows", can press Save, Delete or Send, or fire a POST, and change real data.

This package puts a read-only guard in front of the browser:

- **Requests.** Any request whose method is not GET, HEAD or OPTIONS is blocked, unless a signature in your `allow` list says it is really a read (a read-only GraphQL endpoint, for example). Requests that are really writes but look like reads can be named in `writes`.
- **Clicks.** A click, form submit, or Enter or Space keypress on a control whose label is a destructive verb (Save, Delete, Publish, Send and so on) is stopped inside the page before the app's own handlers run. Native confirmation dialogs are declined.
- **Log.** Every write it blocked, or only observed under the `observe` policy, is recorded as one JSON line.

See it work end to end, with a local page and a local server, in the walkthrough at [demo/README.md](demo/README.md) (`node demo/run.mjs`).

## Install

```
npm i -D playwright-write-guard
npx playwright install chromium
```

It needs Node 20 or newer and Playwright 1.59 or newer: `@playwright/test` for the fixture, and `playwright-core` for the launcher and its command. Using the `initPage` entry with an agent needs a Node that can `require` an ES module (see below).

## Use with Playwright Test

Swap one import. Everything else in your tests stays the same:

```js
// before
// import { test, expect } from '@playwright/test';
import { test, expect } from 'playwright-write-guard/test';

test('lists items without changing them', async ({ page }) => {
  await page.goto('https://app.example.test/items');
  await expect(page.getByRole('list')).toBeVisible();
});
```

The fixture guards each test's context, created with `serviceWorkers: 'block'`. By default it reads `write-guard.config.json` from the directory you run Playwright in. Every key is optional; a small example that lets a read-only GraphQL endpoint through and blocks everything else:

```json
{
  "policy": "read-only",
  "allow": [
    { "method": "POST", "url": "^https://app[.]example[.]test/graphql$" }
  ],
  "controls": { "icons": ["icon-trash"] }
}
```

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

Pick one mode for a given browser. Using both at once is refused: the second guard throws `write-guard: this context is already guarded by another process; use one mode, not both`.

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

The guard runs in the launcher's process, not the agent's. The agent's own `route`, `unroute` and `unrouteAll` tools cannot remove it, and a handler that calls `continue()` still goes through the guard, so this mode survives the route tools the config mode has to deny. Tabs the agent opens in that context are guarded too. Stop it with Ctrl+C.

## The audit log

When `log` is a path (default `write-guard.jsonl`, relative to the process's working directory), each blocked or observed write is appended as one JSON object per line, as it happens. The file is created when missing and never truncated. Allowed requests and controls are not logged. Set `"log": null` to turn it off.

A blocked request and a refused control look like this (one line each in the file):

```json
{"kind":"request","action":"block","reason":"POST is not a read method; policy read-only","method":"POST","url":"https://app.example.test/items","at":"2026-01-15T09:30:00.000Z"}
{"kind":"control","action":"block","reason":"\"Delete item\" matches a destructive label; policy read-only","label":"Delete item","at":"2026-01-15T09:30:02.000Z"}
```

A request event carries `method` and `url`; a control event carries `label` and neither. `reason` is a human-readable note whose wording may change. Under the `observe` policy the same events are recorded with `"action":"observe"` and the write goes through, which is a way to find out what a run would have blocked. The full event shape is in the API below.

## What it cannot see

The guard judges requests the browser sends through its context and clicks the page makes. These are outside it:

- Request clients it does not own: an attached client's own `page.request` and `context.request` in launcher mode, and `playwright.request.newContext()` called from an agent's run-code tool.
- An agent's run-code tool, and any browser the agent launches itself. In config mode, deny those tools as shown above.
- A Playwright Test run with `-c` from another directory without `WRITE_GUARD_CONFIG`, which falls back to the defaults.
- WebSockets, unless `websockets` is `"block"`. A caller's own `routeWebSocket` registered after the guard can take precedence over `websockets: "block"`.
- WebRTC and WebTransport.
- Redirects after the first URL: only the request the page made is judged, not where the server redirects it.
- Drag-and-drop, and pointer or mouse handlers that act before `click`.
- Client-side-only destructive actions that no click or submit reaches.
- Mistakes in the config: requests are classified only as well as the config, so a write sent as GET, or a read sent as POST, needs a `writes` or `allow` signature.
- An isolated MCP session in launcher mode: `--isolated` makes a new, unguarded context.
- Launcher mode and client routes: an attached client's own `page.route` handlers run before the owner's guard. A `continue()` there still reaches the guard, but a client's `route.fetch()` is sent through the client's own `APIRequestContext`, which the guard cannot reach.
- Node's own `http`, `https` and `net` modules in the test process.

It also refuses too much in two places, which is the safe direction. Under read-only, pressing Enter or Space in a text field whose value contains a built-in verb is refused (the label rule uses the focused element's value), and a click on plain text containing a verb, outside any control, can be refused.

It is a safety net, not a security boundary. A restricted test account is the boundary: give the run credentials that cannot write, and use the guard to catch the mistakes that slip past.

## API

The package has five entry points, each with its own type declarations:

| Import | Exports |
|---|---|
| `playwright-write-guard` | `compileConfig`, `decideRequest`, `decideControl` |
| `playwright-write-guard/install` | `install`, `loadConfig` |
| `playwright-write-guard/test` | `test`, `expect` |
| `playwright-write-guard/init-page` | the default export, an `initPage` function |
| `playwright-write-guard/browser` | `startGuardedBrowser` |

It also installs one command, `playwright-write-guard-browser`. It needs Node 20 or newer and Playwright 1.59 or newer (`@playwright/test` for the fixture; `playwright-core` is needed at runtime only by `playwright-write-guard/browser` and the command, and the other entry points use the context Playwright gives them).

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
  "log": "write-guard.jsonl"
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `policy` | `"read-only"` or `"observe"` | `"read-only"` | `read-only` blocks writes and destructive controls; `observe` records them and lets them through |
| `allow` | list of Sig | `[]` | requests that are never writes |
| `writes` | list of Sig | `[]` | requests that are writes even when their method is GET, HEAD or OPTIONS |
| `controls.text` | list of regex sources | `[]` | extra label patterns that make a control destructive |
| `controls.icons` | list of class name prefixes | `[]` | a control with a class starting with one of these is destructive |
| `defaultControls` | boolean | `true` | include the built-in verbs in the label pattern |
| `websockets` | `"allow"` or `"block"` | `"allow"` | `block` refuses every WebSocket |
| `log` | path or `null` | `"write-guard.jsonl"` | the JSONL audit log, relative to the process's working directory; `null` turns it off |

A **Sig** (request signature) is `{ "method": M, "url": U, "body": B }`:

- `method` is one of `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` or `*`. `*` matches any method; any other value matches that method exactly, compared with the request's method in upper case.
- `url` is a regex source, compiled with no flags (case-sensitive) and tested, unanchored, against the full request URL. Use `^` and `$` to anchor it, and escape dots: `"^https://api[.]example[.]com/graphql$"`.
- `body` is optional (absent or `null` means the Sig names no body): a regex source, compiled the same way and tested against the request body. A signature with a `body` never matches a request that has no body (a body that is `null` or absent).
- A request matches a Sig when its method, its URL and (when the Sig has one) its body all match.

### Writes and controls

**A request is a write** when its method, upper-cased, is not GET, HEAD or OPTIONS, or it matches a `writes` signature, **and** it matches no `allow` signature. The method is upper-cased before the GET, HEAD or OPTIONS check. `allow` always wins: `{ "method": "POST", "url": "^https://app[.]example[.]com/graphql" }` in `allow` lets a read-only GraphQL endpoint through.

**A control is destructive** when its label matches the label pattern, or it has a class starting with one of the `controls.icons` prefixes. The label pattern is the built-in verbs (unless `defaultControls` is `false`) plus every `controls.text` source, joined into one case-insensitive regex. The built-in verbs match as whole words, case-insensitive (`Save` and `Delete item` match, `Saved` does not):

`save`, `delete`, `remove`, `publish`, `share`, `submit`, `send`, `archive`, `upload`, `import`, `rename`, `duplicate`, `update`, `confirm`, `pay`, `purchase`, `invite`, `reset`, `restore`, `approve`, `reject`, `log out`, `sign out`

There are no built-in icons: icon libraries differ per app, so name yours in `controls.icons` (for example `"icon-trash"`). An empty label never matches the label pattern; with `defaultControls: false` and no `controls.text`, only icons can make a control destructive.

In the page, the **control** for a click is the nearest ancestor of the click target (or the target itself) matching `button, a, [role=button], [role=menuitem], [role=link], [role=tab], input[type=submit], input[type=button], input[type=image], summary, [onclick], [tabindex]`, or the target when none does. For a form submit it is the submitter, or the form when there is none; for an Enter or Space keydown it is the focused element. Its **label** is the first non-empty, trimmed value of its `aria-label` attribute, its `innerText`, its `title` attribute and its `value`. Its **icons** are every class name on the control and on each of its descendants.

### The decision core: `playwright-write-guard`

```js
import { compileConfig, decideRequest, decideControl } from 'playwright-write-guard';

const config = compileConfig({ allow: [{ method: 'POST', url: '^https://app[.]example[.]com/graphql' }] });
decideRequest({ method: 'POST', url: 'https://app.example.com/items', body: '{}' }, config);
// { action: 'block', reason: '...' }
decideControl({ label: 'Delete item', icons: [] }, config);
// { action: 'block', reason: '...' }
```

- `compileConfig(raw)` validates a raw config (`null` and `undefined` mean `{}`), applies every default and compiles every pattern. On anything malformed it throws an `Error` whose message is `write-guard: <path>: <message>`, where `<path>` names the offending key the way the config spells it (`policy`, `allow[0].method`, `controls.text[2]`), or `config` for the whole value. Malformed means: a config that is not an object; a `policy`, `websockets` or Sig `method` outside its allowed values; `allow`, `writes`, `controls.text` or `controls.icons` that is not a list; a Sig that is not an object; a `url`, a `body` other than `null`, or a `controls.text` entry that is not a non-empty string or does not compile; a `controls.icons` entry that is not a non-empty string; `controls` that is not an object; `defaultControls` that is not a boolean; `log` that is neither a non-empty string nor `null`. The result is `{ policy, allow, writes, text, icons, websockets, log }`: `allow` and `writes` hold `{ method, url: RegExp, body: RegExp | null }`, `text` is the label pattern (`null` when there is none), and `icons` is `controls.icons`.
- `decideRequest({ method, url, body }, compiled)` returns `{ action, reason }`. For a write, `action` is `"block"` under `read-only` and `"observe"` under `observe`; for anything else it is `"allow"`.
- `decideControl({ label, icons }, compiled)` returns `{ action, reason }`. For a destructive control, `action` is `"block"` under `read-only` and `"observe"` under `observe`; for anything else it is `"allow"`.
- `reason` is a short human-readable explanation; its wording is not part of the API.

These three functions reference nothing outside their own arguments, because the installer injects their source text into every page.

### The installer: `playwright-write-guard/install`

`install(context, config?)` guards one Playwright `BrowserContext` and returns `Promise<GuardHandle>`. It compiles `config` (default `{}`) with `compileConfig`, so a malformed config throws before anything is installed. A second call on the same context returns the first call's handle and ignores its own `config`. It:

1. Registers one catch-all `context.route` before anything else, and judges each request exactly once with `decideRequest`, however many route handlers see it. An allowed or observed request falls back to the next handler and then to the network.
2. Wraps `context.route` and the `route` of every page in the context, present and future, so the guard judges each request before any handler registered later, and a later handler that calls `continue()` cannot let a blocked request past. The wrapped `unroute` and `unrouteAll` remove only the caller's own handlers, never the guard's.
3. On `block`: a request whose resource type is `document` is fulfilled with status 403, content type `text/html; charset=utf-8`, and a short HTML page reading `write-guard blocked <METHOD> <URL>` (HTML-escaped), so a blocked navigation shows why instead of a browser error page; any other request is aborted with `'blockedbyclient'`, which the page sees as a network error.
4. Under `websockets: "block"`, refuses every WebSocket under either policy with `context.routeWebSocket`: the socket is closed without connecting to the server and recorded as a `request` event with `action: "block"` and the socket's `url` (no `method`). It is not counted in `routed_requests`.
5. Adds an init script that runs before any page script, with capture-phase `click`, `submit` and `keydown` (Enter or Space) listeners on `window` that judge the control with `decideControl`. Under `read-only` a destructive control's event is stopped (`preventDefault` and `stopImmediatePropagation`), so the app never sees it; under `observe` it goes through. Either way the page reports the event through the binding `__writeGuardReport`, which the script captures before any page script can replace it.
6. Under `read-only`, dismisses every dialog (`alert`, `confirm`, `prompt`, `beforeunload`) on every page, so a native confirmation before a delete is declined.
7. Under `read-only`, replaces `context.request` and the `request` of every page, present and future, with a proxy whose send methods (`fetch`, `get`, `post`, `put`, `patch`, `delete`, `head`) throw `write-guard: <method> through APIRequestContext is refused under read-only` (for example `write-guard: post through APIRequestContext is refused under read-only`). The other properties stay readable. This lock exists only in the process that called `install`.

If the binding `__writeGuardReport` is already registered on the context, another process guards it (as when an agent attached to the launcher also loads the `initPage` entry), and `install` throws `write-guard: this context is already guarded by another process; use one mode, not both`. That check happens before anything is installed, so a refused `install` leaves nothing behind.

`install` cannot change how the context was created: create it with `serviceWorkers: 'block'`, or a service worker can send requests the guard never sees. The fixture, the launcher and the `initPage` config below all do.

**Events.** Every blocked or observed write is one event:

```ts
{ kind: 'request' | 'control', action: 'block' | 'observe', reason: string,
  method?: string, url?: string, label?: string, at: string }
```

A request event carries `method` and `url`; a control event carries `label` (trimmed, at most 120 characters) and neither `method` nor `url`. `at` is an ISO 8601 timestamp. Allowed requests and controls produce no event.

**The handle.**

- `record()` returns `{ installed: true, policy, routed_requests, blocked, observed, events }`: `routed_requests` counts the requests the guard judged, each once; `blocked` and `observed` count request and control events alike.
- `close()` resolves after the last pending log append and returns the final `record()`. The guard stays active until the context closes.

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
- The `context` fixture is created with `serviceWorkers: 'block'` and guarded with `install`, with `log` forced to `null` (the fixture never writes a log file). Under `read-only` that also locks `context.request` and `page.request`. A test whose effective `serviceWorkers` option is not `'block'` fails at fixture setup with an error starting `write-guard: serviceWorkers is`, because a service worker could send requests the guard never sees.
- The `request` fixture throws `write-guard: the request fixture is refused under read-only` under `read-only`, and works under `observe`. A test that uses `request` under read-only therefore fails at fixture setup with that message.
- Under both policies, while a guarded test or hook runs, these throw an error starting `write-guard:` because they would make a browser context, request context or connection the guard cannot see: `browser.newContext`, `browser.newPage`, `playwright.request.newContext`, the global `fetch`, and the browser types' `launch`, `launchPersistentContext`, `launchServer`, `connect` and `connectOverCDP`. Playwright's own creation of the test's context is the one exception.
- Each test attaches its guard's `record()` as `write-guard.json` (`application/json`).

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

A client attaches with `chromium.connect(wsEndpoint)` and sees the guarded context as `contexts()[0]`. The guard runs in the launcher's process, so the client's own `route`, `continue()` and `unrouteAll()` cannot bypass or remove it, and new tabs it opens in that context are guarded.

The command does the same from a shell:

```
npx playwright-write-guard-browser [--config <path>] [--headed] [--host <h>] [--port <n>]
```

`--config` is passed to `loadConfig` (so without it, `WRITE_GUARD_CONFIG` and `write-guard.config.json` apply), `--headed` sets `headless` to false, and `--host` and `--port` default to `127.0.0.1` and `0`. It prints `endpoint: <ws endpoint>` on a line of its own, then how to attach: Playwright MCP with `--endpoint <ws endpoint>` and without `--isolated` (which uses `contexts()[0]`), or the Playwright CLI with `playwright-cli attach --endpoint=<ws endpoint>`. It stays up until SIGINT or SIGTERM, then closes the browser and exits 0. An unknown flag or a flag missing its value prints the usage line and exits 1.

### What it cannot see

- `APIRequestContext` objects the guard cannot reach: an attached client's own `page.request` and `context.request` in launcher mode, and `playwright.request.newContext()` called from an agent's run-code tool.
- An agent's run-code tool, and any browser the agent launches itself.
- A Playwright Test run with `-c` from another directory without `WRITE_GUARD_CONFIG`: the fixture finds no config file and falls back to the defaults.
- WebSockets, unless `websockets` is `"block"`. A caller's own `routeWebSocket` registered after the guard can take precedence over `websockets: "block"`.
- WebRTC and WebTransport.
- Redirects after the first URL: only the request the page made is judged, not where the server redirects it.
- Drag-and-drop, and pointer or mouse handlers that act before `click`.
- Client-side-only destructive actions that no click or submit reaches.
- Requests are classified only as well as the config: a write sent as GET, or a read sent as POST, needs a `writes` or `allow` signature.
- An isolated MCP session in launcher mode (`--isolated` makes a new, unguarded context).
- Launcher mode: an attached client's own `page.route` handlers run before the owner's guard. `continue()` still reaches the guard, but a client's `route.fetch()` is sent through the client's `APIRequestContext`, which the guard cannot reach.
- Under read-only, pressing Enter or Space in a text field whose value contains a built-in verb is refused (the label rule uses the focused element's value), and a click on plain text containing a verb, outside any control, can be refused.
- Node's own `http`, `https` and `net` modules in the test process.

It is a safety net, not a security boundary. A restricted test account is the boundary.

## License

MIT. See [LICENSE](LICENSE). Written by Venkata Sandeep Takasi.
