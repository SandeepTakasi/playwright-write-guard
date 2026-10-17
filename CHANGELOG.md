# Changelog

Newest first. Breaking and behaviour changes come first in each release. The guard is a safety net, not a security boundary; the README lists what it cannot see.

## 0.6.0 (unreleased)

### Breaking and behaviour changes

- Clicks that only change the view are no longer refused by default. A short built-in list of whole labels such as "Remove filter" and "Remove column" is let through, because they matched the built-in verb list and stalled agents on ordinary list pages. Save and send labels are never excepted, since over a socket the click layer is the only cover for them. Set `defaultExceptions: false` to turn the list off and keep the 0.5.x behaviour.
- `refund` is a built-in destructive verb, so Refund buttons are refused by the click check (`Refunded` and `Refunds` are not, since verbs match whole words).

### New

- The launcher takes `--storage-state <path>`, so an agent can start logged in (under read-only the login request is blocked, so it could not log in itself).
- The launcher takes `--proxy <url>` to browse through a proxy.
- The launcher takes `--ignore-https-errors` to accept self-signed certificates, as staging setups often need.
- The launcher takes `--print-mcp-config`, which prints a ready-to-paste MCP client config for its endpoint after the `endpoint:` line. Without the flag the output is unchanged.
- A scheduled CI workflow runs the suite daily against the latest and next Playwright releases, without blocking pushes or pull requests.

### Docs

- The README now opens with a short pitch, a demo and a quickstart, shows the five limits that matter most in a table, and links to the full list of limits in `docs/limits.md`.
- The quickstart pins the Playwright MCP version it was checked with and mentions `--print-mcp-config`.
- The demo shows a real Claude Code session asked to clean up test orders in a signed-in store admin app: it is refused on a refund, stops and explains, and the server receives no write.
- The `demo/` folder holds the store admin app, a one-command setup and the script that films a run.
- This changelog.

## 0.5.0 (2026-10-16)

### Breaking changes

- Playwright 1.64 or newer is required. Both peer dependencies (`@playwright/test` and `playwright-core`) are `>=1.64`; 0.4.x said `>=1.59`. On 1.59 the launcher cannot connect (a Playwright bug in `browser.bind()` returns a malformed endpoint), and on 1.60 to 1.63 the browser often drops an allowed write sent from a page that is closing. Refused writes stayed refused on every version.

### New

- Under `read-only`, a request blocked at the network layer that is not a navigation logs `write-guard refused <METHOD> <URL>: <reason>` with `console.warn` in the request's frame, so an agent sees why it failed. A blocked navigation still gets its 403 page, and `observe` logs nothing. A page that replaces `console.warn`, or a request with no frame, gets no message.
- The unanchored `allow` warning names its URL, for example `write-guard: warning: allow[0].url "/api/": not anchored with ^, ...`.
- CI also runs the suite on the latest Playwright 1.64 patch, next to Node 20, 22 and 24.

### Docs

- The README shrank from about 116 kB to about 33 kB. The API reference moved to `docs/api.md` and the longer guides to `docs/guide.md`, without rewording.

## 0.4.0 (2026-10-16)

### Breaking changes

- `writes` now wins over `allow`. A request that matches any `writes` signature is a write even when an `allow` signature matches it too. In 0.3.x `allow` always won. If you relied on `allow` overriding a `writes` signature, narrow the `writes` signature instead.
- An `allow` URL that matches the empty string (`.*`, `^`, `x?` and the like) is refused, because it would let every request through. The config fails with `write-guard: allow[<i>].url: matches the empty string, so it can match any URL`. `writes` URLs are not checked.
- `loadConfig` adds a `configFile` key to the object it returns: the absolute path of the file it read, or `null`. A `configFile` key in the file itself is overwritten.
- The record gains `config_file`, right after `policy`: that path, or `null` when the config did not come from `loadConfig` with a file.
- The launcher prints a new first line, `config: <path>` or `config: none, using the defaults`, before `endpoint:`.

### New

- A warning for `allow` URLs that do not start with `^`, since they also match any URL that merely contains a match. It is printed once per process, from Node only and never in a page.
- `writeGuardFailOnBlocked`, a Playwright Test option, off by default. When it is on, a test fails after its records are attached if its guard, or a context the test made, blocked anything; the message names the first five blocked events. `mocked`, `suspect` and `observe` events never count, and neither do sends the guard does not record.

## 0.3.0 (2026-10-13)

### Breaking changes

