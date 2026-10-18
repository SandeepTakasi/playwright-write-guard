# Guide

Longer how-to sections for [playwright-write-guard](../README.md). The reference for every option and entry point is in [the API](api.md).

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
- **Launcher mode:** start the launcher already logged in with `--storage-state <path>`, a Playwright storage state file such as the `state.json` the setup project above saves:

  ```
  npx playwright-write-guard-browser --storage-state state.json
  ```

  The agent then attaches to a browser that holds the session, and never has to log in through the read-only guard. A file that cannot be read or parsed stops the launcher at startup with Playwright's message and exit code 1. The same file keeps the limits above: it holds a live session, so keep it out of version control, and a session the app renews with a POST still expires during the run unless you allow-list that refresh endpoint. From code, pass `storageState` (a path or a storage state object) to `startGuardedBrowser`.

  Two more flags help when the app is not directly reachable. `--proxy <url>` sends the browser's traffic through a proxy (for an app only reachable through a corporate or staging proxy), and `--ignore-https-errors` accepts self-signed or otherwise invalid certificates (for a staging server or a local HTTPS app). Use `--ignore-https-errors` only against hosts you trust: it turns off certificate checks for every page in the guarded browser. The launcher takes no HTTP credentials; allow-list the login endpoints, or use config mode.

## WebSocket frames and suspect GETs

Two more things can be judged beyond methods and clicks. The first is off until you list patterns; the second is on with a small built-in pattern.

