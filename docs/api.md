# API

The package has five entry points, each with its own type declarations:

| Import | Exports |
|---|---|
| `playwright-write-guard` | `compileConfig`, `decideRequest`, `decideControl`, `decideFrame`, `decideSuspect` |
| `playwright-write-guard/install` | `install`, `loadConfig` |
| `playwright-write-guard/test` | `test`, `expect` |
| `playwright-write-guard/init-page` | the default export, an `initPage` function |
| `playwright-write-guard/browser` | `startGuardedBrowser` |

It also installs two commands: `playwright-write-guard-browser`, which starts a guarded browser (see the launcher below), and `playwright-write-guard-suggest`, which drafts `allow` entries from an audit log (see the suggest command below). It needs Node 20 or newer and Playwright 1.64 or newer (`@playwright/test` for the fixture; `playwright-core` is needed at runtime only by `playwright-write-guard/browser` and `playwright-write-guard-browser`, and the other entry points use the context Playwright gives them).

## Config

Every key is optional, and unknown keys are ignored:

```json
{
  "policy": "read-only",
  "allow": [],
  "writes": [],
  "graphql": [],
  "controls": { "text": [], "icons": [] },
  "defaultControls": true,
  "defaultExceptions": true,
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
| `allow` | list of Sig | `[]` | requests that are reads even when their method is not GET, HEAD or OPTIONS, unless a `writes` signature also matches. A `url` that matches the empty string is refused; one not anchored with `^` prints a warning (below) |
| `writes` | list of Sig | `[]` | requests that are writes even when their method is GET, HEAD or OPTIONS, and even when an `allow` signature matches too |
| `graphql` | list of regex sources | `[]` | GraphQL endpoint URLs: a POST to one is read for its operation type, so a query is allowed and a mutation or subscription is a write even when `allow` matches (details below the table) |
| `controls.text` | list of regex sources | `[]` | extra label patterns that make a control destructive |
| `controls.icons` | list of class name prefixes | `[]` | a control with a class starting with one of these is destructive |
| `defaultControls` | boolean | `true` | include the 12 built-in verbs (listed under Writes and controls) in the label pattern; `false` drops them |
| `defaultExceptions` | boolean | `true` | include the built-in read-only exception pattern (shown under Writes and controls): a control whose whole label matches it is not refused by label; `false` drops it. Any other value fails with `write-guard: defaultExceptions: must be a boolean` |
| `websockets` | `"allow"` or `"block"` | `"allow"` | `allow` records each WebSocket open and lets it connect; `block` refuses every WebSocket |
| `websocketWrites` | list of regex sources | `[]` | under `websockets: "allow"`, an outbound WebSocket text frame matching any of these is a write: dropped under `read-only`, recorded and forwarded under `observe`. Compiled with no flags (case-sensitive) and tested unanchored against the frame's text. Empty: frames are not judged |
| `suspectGets` | list of regex sources | `[]` | extra patterns that mark a GET or HEAD as suspect (recorded, never blocked), added to the built-in suspect pattern. Compiled case-insensitive and tested unanchored against the URL's path plus query |
| `defaultSuspectGets` | boolean | `true` | include the built-in suspect pattern (shown under Writes and controls); `false` drops it |
| `log` | path or `null` | `"write-guard.jsonl"` | the JSONL audit log, relative to the process's working directory; `null` turns it off |
| `logBodies` | boolean | `false` | add `body`, the first 500 characters of the request body, to request events, and `frame`, the first 500 characters of the frame, to WebSocket frame events (in `record()` and the log); off by default because bodies and frames can hold credentials and personal data |

**`graphql`** is a list of regex sources. Absent means `[]`; anything but a list fails with `write-guard: graphql: must be a list`. Each entry is compiled with no flags (case-sensitive) and tested, unanchored, against the full request URL, like an `allow` `url`, and `compileConfig` returns them as `graphql: RegExp[]`:

- An entry that is not a non-empty string, or does not compile, fails with `write-guard: graphql[<i>]: must be a non-empty regex string` or `write-guard: graphql[<i>]: does not compile: <message>`.
- An entry that matches the empty string fails with `write-guard: graphql[<i>]: matches the empty string, so it can match any URL`.
- An entry not starting with `^` is accepted, but `install` prints `write-guard: warning: graphql[<i>] "<src>": not anchored with ^, so it also matches any URL that merely contains a match` with `console.warn`, once per distinct text per process, from Node only (as for `allow`).
- Only a POST to a matching URL is judged. Its body must be a string; a body that is not text (`FormData`, `Blob`) is not classified. The body is read as GraphQL over HTTP JSON: one object, or a non-empty array of objects (a batch), each with a non-empty string `query` and an `operationName` that is absent, `null` or a string. A body that is not JSON is read as one query when its `content-type` is `application/graphql`. Each `query` is scanned for its operations (strings, block strings and `#` comments are skipped, fragments are ignored). With a non-empty `operationName`, the operation of that name is chosen; otherwise the document must hold exactly one operation. A body that cannot be read this way, or whose operation cannot be chosen, is unclassified.
- A body is a write when any chosen operation is a `mutation` or `subscription`, a read when every one is a `query`, and unclassified otherwise. An unclassified body is not judged by `graphql`: it falls through to `allow` and the method rule, so a POST stays a write unless an `allow` signature matches it. A persisted query (no query text) is unclassified, so allow it by hand.
- A GET to a `graphql` URL is a read like any GET: its `?query=` is not parsed.

A **Sig** (request signature) is `{ "method": M, "url": U, "body": B, "headers": H }`:

- `method` is `"*"` or a method name: a string matching `^[A-Za-z][A-Za-z0-9-]*$` (for example `POST`, `delete`, `REPORT` or `M-SEARCH`), compiled to upper case. `*` matches any method; a method name matches that method exactly, compared with the request's method in upper case.
- `url` is a regex source, compiled with no flags (case-sensitive) and tested, unanchored, against the full request URL. Use `^` and `$` to anchor it, and escape dots: `"^https://api[.]example[.]com/graphql$"`.
- `body` is optional (absent or `null` means the Sig names no body): a regex source, compiled the same way and tested against the request body. A signature with a `body` never matches a request that has no body (a body that is `null` or absent).
- `headers` is optional (absent or `null` means the Sig names no headers): an object mapping a header name to a regex source, for example `{ "Next-Action": "^[0-9a-f]+$" }`. Header names compare case-insensitively (they are compiled to lower case). Each value is compiled with no flags and tested, unanchored, against the value of that header on the request. A Sig with `headers` matches a request only when every header it names is present on the request and its value matches.
- A request matches a Sig when its method, its URL, (when the Sig has one) its body and (when the Sig names any) every named header all match.
- An `allow` Sig whose `url`, compiled with no flags, matches the empty string (`.*`, `^`, `x?`, `(?:)`, an alternative that is empty) can match any URL, so `compileConfig` throws `write-guard: allow[<i>].url: matches the empty string, so it can match any URL`. A `writes` Sig is not checked this way.
- An `allow` Sig whose `url` is a string that does not start with `^` is accepted, but `install` prints `write-guard: warning: allow[<i>].url <JSON of the source>: not anchored with ^, so it also matches any URL that merely contains a match` with `console.warn` (for example `write-guard: warning: allow[0].url "/api/": not anchored with ^, so it also matches any URL that merely contains a match`), once per distinct text per process, after the config compiles. The text names the URL, so two configs that have an unanchored URL at the same index each print their own warning. It prints from Node only: never in a page, and `compileConfig` prints nothing.

