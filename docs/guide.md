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
- **Launcher mode** takes no context or launch options yet (no storage state, proxy, `ignoreHTTPSErrors` or HTTP credentials): allow-list the login endpoints, or use config mode.

## WebSocket frames and suspect GETs

Two more things can be judged beyond methods and clicks. The first is off until you list patterns; the second is on with a small built-in pattern.

**WebSocket frames.** By default the guard records each socket a page opens and judges none of its messages. Set `websocketWrites` to a list of regex sources, for example `{ "websocketWrites": ["\"event\":\"delete_item\""] }`, and under `websockets: "allow"` each text frame the page sends is tested against them (case-sensitive, unanchored). Under `read-only` a matching frame is dropped, so the server never receives it, and recorded as a `websocket` event with `"action":"block"`; the socket stays open. Under `observe` it is recorded with `"action":"observe"` and forwarded. A frame that matches nothing is forwarded with no event. What stays out: binary frames always pass, messages the server sends to the page are never judged, and a write frame that none of your patterns matches passes, so the list is only as good as the patterns. A frame is JSON text, so a newline inside it is the two characters `\n`, not a line break, and a pattern like `"query":"\s*mutation` misses a formatted mutation (`"query":"\nmutation {`). To match both, write `{ "websocketWrites": ["\"query\":\"(?:\\\\n|\\s)*mutation"] }`.

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

   It reads the log and never writes a file. It groups the `observe`, `block` and `mocked` request events by method and by origin plus path, prints `{ "allow": [...] }` on stdout, one entry per group, and one hint line per entry on stderr: how many events it saw, and a note when the group carries `next-action` or its path ends in `/graphql`. A group of three blocked `POST https://app.example.test/graphql` events gives the entry `{ "method": "POST", "url": "^https://app\\.example\\.test/graphql(?:[?#]|$)" }` and the hint `3 x POST https://app.example.test/graphql: GraphQL, add an anchored body pattern`. Allowed GETs are never logged, and `suspect` events and events without a method are skipped.
4. **Review before use.** The command cannot tell a read from a write: it lists every write the run attempted, the real ones included, and each entry allows every request with that method to that path, whatever its body or headers. Delete the entries that are real writes. Narrow the rest with a `body` pattern anchored at its start (GraphQL operation names) or a `headers` pattern (exact action IDs), as shown under [Use with Playwright Test](../README.md#use-with-playwright-test). Then put them in `allow`, run again under `read-only`, and check that the reads work and the writes are still blocked.