**WebSocket frames.** By default the guard records each socket a page opens and judges none of its messages. Set `websocketWrites` to a list of regex sources, for example `{ "websocketWrites": ["\"event\":\"delete_item\""] }`, and under `websockets: "allow"` each text frame the page sends is tested against them (case-sensitive, unanchored). Under `read-only` a matching frame is dropped, so the server never receives it, and recorded as a `websocket` event with `"action":"block"`; the socket stays open. Under `observe` it is recorded with `"action":"observe"` and forwarded. A frame that matches nothing is forwarded with no event. What stays out: binary frames always pass, messages the server sends to the page are never judged, and a write frame that none of your patterns matches passes, so the list is only as good as the patterns. A frame is JSON text, so a newline inside it is the two characters `\n`, not a line break, and a pattern like `"query":"\s*mutation` misses a formatted mutation (`"query":"\nmutation {`). For GraphQL frames, use the pattern under [GraphQL](#graphql), which also handles comments, escapes and documents with more than one operation.

**Suspect GETs.** A GET or HEAD is never blocked for its path alone, but one whose path plus query matches the built-in pattern is recorded as a `suspect` event and goes through. The pattern matches the words logout, sign-out (and `sign_out`), unsubscribe, confirm, delete and remove as a whole path segment or word, and any `action=` query parameter, case-insensitively: `/logout`, `/users/sign_out`, `/unsubscribe?t=1` and `/items?action=delete` are suspect, `/catalog` and `/deleted-items` are not. The pattern reads words in a URL, not what the URL does, so it also marks static assets such as `/static/icons/delete-icon.svg` (a harmless extra `suspect` event). It is tested against the path and query only, never the origin. `suspectGets` adds your own regex sources (case-insensitive, unanchored), and `"defaultSuspectGets": false` drops the built-in pattern. Browser requests, request client sends and Node `fetch` calls are all checked. To block a GET outright, name it in `writes`.

**Links.** A link that navigates is judged by its URL, not its text: an `a` with a real `href` is refused in the page under `read-only` (and recorded under `observe`) only when that URL is suspect, so a link to `/logout` or `/items?action=delete` is refused. The URL is what counts, not the text: a help link whose text says "Delete a repository" is not refused when its URL holds no built-in word (`/help/repositories`), and is refused when the URL does (`/help/delete-a-repository`, because a hyphen-separated word counts). Anchors whose `href` is empty, starts with `#` or is a `javascript:` URL, and elements with `role=link`, are still judged by their label.

What stays out of all of this: toggles (checkboxes and switches) and `change` events, binary frames, server-to-page messages, blocking suspect GETs, and custom-method paths such as `/items/7:delete`.

## The audit log

When `log` is a path (default `write-guard.jsonl`, relative to the process's working directory), each blocked or observed write is appended as one JSON object per line, as it happens. So is each write one of your own routes mocked (`"action":"mocked"`), each GET or HEAD that looks side effecting (`"action":"suspect"`), each blocked or observed WebSocket frame, and each WebSocket opened under the default `websockets: "allow"`. The file is created when missing and never truncated. Allowed requests that are not suspect, allowed frames and allowed controls are not logged. Set `"log": null` to turn it off.

A blocked request, a refused control, a WebSocket open and a suspect GET look like this (one line each in the file):

```json
{"kind":"request","action":"block","reason":"POST is not a read method; policy read-only","method":"POST","url":"https://app.example.test/items","contentType":"application/json","headerNames":["accept","content-type"],"at":"2026-01-15T09:30:00.000Z"}
{"kind":"control","action":"block","reason":"\"Delete item\" matches a destructive label; policy read-only","label":"Delete item","at":"2026-01-15T09:30:02.000Z"}
{"kind":"websocket","action":"open","url":"wss://app.example.test/live","at":"2026-01-15T09:30:03.000Z"}
{"kind":"request","action":"suspect","reason":"GET /logout matches the suspect pattern","method":"GET","url":"https://app.example.test/logout","headerNames":["accept"],"at":"2026-01-15T09:30:04.000Z"}
```

A request event carries `method`, `url`, when the request has a `content-type` header `contentType`, and `headerNames`: the names of the request's headers, lower-cased and sorted, never their values. A send through a request client (`context.request`, `page.request`, the fixture's `request`) or Node's `fetch` also carries `via` (`"request-client"` or `"node-fetch"`); for a send made with an `APIRequestContext` the header names are those of the `headers` option (or the `Request`) you passed, not ones the client adds itself. With `logBodies: true` it also carries `body`, the first 500 characters of the request body; that is off by default because bodies can hold credentials and personal data, so treat a log that has them as sensitive. A control event carries `label` and none of the request fields. A websocket `open` event carries only its `url`; a frame event adds `reason` and, with `logBodies: true`, `frame`, the first 500 characters of the frame. `reason` is a human-readable note whose wording may change. Under the `observe` policy the same events are recorded with `"action":"observe"` and the write goes through, which is a way to find out what a run would have blocked. The full event shape is in [the API](api.md#the-installer-playwright-write-guardinstall).

## Writing an allow list

Apps that read over POST stop working until those endpoints are in `allow`. To find them, observe a run and draft the entries from its log:

1. **Observe a run.** Run the same test, agent session or script with `"policy": "observe"` and a `log` path, with the guard in a mode that writes the log (the `initPage` entry or the launcher; `install` called directly works too). Nothing is blocked, and every write is recorded. The Playwright Test fixture never writes a log file: its events are in the `write-guard.json` attachment, and one JSON line per element of its `events` array makes a log the next step can read.
2. **Look at the header names.** Each request event carries `headerNames`, the request's header names, lower-cased and sorted; never their values. A read that differs from a write only by a header shows up there (a `next-action` name means a Next.js server action). The values you need for a `headers` signature have to come from the app's own code or network panel.
3. **Draft the entries.**

   ```
   npx playwright-write-guard-suggest write-guard.jsonl > allow.json
   ```

   It reads the log and never writes a file. It groups the `observe`, `block` and `mocked` request events by method and by origin plus path, prints `{ "allow": [...] }` on stdout, one entry per group, and one hint line per entry on stderr: how many events it saw, and a note when the group carries `next-action` or its path ends in `/graphql`. A group of three blocked `POST https://app.example.test/graphql` events gives the entry `{ "method": "POST", "url": "^https://app\\.example\\.test/graphql(?:[?#]|$)" }` and the hint `3 x POST https://app.example.test/graphql: GraphQL, add the URL to "graphql" to allow its queries`. Allowed GETs are never logged, and `suspect` events and events without a method are skipped.
4. **Review before use.** The command cannot tell a read from a write: it lists every write the run attempted, the real ones included, and each entry allows every request with that method to that path, whatever its body or headers. Delete the entries that are real writes. Move a GraphQL endpoint's entry to `graphql` instead (see [GraphQL](#graphql)), and narrow the rest with a `body` pattern anchored at its start or a `headers` pattern (exact action IDs). Then put them in `allow`, run again under `read-only`, and check that the reads work and the writes are still blocked.

## Allow and writes examples

An `allow` URL that matches the empty string (`.*`, `^`, `x?`) can match any URL, so the config is refused with `write-guard: allow[0].url: matches the empty string, so it can match any URL`. An `allow` URL that is not anchored with `^` still works, but `install` prints `write-guard: warning: allow[0].url "/api/": not anchored with ^, so it also matches any URL that merely contains a match` (the text names the URL, here `/api/`) once per distinct text per process, from Node and never in a page.

A `writes` signature always wins over `allow`.

### GraphQL

To let a GraphQL endpoint's queries through and block its mutations, list its URL under `graphql`:

```json
{
  "graphql": ["^https://app[.]example[.]test/graphql$"]
}
```

A POST to that URL has its body read. A query is allowed, and a mutation or subscription is blocked even when an `allow` signature matches the same request. A batch is allowed only when every operation in it is a query. A body the guard cannot classify (a persisted query with no query text, an unbalanced document, a body that is not JSON, an `operationName` that names no operation) is not judged by `graphql`: it falls through to `allow` and then the method rule, so a POST stays blocked unless you allow it. Anchor each entry with `^`, as for `allow`: an unanchored one prints a warning.

**Using automatic persisted queries (APQ)?** The client's first request sends only a hash, with no query text, so `graphql` cannot classify it and it is blocked; the client then sees a network error instead of a "persisted query not found" reply and does not retry with the full query, so reads stay broken. Either have the client send hashed queries as GET (Apollo Client's `useGETForHashedQueries: true`), which the guard treats as reads, or turn APQ off where the guard runs, or allow the hashes of your read operations by hand, for example `{ "method": "POST", "url": "^https://app[.]example[.]test/graphql$", "body": "\"sha256Hash\":\"(3f1c9a...|8b2e47...)\"" }` with the full hashes. Never allow every hash: mutations are sent as hashes too.