## Writes and controls

**A request is a write** by the first of these rules that applies, in this order:

1. It matches a `writes` signature: it is a write, whatever its method and whatever `allow` says. `writes` always wins. The reason is `<METHOD> matches writes[<j>]`.
2. Otherwise, it is a POST to a URL matching a `graphql` entry and its body is a GraphQL mutation or subscription (see Config): it is a write, whatever `allow` says. The reason is `POST graphql[<i>] <mutation or subscription> <name or (anonymous)>`, followed by `; policy read-only` or `; policy observe`.
3. Otherwise, it is a POST to a `graphql` URL and its body is a GraphQL query, or a batch of queries only: it is a read, with the reason `graphql[<i>] query <name or (anonymous)>` or, for a batch, `graphql[<i>] batch of <n> queries`.
4. Otherwise (a body the guard cannot classify included), it matches an `allow` signature: it is a read.
5. Otherwise, its method, upper-cased, is not GET, HEAD or OPTIONS: it is a write. A GET, HEAD or OPTIONS is a read.

With `graphql` empty, only rules 1, 4 and 5 can apply, as before the key existed.

A write is `block` under `read-only` and `observe` under `observe`; a read is `allow`. For example, `{ "method": "POST", "url": "^https://app[.]example[.]com/graphql" }` in `allow` lets a GraphQL endpoint through, and `{ "method": "POST", "url": "^https://app[.]example[.]com/graphql", "body": "mutation" }` in `writes` still blocks its mutations, because `writes` is checked first.

**A request is suspect** when its method, upper-cased, is GET or HEAD and its URL matches the suspect pattern. The suspect pattern is the built-in pattern (unless `defaultSuspectGets` is `false`) plus every `suspectGets` source, joined into one case-insensitive regex. It is tested, unanchored, against the URL's path plus query (`pathname` followed by `search`, never the origin or the hash) when the URL parses as an absolute URL, and against the URL as given when it is relative or does not parse. The built-in pattern is:

`(?:^|[/._-])(?:(?:log|sign)[-_]?out|unsubscribe|confirm|delete|remove)(?:$|[/._?&#-])|[?&]action=`