- Request clients are judged, not refused. Under `read-only`, `context.request`, `page.request` and the fixture's `request` let a GET through and reject a write with `write-guard: <METHOD> <URL> through APIRequestContext is refused under read-only`. Under `observe` their sends are recorded (`via: "request-client"`). The 0.2.x refusal messages are gone.
- The fixture allows more inside a test. Node's global `fetch` is judged (`via: "node-fetch"`), and `browser.newContext` and `browser.newPage` return guarded contexts whose records are attached as `write-guard-<n>.json`. Hooks and fixture setup and teardown still refuse them. In `beforeAll` and `afterAll` the `request` fixture is judged with the test's config but not recorded.
- Sends are judged on the options Playwright merges: `options.request`, `options.url`, `options.method` and `options.headers` override the first argument, for request clients and for `route.fetch`. This closes a captured-request bypass that 0.2.x also had.
- A write that one of your routes fulfills or aborts is recorded with `action: "mocked"` and counted in `mocked`, never in `blocked`.
- A link that navigates is judged by its resolved URL against the suspect pattern, not by its text. A suspect link (for example `/logout`) is refused under `read-only`. Links without a real destination are still judged by their text.
- Pages being left are guarded under read-only. Playwright does not route requests from a page that is closing or navigating away, so the page script judges a write such a page starts (`fetch`, XHR, `sendBeacon`) against your config: allowed writes go out, refused ones fail with a console warning, and nothing is recorded. `SharedWorker` and `fetchLater`, whose requests are never routed, are removed under `read-only`. `observe` changes none of this.
- Types: `WebSocketEvent` is now a union, `WebSocketOpenEvent | WebSocketFrameEvent`. `RequestEvent.action` adds `"mocked"` and `"suspect"`, and request events gain `via` and `headerNames`. `GuardRecord` gains `mocked` and `suspect`. `GuardHandle` gains `guardRequestClient` and `guardFetch`. `Config` gains `websocketWrites`, `suspectGets` and `defaultSuspectGets`; `CompiledConfig` gains `websocketWrites` and `suspect`. The core exports `decideFrame` and `decideSuspect`.

### New

- `websocketWrites`: outbound text frames matching a pattern are dropped under `read-only` and recorded under `observe`.
- Suspect GETs: a GET or HEAD whose path looks side-effecting (`/logout`, `?action=delete`) is recorded as `suspect` and never blocked. Tune it with `suspectGets` and `defaultSuspectGets`.
- `headerNames` on request events, so an observe log shows which writes carry a signature header such as `next-action`.
- `playwright-write-guard-suggest <log.jsonl>` prints a draft allow list from an observe log, with hints where a GraphQL endpoint or a header needs a body or header signature. Review it before use.

## 0.2.0 (2026-10-11)

### Breaking changes

- TypeScript: `GuardEvent` is now a union of request, control and websocket events. Narrow on `event.kind` before reading `label` or `method`.
- The smaller verb list and the real-controls rule mean some clicks 0.1.x refused now go through. The network layer still judges every request they send.
- A caller route registered after the guard now receives blocked writes, so a route used to count server hits in tests counts mocks instead. Count writes on a real server or a route registered before `install`.

### New

- The click check refuses far less. The built-in verbs are save, delete, remove, publish, send, archive, pay, purchase, log out, sign out and logout. Only real controls are judged (buttons, links with `href`, button, menu item, link and tab roles, and submit, button and image inputs), found through the event's composed path, so open shadow DOM works. A text field never refuses a typed space or Enter.
- A refused click calls `console.warn` with `write-guard refused "<label>": <reason>`.
- Writes are judged where they would leave the browser: the guard's catch-all route, or a caller's `continue` or `fetch`. A test's own route can `fulfill` or `abort` a write as a mock.
- Signatures can match request headers (`"headers": { "next-action": "..." }`) and name any method (REPORT, QUERY, M-SEARCH).
- Request events carry `contentType`, and a 500-character `body` excerpt when the config sets `logBodies: true` (off by default, since bodies can hold credentials).
- Every WebSocket a page opens is recorded as a `{ kind: "websocket", action: "open" }` event. Messages are still not judged.
- The README's limits lists are updated, including sockets opened by workers and a launcher client's own `routeWebSocket`, which is now refused.

## 0.1.0 (2026-10-10)

First release.

- `playwright-write-guard`: the decision core. A request whose method is not GET, HEAD or OPTIONS is a write unless an `allow` signature matches; a control whose label is a destructive verb is destructive.
- `playwright-write-guard/install`: the installer every entry point shares. A network-layer route guard, an in-page refusal of destructive clicks, submits and key presses, dialog dismissal, a lock on request clients under read-only, and a JSONL audit log.
- `playwright-write-guard/test`: a Playwright Test fixture. Swap one import.
- `playwright-write-guard/init-page`: a one-line `initPage` entry for Playwright MCP and the Playwright CLI.
- `playwright-write-guard/browser` and `playwright-write-guard-browser`: a launcher that owns the browser and guards it while an agent attaches to its endpoint.