**GraphQL over WebSocket** (`graphql-ws`, subscriptions transports) is not read by `graphql`, and those messages can carry mutations. Name them with `websocketWrites` (see [WebSocket frames](#websocket-frames-and-suspect-gets)). This pattern blocks any frame whose `query` text holds the keyword `mutation`, wherever it sits, including after a newline or a comment, in both the `graphql-ws` `subscribe` and the older `start` messages:

```json
{
  "websocketWrites": ["\"query\"\\s*:\\s*\"(?:(?:[^\"\\\\]|\\\\.)*?(?:[^A-Za-z0-9_\"\\\\]|\\\\[nrtbf]))?mutation\\b"]
}
```

It is a text match, not the `graphql` parser, so it blocks more than the mutations a server would run: a document that holds a mutation is blocked even when `operationName` picks a query, and so is a query whose comment mentions the word. It lets through a field such as `mutationCount` and the word inside a string argument. It never sees a frame that carries only a persisted query's hash.

A `writes` signature is still checked first, so an old `writes` body pattern such as `"body": "mutation"` keeps winning: a query that merely mentions the word `mutation` stays blocked until you remove that pattern. With `graphql` in place you can usually drop it.

Without `graphql`, allow the URL and name the mutations in `writes` by a body pattern, which also works for persisted queries and for bodies the guard cannot read:

```json
{
  "allow": [{ "method": "POST", "url": "^https://app[.]example[.]test/graphql$" }],
  "writes": [{ "method": "POST", "url": "^https://app[.]example[.]test/graphql$", "body": "mutation" }]
}
```

To allow only named operations by hand, anchor a `body` pattern at its start, for example `"^\\{\"operationName\":\"(ListItems|GetItem)\""`: it matches only a single operation whose body starts with its name, so a batched request (a JSON array) never matches, and neither does a body that puts `operationName` later. Check that your client sends `operationName` first, or the reads stay blocked (the safe direction). The pattern trusts your app's operation names, so list only names that read, and never leave a pattern unanchored.

`graphql` judges only the operation type: a query whose resolvers write is allowed, and a GET to the endpoint stays a read. See the [limits](limits.md).

Reads that differ from writes only in a header, such as Next.js server actions, can be allow-listed with a `headers` entry that names the exact action IDs that read, for example `{ "method": "POST", "url": "^https://app[.]example[.]test/items$", "headers": { "next-action": "^(7f3a9c21|1b2e44d0)$" } }`. Every server action sends a `next-action` header, writes included, so a pattern that matches any ID allows every action; and action IDs can change between builds, so re-check them after a deploy. Header names compare case-insensitively and each value is a regex tested against that header on the request.

## Playwright Test details

`browser.newContext()` and `browser.newPage()` inside a test return a guarded context, created with `serviceWorkers: 'block'`, so tests with several users can create more contexts. Each one's record is attached as `write-guard-<n>.json`. In hooks and in fixture setup and teardown they still throw (a multi-user fixture that calls `browser.newContext()` fails at setup). `playwright.request.newContext()` and the browser types' `launch` and `connect` family still throw everywhere, because they make clients the guard cannot see.

A test can mock a write: a `page.route` handler that `fulfill`s or `abort`s a POST runs, and the request never leaves the browser. The guard records it as a `mocked` event, which counts in `mocked`, not in `blocked`. A handler that passes the request on with `continue()` or `route.fetch()` is judged at that point, overrides included, so the write is still blocked. A mock is not the server: count writes on a real local server, not through a route that fulfills them.

## Dialogs

Under `read-only` the guard declines every dialog (`alert`, `confirm`, `prompt`, `beforeunload`) first, so a suite's own `accept` on the same dialog throws `Cannot accept dialog which is already handled!`, and its own `dismiss` throws `Cannot dismiss dialog which is already handled!`. The dialog is declined either way; catch the error so the test goes on:

```js
page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
```

A dismissed `beforeunload` keeps the page, so a test or an agent that leaves a page with unsaved changes (a `goto` elsewhere, a click on a link) stays on that page. A `page.goto` then throws `net::ERR_ABORTED`; a click on a link does not throw.

## How the guard works

The guard has two layers. The network layer judges every HTTP request the pages of a guarded context send, whatever triggered it: a "Continue" button that submits a payment still sends a request, and that request is judged. This is the main layer. Its exceptions are the WebSocket messages, and the sends from a page being left, a `SharedWorker` and `fetchLater`, covered in the sections on WebSocket frames above and on leaving pages below.

The click layer runs in the page. A click, form submit, or Enter or Space keypress on a control whose label is a destructive verb (Save, Delete, Publish, Send, Archive, Pay, Purchase, Log out and so on) is stopped before the app's own handlers run, and the page's console gets a `write-guard refused "<label>": <reason>` warning, so an agent that reads the console learns why nothing happened. Native confirmation dialogs are declined. A link that navigates is judged by its URL, not its text (see Suspect GETs above). Because controls are judged by label, this layer refuses some harmless controls and misses some that write; the network layer still judges what they send.

It is a safety net, not a security boundary: give the run a restricted account that cannot write, and use the guard to catch mistakes before they reach it.

## Leaving pages, shared workers and fetchLater

Playwright does not route a request a page starts while it is being left (a `navigator.sendBeacon` or a `keepalive` fetch from a `pagehide` or `unload` handler, or an ordinary `fetch` or XHR then), nor the HTTP of a `SharedWorker`, nor a request made with `fetchLater`, even from a page that stays open. Under `read-only`, the page script judges the writes of a leaving page itself, with the same `allow` list and rules as the network layer: an allowed write goes out, and any other is refused (the beacon returns `false`, the `fetch` rejects, the XHR throws) with a console warning. A frame counts as leaving when it, or a same-origin frame above it, is hidden or has fired `pagehide`, also with a cross-origin frame in between. A refusal is recorded nowhere, because a page that is being left cannot report reliably, and reads from a leaving page are not judged. Under `read-only` the page script also removes `window.SharedWorker` and `window.fetchLater` in every frame, so an app that checks for them falls back to a dedicated `Worker` (routed) or to `fetch` or `sendBeacon` (judged), and an app that calls them without checking does not load that part. Under `observe`, nothing is replaced or removed: unload-time sends, the HTTP of a `SharedWorker` and `fetchLater` requests are not judged and not recorded.