So `/logout`, `/users/sign_out`, `/unsubscribe?t=1` and `/items?action=delete` are suspect, and `/catalog` and `/deleted-items` are not. A suspect request is never blocked at the network: wherever a GET or HEAD is allowed (browser egress, request clients, Node's `fetch`), a suspect one is recorded as a `suspect` event and proceeds. With no built-in pattern and no `suspectGets`, nothing is suspect. A `writes` signature still makes a GET a write.

**A control is destructive** when its label matches the label pattern, or it has a class starting with one of the `controls.icons` prefixes. The label pattern is the built-in verbs (unless `defaultControls` is `false`) plus every `controls.text` source, joined into one case-insensitive regex. The built-in verbs match as whole words, case-insensitive (`Save` and `Delete item` match, `Saved` does not):

`save`, `delete`, `remove`, `publish`, `send`, `archive`, `pay`, `purchase`, `refund`, `log out`, `sign out`, `logout`

**Built-in exceptions.** Unless `defaultExceptions` is `false`, a short list of view-only labels is exempt from the label pattern. The exception pattern is case-insensitive and anchored at both ends, so it matches only the whole trimmed label:

`^(?:(?:remove|clear)\s+filters?|clear\s+search|remove\s+columns?)$`

So `Remove filter`, `Clear filters`, `clear search` and `Remove columns` are not refused by label, while `Remove filter rule permanently`, `Save search` and `Send feedback` still are: only a whole label matches, and there are no exceptions for `save` or `send` phrases. An exception skips only the label check: a control whose icons match `controls.icons` is still refused. When an exception lets a control through, `decideControl` returns `allow` with the reason `"<label>" is a built-in read-only exception`. With `defaultExceptions: false` there are no exceptions. An exception skips the whole text match, so your own `controls.text` patterns are skipped for an excepted label too (an icon match still refuses it). To have `controls.text` apply to those labels, set `defaultExceptions: false`. `Clear filters`, `Clear search` and `Clear filter` contain no built-in verb anyway, so only `Remove filter`, `Remove filters`, `Remove column` and `Remove columns` depend on the exception.

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

## The decision core: `playwright-write-guard`

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
  - `defaultExceptions` that is not a boolean, which throws `write-guard: defaultExceptions: must be a boolean`;
  - `logBodies` that is not a boolean, which throws `write-guard: logBodies: must be a boolean`;
  - `log` that is neither a non-empty string nor `null`.

  The result is `{ policy, allow, writes, text, exceptions, icons, websockets, websocketWrites, suspect, log, logBodies }`: `allow` and `writes` hold `{ method, url: RegExp, body: RegExp | null, headers: Array<{ name: string, value: RegExp }> }`, where `method` is `"*"` or the method name in upper case and `headers` holds one entry per named header, its `name` in lower case (empty when the Sig names none); `text` is the label pattern (`null` when there is none); `exceptions` is the built-in exception pattern (a case-insensitive `RegExp`, `null` when `defaultExceptions` is `false`); `icons` is `controls.icons`; `websocketWrites` is a `RegExp[]`, one per source, each compiled with no flags (empty by default); `suspect` is the suspect pattern, a single case-insensitive `RegExp` made of the built-in pattern (unless `defaultSuspectGets` is `false`) and every `suspectGets` source, each wrapped in `(?:...)` and joined with `|`, or `null` when there are none; `logBodies` is `false` unless the config sets it to `true`.
- `decideRequest({ method, url, body, headers }, compiled)` returns `{ action, reason }`. `body` is `null` or absent when the request has none. `headers` is an object of header name to value, names in any case (`decideRequest` lower-cases them itself), absent when the request has none, in which case no Sig that names headers matches. For a write, `action` is `"block"` under `read-only` and `"observe"` under `observe`; for anything else it is `"allow"`.
- `decideControl({ label, icons }, compiled)` returns `{ action, reason }`. For a destructive control, `action` is `"block"` under `read-only` and `"observe"` under `observe`; for anything else it is `"allow"`. When `compiled.exceptions` matches the trimmed label, the label pattern is skipped (an icon match still makes the control destructive), and an allowed control's reason is `"<label>" is a built-in read-only exception`.
- `decideFrame(text, compiled)` returns `{ action, reason }` for one outbound WebSocket frame. When `text` is a string that matches any `compiled.websocketWrites` pattern (tested unanchored), `action` is `"block"` under `read-only` and `"observe"` under `observe`. A string that matches none, and a frame that is not a string (a binary frame), are always `"allow"`. With an empty `websocketWrites`, every frame is `"allow"`.
- `decideSuspect({ method, url }, compiled)` returns `{ suspect, reason }`, where `suspect` is a boolean. It is `true` only when `method`, upper-cased, is `GET` or `HEAD`, `compiled.suspect` is not `null`, and `compiled.suspect` matches the tested string: the URL's `pathname` followed by its `search` when `new URL(url)` parses it, else `url` as given (a relative or unparsable URL). It never depends on the policy: a suspect request is recorded, never blocked, by the callers described under the installer.
- `reason` is a short human-readable explanation; its wording is not part of the API.

`compileConfig`, `decideControl`, `decideSuspect` and `decideRequest` reference nothing outside their own arguments, because the installer injects their source text into every page (`decideRequest` for the leaving-page sends of installer step 8). `decideFrame` runs only in Node, in the process that called `install`.

## The installer: `playwright-write-guard/install`

`install(context, config?)` guards one Playwright `BrowserContext` and returns `Promise<GuardHandle>`. It compiles `config` (default `{}`) with `compileConfig`, so a malformed config throws before anything is installed (an `allow` URL that matches the empty string included). Once the config compiles, it prints the warning for each unanchored `allow` URL (see Sig), once per process. A second call on the same context returns the first call's handle and ignores its own `config`. It:

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
   - At every egress, the event's `contentType` is the effective `content-type` header (at (c), the judged one, defined under Request clients: the last entry whose name lower-cases to `content-type`), and its `headerNames` are the effective header names.
   - On `block`: (a) and (b) fulfill a request whose resource type is `document` with status 403, content type `text/html; charset=utf-8`, and a short HTML page reading `write-guard blocked <METHOD> <URL>` (the effective method and URL, HTML-escaped), so a blocked navigation shows why instead of a browser error page, and abort any other request with `'blockedbyclient'`, which the page sees as a network error; (c) rejects with `write-guard: route.fetch of <METHOD> <URL> is refused under read-only`, with the effective method and URL.
   - **The console warning for a blocked request.** Under `read-only`, when (a) or (b) blocks a request whose resource type is not `document`, the guard first logs `write-guard refused <METHOD> <URL>: <reason>` with `console.warn` in the request's frame (`route.request().frame()`), where `<METHOD>` and `<URL>` are the effective method and URL and `<reason>` is the reason `decideRequest` returned, and then aborts the request as above. The guard does not wait for the log and ignores any error, such as a detached frame or a request that a worker made, so such a request is aborted with no warning. A blocked navigation keeps its 403 page and gets no warning. Under `observe` nothing is blocked, so nothing is warned. Egress (c) and the request clients are unchanged: they reject in Node with the message above, and warn nothing in a page. The warning is not an event and is not recorded.
   - On `allow`, when the effective method is GET or HEAD and `decideSuspect({ method, url }, compiled)` returns `suspect: true` for the effective method and URL, the guard records a `request` event with `action: "suspect"` and the reason `decideSuspect` returned. A suspect request is never blocked.
   - On `allow` or `observe` (`observe` records the event first, and so does a suspect `allow`): (a) proceeds with `route.fallback()`, never `continue()`, so handlers registered behind it (a launcher client's `context.route`) still run; (b) and (c) call Playwright's own `continue` or `fetch` with the same options.
   - Each egress attempt records at most one event (none when the request is allowed and not suspect). `routed_requests` counts each request once, at its first egress; a request a caller fulfills or aborts without reaching an egress is not counted.
4. Registers one `context.routeWebSocket`, matching every URL, under both `websockets` settings and either policy:
   - Under `"allow"`, each socket is recorded as `{ kind: "websocket", action: "open", url, at }` and connected with `ws.connectToServer()`. When `websocketWrites` is empty, that is all the route does (as in 0.2.x), and no message is judged or logged.
   - Under `"allow"` with a non-empty `websocketWrites`, the route keeps the server side that `ws.connectToServer()` returns and judges each message the page sends with `decideFrame(message, compiled)`, in order: on `"block"` the message is dropped (never forwarded to the server) and recorded as `{ kind: "websocket", action: "block", reason, url, at }`; on `"observe"` it is recorded the same way with `action: "observe"` and then forwarded; on `"allow"` it is forwarded with no event. A binary message is always forwarded. With `logBodies: true`, a frame event also carries `frame`, the first 500 characters of the message. Messages the server sends to the page are never judged and always arrive. Dropping a message does not close the socket.
   - Under `"block"`, each socket is closed with code 1008 without connecting to the server, and recorded as a `request` event with `action: "block"` and the socket's `url` (no `method`).

   No socket or frame counts in `routed_requests`. An `open` event counts in neither `blocked` nor `observed`; a frame event counts in `blocked` or `observed` by its `action`. Because the guard always routes sockets: under both settings Playwright replaces the page's `WebSocket` with its routed implementation; in launcher mode an attached client cannot register its own `routeWebSocket` (Playwright throws `Another client is already routing WebSockets`); in the guard's process a caller's own `routeWebSocket` registered later takes precedence, and then no open is recorded, no frame is judged, and `"block"` does not refuse that socket; sockets opened by dedicated or shared workers are not routed, so they are neither recorded nor blocked, and their frames are not judged (under `read-only` no shared worker starts, see step 8).
5. Adds an init script that runs before any page script, with capture-phase `click`, `submit` and `keydown` (Enter or Space) listeners on `window` that find the control as described under Writes and controls and judge it: with `decideSuspect` when it is a link that navigates, else with `decideControl`. The script carries the source of `compileConfig`, `decideControl`, `decideSuspect` and `decideRequest` (used by step 8), compiled from the same raw config. Under `read-only` a destructive control's event (a suspect link's included) is stopped (`preventDefault` and `stopImmediatePropagation`), so the app never sees it and a suspect link does not navigate, and the page calls its original `console.warn`, which the script captures before any page script runs, with exactly `write-guard refused "<label>": <reason>`, where `<label>` is the control's label cut to 120 characters and `<reason>` is the reason `decideControl` (or, for a link, `decideSuspect`) returned. Under `observe` the event goes through and nothing is written to the console. Either way the page reports the event through the binding `__writeGuardReport`, which the script captures before any page script can replace it.
6. Under `read-only`, dismisses every dialog (`alert`, `confirm`, `prompt`, `beforeunload`) on every page, so a native confirmation before a delete is declined.
7. Under both policies, judges every send through the context's request client. It wraps `context.request` once, as `guardRequestClient(context.request, { baseURL })` does (below), with `baseURL` the `baseURL` option the context was created with, and makes `context.request` and the `request` of every page in the context, present and future, return that one wrapper. A page's `request` is the same object as its context's (Playwright 1.64), so each send is judged once and records at most one event. Every property that is not a send method stays readable, with methods bound to the raw client. This wrapper exists only in the process that called `install`.
8. Under `read-only` only, the init script of step 5 also guards, in the page, three kinds of send that Playwright does not route. It does so in every frame the script runs in: every frame of every page, cross-origin frames and `about:blank` frames a script creates included. Under `observe` it replaces or removes none of the globals below, so `fetch`, `sendBeacon`, `XMLHttpRequest`, `SharedWorker` and `fetchLater` stay the browser's own, and a send from a leaving page, HTTP from a shared worker and a `fetchLater` request are neither judged nor recorded.
   - **Sends from a leaving page.** A request a document starts while it is being left (from a `visibilitychange`, `pagehide` or `unload` handler when the page navigates with `page.goto`, follows a link or closes) is not routed by Playwright 1.64 and reaches the server unjudged, whether it is a `navigator.sendBeacon`, a `fetch` with `keepalive: true`, or an ordinary `fetch` or `XMLHttpRequest`. A frame is **leaving** when its own document, or the document of any same-origin ancestor, has `visibilityState` `hidden` or has fired `pagehide` with no `pageshow` since. The script walks `window.parent` up to the top: an ancestor whose document it cannot read (a cross-origin one) is skipped, and the walk goes on past it, so a same-origin frame behind a cross-origin frame counts its same-origin ancestors above that frame. The script reads `visibilityState` with the `Document.prototype` getter it captures before any page script runs, tracks `pagehide` and `pageshow` with capture-phase listeners on `window` added before any page script, and exposes that flag to same-origin descendant frames as a non-configurable getter on its `window` keyed by `Symbol.for('playwright-write-guard.pagehide')` (when a parent's handler calls into a child frame, the child has seen neither event yet, so ancestors count).
   - **Judged in the page.** While a frame is leaving, each send below whose method, upper-cased, is not GET, HEAD or OPTIONS is judged in the page with `decideRequest({ method, url, body, headers }, cfg)`, where `cfg` is the config the page script already compiles for controls and suspect links: the script embeds the raw config as JSON and calls `compileConfig` on it in the page, so no `RegExp` is serialised, and it now also carries the source text of `decideRequest` (which, like the others, references nothing outside its own arguments). So `allow` is honoured, and a non-read method that matches no `allow` signature is `block`. The judged request:
     - `method`: the method, upper-cased (`POST` for a beacon).
     - `url`: the URL resolved against `document.baseURI` with its fragment removed (`u.hash = ''` before reading `href`), as a server receives it; for `fetch`, the built `Request`'s `url` treated the same way; the URL as given when it does not parse.
     - `body`: a string when the page can read the data synchronously as one, else none (`null`). A string is used as is; a `URLSearchParams` as `String(data)`, which is what is sent; an `ArrayBuffer` or a view of one (`ArrayBuffer.isView`) decoded as UTF-8 with `new TextDecoder().decode(data)`. Each kind is tested with `typeof` or `instanceof` against the frame's own constructors captured before any page script runs. A `Blob`, a `FormData`, a stream, any other value, no data or `null`, and the body of a `Request` given to `fetch` (it can only be read asynchronously), are none, so a Sig with a `body` never matches them. For `fetch` the data is `init.body`, when `init` is given and its `body` is not `undefined`; for an XHR it is the argument of `send`; for a beacon it is `data`.
     - `headers`: for `fetch`, every entry of the built `Request`'s `headers` (names in lower case, repeated names joined with `, `, and including the `content-type` the `Request` derives from its body, such as `text/plain;charset=UTF-8` for a string); for an XHR, the headers set with `setRequestHeader` since the last `open`, names lower-cased and repeated names joined with `, ` (the `content-type` the browser adds itself is not among them); for a beacon, none (`{}`).
   - On `allow`, the send proceeds unchanged: the original `fetch` with the built `Request`, the original `send` with the same arguments, or the original `sendBeacon` with the same `this` and arguments. A beacon or a `keepalive` fetch allowed this way reaches the server; an ordinary `fetch` or XHR may still be cancelled by the browser with the document. On `block`, nothing is sent: `fetch` returns a promise rejected with a `TypeError`, an XHR `send` throws a `TypeError`, and `sendBeacon` returns `false` (what the browser returns for a beacon it cannot queue); each carries or writes the refusal below. Neither outcome is recorded.
   - The script assigns these replacements over captured originals, so each property keeps its attributes:
     - `window.fetch(input, init)`: when the frame is not leaving, it calls the original `fetch` with the same arguments, untouched. When it is leaving, it builds `new Request(input, init)` with the original `Request` (a throw is returned as a rejected promise, as `fetch` does). A request whose method, upper-cased, is GET, HEAD or OPTIONS is passed to the original `fetch` unjudged; any other is judged as above. `keepalive` plays no part, so a `Request` built with `keepalive: true` and then passed to `fetch` is treated the same way.
     - `Navigator.prototype.sendBeacon(url, data)`: when the frame is not leaving, it calls the original with the same `this` and arguments, so the beacon is validated, sent and answered exactly as the browser does it. When it is leaving, it is judged as above before anything else (a beacon whose URL does not parse is judged with the URL as given, and is sent to the original only on `allow`, which then throws as the browser does).
     - `XMLHttpRequest.prototype.open`, `setRequestHeader` and `send`: `open` calls the original and then remembers the method, upper-cased, and the resolved URL, and forgets earlier headers; `setRequestHeader` calls the original and then remembers the header; `send` is judged as above when the remembered method is not GET, HEAD or OPTIONS and the frame is leaving, and otherwise calls the original with the same arguments.
   - The refusal is the message `write-guard: <METHOD> <URL> from a hidden or unloading page is refused under read-only`, with the judged method and URL. The page calls its captured `console.warn` with exactly that message. It is not reported through `__writeGuardReport`: a page that is being left cannot report reliably, so a judged send records no event and counts nowhere, whatever the decision.
   - A leaving frame's reads (GET, HEAD, OPTIONS) go through unchanged and, like every other send from a page being left, are not judged.
   - A page that is not leaving is untouched: its beacons, keepalive fetches and XHRs are routed and judged at egress like any other request (step 3), and so are the sends of a `beforeunload` handler, which runs while the page is still live. A beacon is a POST with credentials included, and its body and `content-type` are what `fetch` sends for the same data: a string (or any value that is none of the kinds below) as text with `text/plain;charset=UTF-8`; a `Blob` with its own type (no `content-type` when the type is empty); a `FormData` as `multipart/form-data; boundary=...`; a `URLSearchParams` with `application/x-www-form-urlencoded;charset=UTF-8`; an `ArrayBuffer` or a view of one with no `content-type`; no data, or `null`, as an empty body with no `content-type`.
   - Headless Chromium keeps every page `visible`, so there only a page being left is leaving. In a headed browser a background tab is `hidden`, so its writes are judged in the page this way too.
   - **SharedWorker and fetchLater.** HTTP from a shared worker is not routed, and neither is a request made with `fetchLater`, even from a page that is not leaving, so the script deletes `window.SharedWorker` and `window.fetchLater` (in Chromium each is an own, configurable property of the window), and `'SharedWorker' in window` and `'fetchLater' in window` are then `false`. An app that checks for them can fall back to a dedicated `Worker`, `fetch` or `sendBeacon`; one that calls them without checking gets the browser's own error for a missing global. Nothing is recorded or written to the console. Dedicated workers are unchanged: their requests are routed, except a request started at the instant its page or context closes (see What it cannot see).

**Request clients.** A request client is an `APIRequestContext` (wrapped by step 7, by `guardRequestClient`, and by the fixture's `request`) or Node's `fetch` (wrapped by `guardFetch`, and by the fixture while a test runs). Each send is judged with `decideRequest` on its effective request, under both policies:

- **An `APIRequestContext` send** is a call to `fetch`, `get`, `post`, `put`, `patch`, `delete` or `head` on the wrapper; every property that is not one of these send methods reads through to the client, with methods bound to the raw client. The guard builds the merged options `m` that Playwright 1.64 builds before it sends, judges what Playwright would send, and reads its effective request from `m`:
  - Merged options: for `fetch(a, options)`, `m = { url: a when a is a string, request: a otherwise, ...options }`. For `get`, `post`, `put`, `patch`, `delete` and `head`: the same, followed by `method: NAME`, the method's name in upper case (`m = { url: a when a is a string, request: a otherwise, ...options, method: NAME }`). Because `...options` comes after the first argument, `options.url`, `options.request` and `options.headers` override what the first argument gave, and so does `options.method` for `fetch`; a `request` here is a Playwright `Request`, given as the first argument or as `options.request`.
  - A string in these rules is a value Playwright's `isString` accepts, `typeof v === 'string' || v instanceof String`: the first argument `a` and `m.data` are tested that way, so a String object as `data` is judged as its string value. Two tests are Playwright's narrower ones instead: `m.params` is a string only when `typeof m.params === 'string'` (a String object appends its `Object.entries`, as any other object does), and the JSON re-encoding check under Body counts only a primitive string as parsing (Playwright's `isJsonParsable`), so under that check a String object is judged as its `JSON.stringify` encoding.
  - Method: `m.method || m.request?.method() || 'GET'`, upper-cased.
  - URL: `m.url !== undefined ? m.url : m.request.url()` (an `APIRequestContext` rejects URL objects). It is resolved against the client's `baseURL` when one is set (`new URL(url, baseURL)`, so an absolute URL stays as it is), else parsed alone (`new URL(url)`); when resolving against `baseURL` throws (an invalid `baseURL`), it is parsed alone. Then `m.params`, when given, is applied as Playwright 1.64 applies it: a string or `URLSearchParams` whose string form is non-empty replaces the query (`u.search = String(params)`); an empty one leaves the URL unchanged; any other non-null object appends (an array included) its `Object.entries`, skipping `undefined` (`u.searchParams.append(name, String(value))`, in `Object.entries` order); any other value leaves the URL unchanged (a number, or `null`). The judged URL is the resulting URL with its fragment removed (`u.hash = ''` before reading `href`), the URL a server receives, and the event's `url` has that form. Only when parsing alone throws too (a relative URL with no `baseURL` or with an invalid one, or an unparsable URL) is the URL judged as the raw string, with no params applied.
  - Headers: `m.headers || m.request?.headers()`, else none. Its entries are the names a `for...in` loop enumerates on that headers object (own and inherited enumerable keys, as Playwright reads them), in that order; entries whose value is `undefined` are skipped (Playwright does not send them), and names are lower-cased. When two names are equal after lower-casing, the last one is judged and recorded, because Playwright sends the last; this holds for `content-type` too, so the effective `content-type` header is the last entry whose name lower-cases to `content-type`. Only the JSON re-encoding check of `m.data` (under Body) uses the first entry whose name lower-cases to `content-type`, as Playwright reads it there. Headers the client adds itself (its `extraHTTPHeaders`, a `content-type` it sets for `data`) are not part of the effective request.
  - Body: `m.data` when it is not `undefined`: a string as is, except that when the first entry whose name lower-cases to `content-type` has the value exactly `application/json` (no parameters) and the string does not parse as JSON (`JSON.parse` throws), it is judged as its `JSON.stringify` encoding, which is what Playwright sends; a Buffer as UTF-8; any other value as its `JSON.stringify` encoding. Else, when neither `m.form` nor `m.multipart` is given (Playwright tests each for a truthy value), `m.request?.postDataBuffer()` read as UTF-8, so the body of a given `Request` is judged; `null` when that returns `null` or there is no `m.request`. Else `null`: a `form` or `multipart` body is not judged by body.
- **A Node `fetch(input, init)` call.** Its effective request:
  - Method: `init.method`, else the `method` property of `input` when it is a Request, else `GET`, upper-cased. A given input is a Request only when `input instanceof globalThis.Request`.
  - URL: `input` when it is a string, its `url` property when it is a Request (`input instanceof globalThis.Request`), and `String(input)` for any other input (for an ordinary `URL` that equals its `href`); when that parses as an absolute URL, the judged URL is its `href` with its fragment removed (`u.hash = ''` before reading `href`), the URL a server receives, and the event's `url` has that form; else the raw string.
  - Body: `init.body` when it is a string, else `null` (a stream, `FormData`, `URLSearchParams`, Blob or buffer body, and the body of a given `Request`, are not judged by body).
  - Headers: `init.headers`, else the `headers` of `input` when it is a Request (`input instanceof globalThis.Request`), else none; each (a plain object, an array of name and value pairs, or a `Headers`) is normalised through `new Headers(h)`, so repeated names are joined with `, ` as fetch sends them, and then passed with lower-cased names.
- **The decision.** On `block`, the send rejects without sending, with `write-guard: <METHOD> <URL> through <via> is refused under read-only`, where `<METHOD>` and `<URL>` are the effective method and URL and `<via>` is `APIRequestContext` or `fetch` (for example `write-guard: POST https://app.example.test/items through APIRequestContext is refused under read-only`). On `observe`, it records the event and sends. On `allow`, it sends, and first records a `suspect` event when `decideSuspect` says the effective method and URL are suspect. A send is passed on with its original arguments, untouched.
- **The event** is a `request` event with the effective `method`, `url`, `contentType` (for an `APIRequestContext` send, the judged `content-type` header, the last of equal names), `headerNames` and (with `logBodies: true`) `body`, plus `via`: `"request-client"` for an `APIRequestContext`, `"node-fetch"` for Node's `fetch`. These events count in `blocked`, `observed` or `suspect` by their `action`, never in `routed_requests`.

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
- `at` is an ISO 8601 timestamp. Allowed requests that are not suspect, allowed frames and allowed controls produce no event, and neither do the page-side refusals of installer step 8.

**The handle.**

- `record()` returns `{ installed: true, policy, config_file, routed_requests, blocked, observed, mocked, suspect, events }`: `config_file` is the `configFile` of the raw config when that is a string (what `loadConfig` sets: the absolute path it read), else `null`, so a config passed as a plain object records `null`; `routed_requests` counts the requests the guard judged at browser egress, each once, at its first egress, and no WebSockets, mocks or request-client sends; `blocked` and `observed` count request, control and websocket events by their `action` (`"block"` or `"observe"`), and websocket `open` events count in neither; `mocked` counts request events with `action: "mocked"`, and `suspect` request events with `action: "suspect"`. Each event counts in at most one of `blocked`, `observed`, `mocked` and `suspect`.
- `close()` resolves after the last pending log append and returns the final `record()`. The guard stays active until the context closes.
- `guardRequestClient(client, { baseURL })` returns a wrapper over the `APIRequestContext` `client` whose sends are judged as described under Request clients, with this guard's config, and recorded in this guard's record and log with `via: "request-client"`. `baseURL` is optional; without it, a relative URL is judged as the raw string. Every property that is not a send method reads through to `client`, with methods bound to the raw client. The fixture judges and records the `request` fixture's sends this way in a test and its `beforeEach` and `afterEach` hooks.
- `guardFetch(fetchFn)` returns a function with `fetchFn`'s signature that judges each call as described under Request clients, with this guard's config, records it in this guard's record and log with `via: "node-fetch"`, and then either rejects or returns `fetchFn(input, init)` called with the same arguments. The fixture uses it for Node's global `fetch` while a test runs.

**The audit log.** When `config.log` is a path, each event is appended to that file as one JSON line, as it happens. The path is relative to the process's working directory; the file is created when missing and never truncated.

**`loadConfig(path?)`** returns a raw config to pass to `install`, with one extra key, `configFile`: the absolute path of the file it read, or `null` when it read no file (a `configFile` key inside the file is overwritten). `compileConfig` ignores `configFile`, `install` records it as `config_file` and never embeds it in a page, and the launcher prints it. It reads, synchronously with `fs.readFileSync`, the first of: `path`; else the file named by the environment variable `WRITE_GUARD_CONFIG`; else `write-guard.config.json` when that file exists; else it uses `{}`. Relative paths resolve against the process's working directory. A file named by `path` or `WRITE_GUARD_CONFIG` must exist, or `loadConfig` throws. When the environment variable `WRITE_GUARD_POLICY` is set to a non-empty value, it overrides `policy`. The result is validated with `compileConfig`, so a file that does not parse as JSON, an invalid config or an invalid `WRITE_GUARD_POLICY` throws. A file that cannot be read throws `write-guard: <file>: cannot be read: <system message>`, and a file that does not parse throws `write-guard: <file>: is not valid JSON: <parser message>`, where `<file>` is the path as resolved. Every entry point below that defaults to `loadConfig()` therefore honours `WRITE_GUARD_CONFIG` and `WRITE_GUARD_POLICY`; a config you pass explicitly to `install`, `test.use` or `startGuardedBrowser` is used as given.

## The Playwright Test fixture: `playwright-write-guard/test`

```js
import { test, expect } from 'playwright-write-guard/test';

test.use({ writeGuardConfig: { policy: 'read-only', allow: [] } });

test('lists items without changing them', async ({ page }) => {
  await page.goto('https://app.example.com/items');
  await expect(page.getByRole('list')).toBeVisible();
});
```

- `test` and `expect` are Playwright Test's, extended with two option fixtures, `writeGuardConfig` and `writeGuardFailOnBlocked`, settable with `test.use` or the config's `use`. `writeGuardConfig` defaults to `loadConfig()`, which resolves relative to the working directory: running Playwright with `-c` from another directory needs `WRITE_GUARD_CONFIG` to find the config.
- `writeGuardFailOnBlocked` is a boolean, `false` by default. At the end of the `context` fixture, after every record is attached, when it is `true` and the test's guard and every context made in the test blocked more than 0 events in all, the fixture throws `write-guard: <n> blocked event(s) and writeGuardFailOnBlocked is set: <items>`, where `<n>` is that total and `<items>` lists the first 5 blocked events in order, joined by `; `, each as `request <METHOD> <URL>`, `control "<label>"` or `websocket <URL>`. Only recorded blocks count: `mocked`, `suspect` and `observe` events never do (so nothing counts under `observe`), nor do a `request` fixture send in a `beforeAll` or `afterAll` hook, or the refusals of a page that is being left, because none of them is recorded.
- The `context` fixture is created with `serviceWorkers: 'block'` and guarded with `install`, with `log` forced to `null` (the fixture never writes a log file). That also judges every send through `context.request` and `page.request` (installer step 7). A test whose effective `serviceWorkers` option is not `'block'` fails at fixture setup with an error starting `write-guard: serviceWorkers is`, because a service worker could send requests the guard never sees. This is the test's guard: its record is `write-guard.json`.
- The `request` fixture works under both policies, and does not depend on the `context` fixture (Playwright 1.64 refuses `context` in a `beforeAll` or `afterAll` hook). Playwright creates it with `playwright.request.newContext()` (the one call of that method the fixture lets through). Each send through it is judged as described under Request clients, on its effective request with `baseURL` the `baseURL` fixture, so a GET goes through and, under `read-only`, a write rejects without sending. Where the send is recorded depends on where it is made:
  - In a test and its `beforeEach` and `afterEach` hooks, each send is judged and recorded by the test's guard (the `context` fixture's), looked up when the send is made, as that guard's `guardRequestClient(request, { baseURL })` judges and records it; its events (`via: "request-client"`) are in `write-guard.json`.
  - In a `beforeAll` or `afterAll` hook there is no test guard, and each send is judged but not recorded: it is judged with `decideRequest` on the same effective request, with the config from `writeGuardConfig`, with the same block message and the same `allow` and `observe` behaviour, and no event is recorded and no log line is written.
- While a guarded test's own function runs (not a `beforeAll`, `afterAll`, `beforeEach` or `afterEach` hook), Node's global `fetch` is replaced by the test guard's `guardFetch(fetch)`, so each call is judged as described under Request clients and its events (`via: "node-fetch"`) are in `write-guard.json`.
- While a guarded test's own function runs, `browser.newContext(options)` returns a guarded context: it creates the context with `serviceWorkers` set to `'block'` (when `options.serviceWorkers` is given with any other value, it throws the same `write-guard: serviceWorkers is ...` error as above, before creating anything), then guards it with `install`, using the test's config with `log` forced to `null`, before returning it. At the end of the test, each such context's `record()` is attached as `write-guard-<n>.json` (`application/json`), numbered from 2 in the order the contexts were created. `browser.newPage(options)` goes through that same `newContext` (Playwright 1.64 calls it internally), so its page's context is guarded and numbered the same way; `newPage` attaches nothing of its own. Playwright's own creation of the test's context is outside this wrapper, and is not numbered.
- Under both policies, in a guarded worker, these throw an error starting `write-guard:` because they would make a browser context, request context or connection the guard cannot see:
  - outside a guarded test's own function (in any hook, `beforeAll`, `afterAll`, `beforeEach` or `afterEach`, and in fixture setup and teardown), `browser.newContext`, `browser.newPage` and Node's global `fetch`, as in 0.2.x, except Playwright's own creation of the test's context;
  - everywhere, `playwright.request.newContext`, except Playwright's own creation of the `request` fixture;
  - everywhere, the browser types' `launch`, `launchPersistentContext`, `launchServer`, `connect` and `connectOverCDP`.
- Each test attaches its guard's `record()` as `write-guard.json` (`application/json`), and each context it created with `browser.newContext` or `browser.newPage` as `write-guard-<n>.json`.

## The `initPage` entry: `playwright-write-guard/init-page`

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

## The launcher: `playwright-write-guard/browser`

`startGuardedBrowser({ config, headless = true, host = '127.0.0.1', port = 0, title = 'write-guard', storageState, proxy, ignoreHTTPSErrors })` returns `Promise<{ wsEndpoint, browser, context, guard, close() }>`. It launches Chromium with `playwright-core`, creates one context with `serviceWorkers: 'block'`, guards it with `install(context, config)` (`config` defaults to `loadConfig()`), and calls `browser.bind(title, { host, port })`; `wsEndpoint` is the `endpoint` that returns, `ws://<host>:<port>/<id>` (`port: 0` lets the OS pick a free port). `guard` is the install handle. `close()` waits for `guard.close()`, then closes the context and the browser.

The three context options are passed to the one `browser.newContext({ serviceWorkers: 'block', ... })` only when they are not `undefined`:

- `storageState`: a path to a Playwright storage state file, or a storage state object. The context starts with its cookies and local storage, so the agent attaches to a session that is already logged in. A path that cannot be read or parsed makes `startGuardedBrowser` reject with Playwright's message.
- `proxy`: a Playwright proxy object, for example `{ server: 'http://proxy.example.test:3128' }`.
- `ignoreHTTPSErrors`: a boolean; `true` accepts invalid certificates (self-signed ones, for example).

The module also exports `PLAYWRIGHT_MCP_VERSION`, a string (`'0.0.83'`): the Playwright MCP version the launcher command's printed config and the demos pin, and the version the guard was checked with. The docs name the same version, and a unit test fails when they do not.

A client attaches with `chromium.connect(wsEndpoint)` and sees the guarded context as `contexts()[0]`. The guard runs in the launcher's process, so the client's own `unroute` and `unrouteAll()` cannot remove it, and a `page.route` handler that calls `continue()`, with or without overrides, is still judged (page handlers run before the owner's context route, and the request reaches the guard's catch-all with the overrides applied). New tabs the client opens in that context are guarded. A client's `page.route` handler can `fulfill` or `abort` a write, so it can mock one; that handler runs in the client's process, so the mock is not recorded as `mocked`. A client's `context.route` handler runs after the guard's catch-all, in the client's process: it receives only requests the catch-all already judged and let through, so it cannot mock a blocked write, its `continue()` or `fallback()` overrides are not judged again, and its `route.fetch()` is not seen; see "What it cannot see" below. The client cannot register its own `routeWebSocket`, because the guard already routes every WebSocket (Playwright throws `Another client is already routing WebSockets`).

The command does the same from a shell:

```
npx playwright-write-guard-browser [--config <path>] [--headed] [--host <h>] [--port <n>] [--storage-state <path>] [--proxy <url>] [--ignore-https-errors] [--print-mcp-config]
```

`--config` is passed to `loadConfig` (so without it, `WRITE_GUARD_CONFIG` and `write-guard.config.json` apply), `--headed` sets `headless` to false, and `--host` and `--port` default to `127.0.0.1` and `0`. `--storage-state <path>` sets `storageState` to that path, `--proxy <url>` sets `proxy` to `{ server: <url> }`, and `--ignore-https-errors` sets `ignoreHTTPSErrors` to true. A storage state file that cannot be read or parsed is a startup failure: the command prints Playwright's message and exits 1. Its first output line is `config: <path>`, the file `loadConfig` read, or `config: none, using the defaults` when it read none. It then prints `endpoint: <ws endpoint>` on a line of its own, then how to attach: Playwright MCP with `--endpoint <ws endpoint>` and without `--isolated` (which uses `contexts()[0]`), or the Playwright CLI with `playwright-cli attach --endpoint=<ws endpoint>`. It stays up until SIGINT or SIGTERM, then closes the browser and exits 0. An unknown flag or a flag missing its value prints the usage line, `usage: playwright-write-guard-browser [--config <path>] [--headed] [--host <h>] [--port <n>] [--storage-state <path>] [--proxy <url>] [--ignore-https-errors] [--print-mcp-config]`, and exits 1.

`--print-mcp-config` makes the command print a ready-made MCP client config after the `endpoint:` line: the line `MCP config (paste into your client's MCP settings):`, then this JSON with two-space indentation, where `<ws endpoint>` is the endpoint printed above:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@0.0.83", "--endpoint", "<ws endpoint>"]
    }
  }
}
```

`@playwright/mcp@0.0.83` is the version the guard was checked with. Without the flag the output is unchanged.

## The suggest command: `playwright-write-guard-suggest`

```
npx playwright-write-guard-suggest <log.jsonl>
```

It reads an audit log and drafts `allow` entries for the writes it lists. It reads only that file and never writes one.

- **Input.** It reads the file as UTF-8 and splits it into lines. A line that does not parse with `JSON.parse` (an empty line included) is skipped, and so is a parsed line that is not an object with a non-empty string `method` (control events, websocket events, refused sockets). Of the rest it keeps `request` events whose `action` is `"observe"`, `"block"` or `"mocked"`; `suspect` events are skipped. An event whose `url` does not parse as an absolute URL (`new URL(url)` throws) is skipped too.
- **Grouping.** Kept events are grouped by `method` and by origin plus path: `u.origin + u.pathname` for `u = new URL(url)`, so the query and the hash are dropped.
- **Output.** It prints to stdout one JSON document, `JSON.stringify({ allow }, null, 2)` followed by a newline. `allow` holds one entry per group, `{ "method": M, "url": "^<origin and path, escaped>(?:[?#]|$)" }`, where escaped means each of the characters `\ ^ $ . * + ? ( ) [ ] { } |` is preceded by a backslash. Entries are sorted by `url`, then by `method`, both in code unit order. With nothing kept, `allow` is `[]`.
- **Hints.** It prints to stderr one line per entry, in the same order: `<count> x <METHOD> <origin and path>`, where `<count>` is the number of events in the group and the origin and path are not escaped. When any event in the group has `next-action` in its `headerNames`, the line goes on with `: carries next-action, pin its action IDs with a headers entry`; otherwise, when the path ends with `/graphql`, with `: GraphQL, add the URL to "graphql" to allow its queries`. It then exits 0.
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

and stderr is `3 x POST https://app.example.test/graphql: GraphQL, add the URL to "graphql" to allow its queries`. Each entry allows every request with its method to its path, whatever the body or headers, so the output is a draft to review: narrow each entry with a `body` or `headers` pattern, and drop any that is a real write, before putting it in `allow`.

## What it cannot see

- `APIRequestContext` objects the guard cannot reach: an attached client's own `page.request` and `context.request` in launcher mode, and `playwright.request.newContext()` called from an agent's run-code tool.
- An agent's run-code tool, and any browser the agent launches itself.
- A Playwright Test run with `-c` from another directory without `WRITE_GUARD_CONFIG`: the fixture finds no config file and falls back to the defaults.
- WebSocket messages, except the text frames `websocketWrites` names: under the default `websockets: "allow"`, each socket a page opens is recorded as a `websocket` event, and its messages (writes included) are not judged or logged unless `websocketWrites` is set, and then only outbound text frames that match one of its patterns. Binary frames and messages the server sends to the page are never judged. `"block"` refuses every socket the guard routes.
- WebSockets opened by dedicated or shared workers: they are not routed, so they are neither recorded nor blocked, under either setting.
- A caller's own `routeWebSocket` registered after the guard in the same process takes precedence: no open is recorded, and `websockets: "block"` does not refuse that socket. In launcher mode an attached client cannot register its own `routeWebSocket`: Playwright throws `Another client is already routing WebSockets`.
- The page's `WebSocket`: under both settings Playwright replaces it with its routed implementation, which is noticeably slower.
- WebRTC and WebTransport.
- Redirects after the first URL: only the request the page, a request client or Node's `fetch` made is judged, not where the server redirects it.
- Drag-and-drop, and handlers that act without a `click`: pointer or mouse handlers that act before it, `dblclick` and `auxclick` handlers, and key handlers other than the Enter or Space keydown the guard judges (for example a `keyup` handler for Space on a `role=button`). The network layer still judges what they send.
- Client-side-only destructive actions that no click or submit reaches.
- Toggles: `role=switch` and `role=checkbox` elements and checkbox inputs, and `change` events, are not judged (a `<button role=switch>` is still a button and is judged by its label).
- Requests are classified only as well as the config: a write sent as GET, or a read sent as POST, needs a `writes` or `allow` signature.
- GET requests with side effects: only a GET or HEAD whose path plus query matches the built-in suspect pattern or a `suspectGets` pattern is recorded, as `suspect`, and it is never blocked. Any other pass with no event unless a `writes` signature names them, and `observe` does not list ordinary GETs. The built-in pattern is short: it misses paths such as `/items/7:delete`, and it also marks harmless GETs such as the static asset `/static/icons/delete-icon.svg`.
- Reads that send no query text (persisted GraphQL queries without an operation name): when nothing in the method, URL, headers or body tells such a read from a write, a signature that allows the endpoint allows its mutations too. With `graphql`, such a request is not classified and falls through to `allow` and the method rule in the same way.
- With `graphql`, only the operation type is judged: a query whose resolvers write is allowed.
- GET requests to a `graphql` endpoint stay reads: their `?query=` is not parsed.
- Bodies that are not text in the page (`FormData`, `Blob`, file uploads) are not parsed under `graphql`, so they fall through to `allow` and the method rule.
- Request bodies unless `logBodies` is `true`, and header values: events record the method, URL, content type and header names. `logBodies` is off by default because bodies can hold credentials and personal data.
- Bodies sent as `form` or `multipart` through an `APIRequestContext`, and Node `fetch` bodies that are not strings (streams, `FormData`, `URLSearchParams`, Blob, buffers) or that belong to a `Request` given to `fetch`: they are not judged by body (the method, URL and headers still are).
- A request client's own `extraHTTPHeaders`: they are not part of the request the guard judges (nor is a `content-type` the client sets itself for `data`), although browser egress sees a context's `extraHTTPHeaders`. A `headers` signature set up for a header the client adds on its own therefore does not match a request client's send.
- Values the guard reads once and Playwright or `fetch` reads again (an options getter, a `Request`'s `url()`, an object with its own `toString`): they can return something else the second time, so the request sent can differ from the one judged.
- A `fetch` function or `APIRequestContext` captured before the guard wrapped it: calls through the captured reference are not judged. Only `context.request`, `page.request`, the fixture's `request`, Node's `fetch` inside a test and what you pass to `guardRequestClient` or `guardFetch` are wrapped.
- In launcher mode, mocking a blocked write from a client's `context.route`: that handler runs after the guard's catch-all, so it never receives a blocked write. A client's `page.route` can mock one.
- Mocks outside the guard's process: a write that one of your own routes fulfills or aborts in the guard's process is recorded as `mocked`, but in launcher mode a client's routes run in the client's process, so their mocks are not recorded. A `fulfill` or `abort` of a request that already went through `route.fetch()` records nothing (the fetch was judged), and a GET that a route fulfills or aborts is never recorded as `suspect`. A mock is not counted in `blocked` or `observed`, so a broad stub such as `page.route('**/api/**', ...)` keeps its writes out of those counts; look at `mocked`.
- A `request` fixture send in a `beforeAll` or `afterAll` hook: it is judged but not recorded, because no test guard exists there, so a run's record and log do not list it.
- `writeGuardFailOnBlocked` counts only recorded blocks: it does not fail a test for a `request` fixture send refused in a `beforeAll` or `afterAll` hook, or for a leaving page's refusals, because neither is recorded. `mocked`, `suspect` and `observe` events never count either.
- The launcher's browser and context options: it takes storage state, a proxy and `ignoreHTTPSErrors` (`--storage-state`, `--proxy`, `--ignore-https-errors`), but no HTTP credentials and no other context option.
- The HTTP cache: Playwright turns it off while a route is installed.
- Service workers: `register()` resolves but `navigator.serviceWorker.ready` never settles.
- Any context other than `contexts()[0]` in launcher mode: `--isolated`, or `browser.newContext()` from an agent's run-code tool, makes a new, unguarded context.
- A client's `context.route` overrides in launcher mode are not judged again: that handler runs after the guard, in the client's process, so a `continue()` or `fallback()` that rewrites the method, URL or body (a GET rewritten to DELETE) reaches the server.
- A client's `route.fetch()` from any route handler (`page.route` or `context.route`) in launcher mode is not seen: it is sent through the client's own `APIRequestContext`, which the guard cannot reach.
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
- A link that navigates is refused in the page when its URL matches the suspect pattern, although following it may only read: a link to `/logout`, or to any URL with an `action=` query parameter, is refused, and so is a slugged URL that holds a built-in word, such as a help link to `/help/delete-a-repository`. Links judged by label (an empty, `#` or `javascript:` href, and `role=link`) are refused when their text holds a built-in verb ("Delete a repository" as a `#` link).
- Under `read-only`, `window.SharedWorker` and `window.fetchLater` are removed in every frame: an app that checks for them falls back to a dedicated `Worker`, `fetch` or `sendBeacon`, and an app that calls them without checking does not load that part.
- Under `read-only`, a dismissed `beforeunload` keeps the page: a test or an agent that leaves a page with unsaved changes stays on it, and a `page.goto` away from it throws `net::ERR_ABORTED` (a click on a link does not throw).
- The console warning for a blocked request: it goes through the page's own `console.warn`, evaluated in the request's frame, so a page that replaces `console.warn` can hide the message. A request with no frame to run in, such as a worker's, gets no warning either, and the page sees only the network error.
- The built-in click exceptions: the whole labels `Remove filter`, `Clear filters`, `Clear search` and `Remove columns` (any case, the plural of `filter` and `column` optional) are exempt from the label check even when an app makes such a click write, so the click layer does not refuse it. Only the network layer still judges what that click sends. `"defaultExceptions": false` turns the exceptions off.

It is a safety net, not a security boundary. A restricted test account is the boundary.
