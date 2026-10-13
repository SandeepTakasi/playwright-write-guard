// The installer, end to end in Chromium. Every page and API is served by routes on the fake
// host https://app.test, and request clients, route.fetch and sockets (which skip routes) by
// servers of their own on 127.0.0.1, so these tests need no network.

import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { install, loadConfig } from '../src/install.mjs';

const APP = 'https://app.test';
const SERVED = '{"ok":true}';
const HOME = `<!doctype html>
<script>window.hits = [];</script>
<form method="post" action="/api/items"><button id="go" type="submit">Go</button></form>
<button id="del" onclick="window.hits.push('del')">Delete item</button>
<button id="view" onclick="window.hits.push('view')">View</button>
<button id="trash" onclick="window.hits.push('trash')"><i class="icon-trash"></i></button>`;

const CONTROLS = `<!doctype html>
<script>window.hits = [];</script>
<div id="remove" tabindex="0">Delete</div>
<div id="drop" role="button" tabindex="0">Delete</div>
<div id="open" role="button" tabindex="0">Open</div>
<button aria-label="Delete item" onclick="window.hits.push('delete')"><span id="icon">x</span></button>
<button aria-label="Open item" onclick="window.hits.push('open item')"><span id="glyph">x</span></button>
<script>
for (const id of ['remove', 'drop', 'open']) {
  document.getElementById(id).addEventListener('keydown', (e) => window.hits.push(id + ' ' + e.code));
}
</script>`;

// Controls the page judges, and look-alikes it does not. Every element's text is "Delete".
const REAL = `<!doctype html>
<style>#j-image { width: 40px; height: 20px; }</style>
<script>window.hits = [];</script>
<div id="j-menuitem" role="menuitem">Delete</div>
<span id="j-tab" role="tab">Delete</span>
<span id="j-link" role="link">Delete</span>
<form id="j-form"><input id="j-submit" type="submit" value="Delete"> <input id="j-image" type="image" title="Delete" alt="">
<input id="n-reset" type="reset" value="Delete"></form>
<x-btn id="j-shadow">Delete</x-btn>
<a id="n-a">Delete</a>
<details><summary id="n-summary">Delete</summary><p>Body</p></details>
<div id="n-tabindex" tabindex="0">Delete</div>
<span id="n-onclick" onclick="window.hits.push('n-onclick')">Delete</span>
<table><tr id="n-row" tabindex="0"><td>Delete me</td><td><input id="n-check" type="checkbox"></td></tr></table>
<p id="n-text">Delete</p>
<x-closed id="n-closed"></x-closed>
<script>
customElements.define('x-btn', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<button><slot></slot></button>'; }
});
customElements.define('x-closed', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<button>Delete</button>';
    root.querySelector('button').addEventListener('click', () => window.hits.push('n-closed'));
  }
});
for (const id of ['j-menuitem', 'j-tab', 'j-link', 'j-submit', 'j-image', 'j-shadow', 'n-reset', 'n-a', 'n-summary', 'n-tabindex', 'n-row', 'n-check', 'n-text']) {
  document.getElementById(id).addEventListener('click', () => window.hits.push(id));
}
document.getElementById('j-form').addEventListener('submit', (e) => { e.preventDefault(); window.hits.push('submit'); });
</script>`;

// Forms sent with requestSubmit(), so no submit event has a submitter.
const FORMS = `<!doctype html>
<script>window.hits = [];</script>
<form id="f-continue"><p>Delete account</p><button>Continue</button></form>
<form id="f-save"><button type="button">Cancel</button> <input type="submit" value="Save"></form>
<form id="f-none"><button type="button">Delete</button></form>
<script>
for (const f of document.forms) f.addEventListener('submit', (e) => { e.preventDefault(); window.hits.push(f.id); });
</script>`;

// Text fields holding verbs. The form's default button is harmless, since Enter in its field
// submits it implicitly and that submit is judged by its submitter.
const TEXT = `<!doctype html>
<script>window.hits = [];</script>
<form id="t-form"><input id="t-input" name="q"> <textarea id="t-area"></textarea> <button id="t-go">Search</button></form>
<input id="t-free">
<script>
document.getElementById('t-form').addEventListener('submit', (e) => {
  e.preventDefault();
  window.hits.push('submit ' + (e.submitter && e.submitter.id));
});
</script>`;

// One of each control kind, every app handler attached by addEventListener so no `[onclick]`
// makes an element the control. Each Delete is labelled on the control, never on the child.
const KINDS = `<!doctype html>
<style>#k-icon { width: 40px; height: 20px; }</style>
<script>window.hits = [];</script>
<button id="k-button" aria-label="Delete"><span>x</span></button>
<a id="k-a" href="#gone" aria-label="Delete"><span>x</span></a>
<div id="k-tabindex" tabindex="0" aria-label="Delete"><span>x</span></div>
<div id="k-role" role="button" aria-label="Delete"><span>x</span></div>
<button id="k-title" title="Delete"><svg width="16" height="16"></svg></button>
<input id="k-value" type="button" value="Delete">
<button id="k-icon" class="icon-trash"></button>
<form id="k-form"><button id="k-cancel" type="submit">Cancel</button> <button type="submit">Save</button></form>
<script>
for (const id of ['k-button', 'k-a', 'k-tabindex', 'k-role', 'k-title', 'k-value', 'k-icon', 'k-cancel']) {
  document.getElementById(id).addEventListener('click', () => window.hits.push(id));
}
document.getElementById('k-form').addEventListener('submit', (e) => {
  e.preventDefault();
  window.hits.push('submit ' + e.submitter.id);
});
</script>`;

// A page that tries to switch the refusal, and its warning, off before anyone clicks.
const NEUTER = `<!doctype html>
<script>
window.hits = [];
Event.prototype.preventDefault = function () {};
Event.prototype.stopImmediatePropagation = function () {};
window.__writeGuardReport = () => {};
console.warn = () => {};
</script>
<button id="drop">Delete</button>
<a id="leave" href="#gone">Delete</a>
<script>
for (const id of ['drop', 'leave']) document.getElementById(id).addEventListener('click', () => window.hits.push(id));
</script>`;

// A form with two submit buttons, a harmless one second.
const SUBMITTERS = `<!doctype html>
<script>window.hits = [];</script>
<form id="s-form"><button id="s-delete" type="submit">Delete</button> <button id="s-keep" type="submit">Keep</button></form>
<script>
document.getElementById('s-form').addEventListener('submit', (e) => {
  e.preventDefault();
  window.hits.push('submit ' + e.submitter.id);
});
</script>`;

// Each form's only submit button is labelled Delete: a plain button, a typed one, and one
// owned through the form attribute from outside the form. Sent with requestSubmit().
const OWNERS = `<!doctype html>
<script>window.hits = [];</script>
<form id="o-plain"><button>Delete</button></form>
<form id="o-typed"><button type="submit">Delete</button></form>
<form id="o-owned"></form><button form="o-owned" type="submit">Delete</button>
<script>
for (const f of document.forms) f.addEventListener('submit', (e) => { e.preventDefault(); window.hits.push(f.id); });
</script>`;

// The aria-label is only whitespace, so the label is the text.
const BLANK = `<!doctype html>
<script>window.hits = [];</script>
<button id="b-blank" aria-label=" ">Delete</button>
<script>document.getElementById('b-blank').addEventListener('click', () => window.hits.push('b-blank'));</script>`;

// One control per page, every app handler attached with addEventListener.
const TRIMMED = `<!doctype html>
<script>window.hits = [];</script>
<button id="tr-delete" aria-label=" Delete ">x</button>
<script>document.getElementById('tr-delete').addEventListener('click', () => window.hits.push('tr-delete'));</script>`;
const NESTED = `<!doctype html>
<script>window.hits = [];</script>
<div id="ne-row" role="button" aria-label="Row"><button id="ne-delete">Delete</button></div>
<script>document.getElementById('ne-delete').addEventListener('click', () => window.hits.push('ne-delete'));</script>`;
const FIRST = `<!doctype html>
<script>window.hits = [];</script>
<form id="fi-form"><button>Delete</button><button>Keep</button></form>
<script>document.getElementById('fi-form').addEventListener('submit', (e) => { e.preventDefault(); window.hits.push('fi-form'); });</script>`;

// Links: a navigating one is judged by its URL, a non-navigating one by its label. The app
// sees a click when its own listener runs; each one stops the navigation itself.
const LINKS = `<!doctype html>
<script>window.hits = [];</script>
<a id="l-out" href="/logout">Log out</a>
<a id="l-quiet" href="/items?action=drop">Open</a>
<a id="l-plain" href="/items/7">Open item</a>
<a id="l-hash" href=" #top">Delete</a>
<a id="l-js" href="javascript:void 0">Delete</a>
<a id="l-tab" href="java&#9;script:void 0">Delete</a>
<a id="l-empty" href="">Delete</a>
<a id="l-go" href="/logout?next=1">Bye</a>
<script>
for (const a of document.querySelectorAll('a')) a.addEventListener('click', (e) => { if (a.id !== 'l-go') e.preventDefault(); window.hits.push(a.id); });
</script>`;

// Navigating links whose text holds a built-in verb, and a [role=link] that keeps the label rule.
const NAV = `<!doctype html>
<script>window.hits = [];</script>
<a id="v-help" href="/help/repositories">Delete a repository</a>
<a id="v-nav" href="/archive">Archive</a>
<a id="v-icon" href="/items/7" class="icon-trash">x</a>
<span id="v-role" role="link">Delete</span>
<script>
for (const id of ['v-help', 'v-nav', 'v-icon', 'v-role']) {
  document.getElementById(id).addEventListener('click', (e) => { e.preventDefault(); window.hits.push(id); });
}
</script>`;

const PAGES = { '/trimmed': TRIMMED, '/nested': NESTED, '/first': FIRST, '/controls': CONTROLS, '/kinds': KINDS, '/neuter': NEUTER, '/real': REAL, '/forms': FORMS, '/text': TEXT,
  '/submitters': SUBMITTERS, '/owners': OWNERS, '/blank': BLANK, '/links': LINKS, '/nav': NAV };

// Real servers on 127.0.0.1, closed after each test. Request clients, route.fetch and Node's
// fetch skip routes, so what they send is read from what such a server received.
const servers = [];
test.afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((done) => s.close(done));
  }
});

// Records each request as `METHOD path` (with its query), its headers and its body; answers
// paths holding /api/ with "ok", a path in `pages` with its page, and anything else with a small page.
async function listen(pages = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ line: `${req.method} ${req.url}`, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const api = req.url.includes('/api/');
      res.writeHead(200, { 'content-type': api ? 'text/plain' : 'text/html' }).end(api ? 'ok' : pages[req.url] ?? '<!doctype html><p>Ok</p>');
    });
  });
  servers.push(server);
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, lines: () => seen.map((s) => s.line) };
}

// A WebSocket echo server on 127.0.0.1 that also serves a page, so a page from its own origin
// can open a socket to it. It records each text frame it receives and echoes it back.
async function listenEcho() {
  const frames = [];
  const sockets = [];
  const server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><p>Socket</p>'));
  server.on('upgrade', (req, socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // Short masked frames only (under 126 bytes), several per chunk.
    socket.on('data', (d) => {
      for (let at = 0; at + 6 <= d.length;) {
        const opcode = d[at] & 0x0f;
        const length = d[at + 1] & 0x7f;
        const mask = d.subarray(at + 2, at + 6);
        const payload = Buffer.from(d.subarray(at + 6, at + 6 + length).map((byte, i) => byte ^ mask[i % 4]));
        at += 6 + length;
        if (opcode === 1) {
          frames.push(payload.toString('utf8'));
          socket.write(Buffer.concat([Buffer.from([0x81, length]), payload]));
        } else if (opcode === 2) frames.push(`binary ${payload.length}`);
      }
    });
  });
  servers.push({ closeAllConnections: () => { for (const s of sockets) s.destroy(); server.closeAllConnections(); }, close: (done) => server.close(done) });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return { host: `127.0.0.1:${server.address().port}`, frames };
}

// The fake server. Registered before `install`, so it is not the caller's to remove, and it
// records every request that reaches it. PAGES maps a path to its page, any other path is HOME.
async function serve(context) {
  const seen = [];
  await context.route(`${APP}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    seen.push(`${req.method()} ${url.pathname}`);
    if (url.pathname.startsWith('/api/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: SERVED });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: PAGES[url.pathname] ?? HOME });
  });
  return { seen, writes: () => seen.filter((s) => !s.startsWith('GET ')) };
}

async function open(context) {
  const page = await context.newPage();
  await page.goto(`${APP}/`);
  return page;
}

const send = (page, method) => page.evaluate((m) => fetch('/api/items', { method: m, body: m === 'GET' ? undefined : '{}' })
  .then((r) => r.text(), () => 'network error'), method);
const hits = (page) => page.evaluate(() => window.hits);
const write = (action, method, extra = {}) => ({ kind: 'request', action, reason: expect.any(String), method, url: `${APP}/api/items`, headerNames: expect.any(Array), ...extra, at: expect.any(String) });
// A request-client or Node fetch event.
const sent = (action, method, url, via, extra = {}) => ({ kind: 'request', action, reason: expect.any(String), method, url, via, headerNames: [], ...extra, at: expect.any(String) });
const refusal = (method, url, via = 'APIRequestContext') => `write-guard: ${method} ${url} through ${via} is refused under read-only`;
// What fetch sends as the content type of a string body.
const TEXT_TYPE = 'text/plain;charset=UTF-8';
const control = (label) => ({ kind: 'control', action: 'block', reason: expect.any(String), label, at: expect.any(String) });
const post = (page, path, body) => page.evaluate(([p, b]) => fetch(p, { method: 'POST', body: b })
  .then((r) => r.text(), () => 'network error'), [path, body]);

async function visit(context, path) {
  const page = await context.newPage();
  await page.goto(`${APP}${path}`);
  return page;
}

// Sets (or, given undefined, unsets) the named variables for the length of fn.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (all) => {
    for (const [k, v] of Object.entries(all)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  try { set(vars); return await fn(); } finally { set(saved); }
}

// The outcome of one send: the response text, or the rejection's message.
const outcome = (p) => p.then((r) => r.text(), (e) => e.message);

test('blocks a write, records it, and lets reads through', async ({ context }) => {
  const server = await serve(context);
  const guard = await install(context, { log: null });
  const page = await open(context);

  expect(await send(page, 'GET')).toBe(SERVED);
  expect(await send(page, 'POST')).toBe('network error');
  expect(await send(page, 'DELETE')).toBe('network error');
  expect(server.writes()).toEqual([]);

  const record = guard.record();
  expect(record).toMatchObject({ installed: true, policy: 'read-only', blocked: 2, observed: 0 });
  expect(record.routed_requests).toBeGreaterThanOrEqual(4);
  expect(record.events).toEqual([
    { kind: 'request', action: 'block', reason: expect.any(String), method: 'POST', url: `${APP}/api/items`, contentType: TEXT_TYPE, headerNames: expect.arrayContaining(['content-type']), at: expect.any(String) },
    { kind: 'request', action: 'block', reason: expect.any(String), method: 'DELETE', url: `${APP}/api/items`, contentType: TEXT_TYPE, headerNames: expect.arrayContaining(['content-type']), at: expect.any(String) },
  ]);
  expect(new Date(record.events[0].at).toISOString()).toBe(record.events[0].at);
});

test('a blocked navigation shows the 403 page', async ({ context }) => {
  const server = await serve(context);
  await install(context, { log: null });
  const page = await open(context);

  const response = page.waitForResponse(`${APP}/api/items`);
  await page.click('#go');
  const res = await response;
  expect(res.status()).toBe(403);
  expect(res.headers()['content-type']).toBe('text/html; charset=utf-8');
  await expect(page.locator('body')).toHaveText(`write-guard blocked POST ${APP}/api/items`);
  expect(server.writes()).toEqual([]);
});

test('a later route with continue() cannot let a blocked request past', async ({ context, page }) => {
  const server = await serve(context);
  const guard = await install(context, { log: null });
  await page.goto(`${APP}/`);
  let calls = 0;
  // Present page (the fixture's) and context alike; page handlers run first. The page
  // handler receives the write, and its continue() is the egress that refuses it.
  await context.route('**/api/items', (route) => { calls++; return route.continue(); });
  await page.route('**/api/items', (route) => { calls++; return route.continue(); });

  expect(await send(page, 'POST')).toBe('network error');
  expect(calls).toBe(1);
  expect(server.writes()).toEqual([]);
  expect(guard.record().blocked).toBe(1);
});

test('a read rewritten into a write by continue() is blocked and recorded', async ({ context }) => {
  const server = await serve(context);
  const guard = await install(context, { log: null });
  const page = await open(context);
  const routed = guard.record().routed_requests;

  await context.route('**/api/items', (route) => route.continue({ method: 'DELETE' }));
  expect(await send(page, 'GET')).toBe('network error');
  await context.unrouteAll();
  await page.route('**/api/items', (route) => route.continue({ method: 'delete' }));
  expect(await send(page, 'GET')).toBe('network error');

  expect(server.writes()).toEqual([]);
  const record = guard.record();
  expect(record.events).toEqual([write('block', 'DELETE'), write('block', 'DELETE')]);
  expect(record.blocked).toBe(2);
  // Each GET is judged once; the overrides are not counted.
  expect(record.routed_requests).toBe(routed + 2);
});

test('a read rewritten into a write by fallback() is blocked and recorded', async ({ context }) => {
  const server = await serve(context);
  const guard = await install(context, { log: null, writes: [{ method: 'GET', url: '/api/items$', body: 'drop' }] });
  const page = await open(context);

  await context.route('**/api/items', (route) => route.fallback({ method: 'POST' }));
  expect(await send(page, 'GET')).toBe('network error');
  await context.unrouteAll();
  // A Buffer body is read as UTF-8, an object as its JSON.
  let override;
  await page.route('**/api/items', (route) => route.fallback(override));
  for (override of [{ method: 'POST' }, { postData: Buffer.from('drop it') }, { postData: { op: 'drop' } }]) {
    expect(await send(page, 'GET')).toBe('network error');
  }

  expect(server.writes()).toEqual([]);
  expect(server.seen.filter((s) => s === 'GET /api/items')).toEqual([]);
  expect(guard.record().events).toEqual([write('block', 'POST'), write('block', 'POST'), write('block', 'GET'), write('block', 'GET')]);
});

test('route.fetch of a write is refused under read-only', async ({ context }) => {
  const server = await serve(context);
  const guard = await install(context, { log: null });
  const page = await open(context);
  let message;
  await page.route('**/api/items', async (route) => {
    message = await route.fetch({ method: 'POST', postData: '{}' }).then(() => 'fetched', (e) => e.message);
    return route.fulfill({ body: 'mocked' });
  });

  expect(await send(page, 'GET')).toBe('mocked');
  expect(message).toBe(`write-guard: route.fetch of POST ${APP}/api/items is refused under read-only`);
  expect(server.writes()).toEqual([]);
  expect(guard.record().events).toEqual([write('block', 'POST')]);
});

test('a refused route.fetch of a document rejects', async ({ context }) => {
  const server = await serve(context);
  await install(context, { log: null });
  const page = await open(context);
  let message;
  await page.route('**/api/items', async (route) => {
    message = await route.fetch().then(() => 'fetched', (e) => e.message);
    return route.abort();
  });

  await page.click('#go');
  await expect.poll(() => message).toBe(`write-guard: route.fetch of POST ${APP}/api/items is refused under read-only`);
  expect(server.writes()).toEqual([]);
});

test('an allowed route.fetch returns the response', async ({ context }) => {
  // route.fetch skips routes, so the page and the API come from a server of its own on 127.0.0.1.
  const server = createServer((req, res) => {
    const body = req.url === '/data' ? 'from the server' : '<!doctype html><p>Ok</p>';
    res.writeHead(200, { 'content-type': req.url === '/data' ? 'text/plain' : 'text/html' }).end(body);
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const guard = await install(context, { log: null });
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    let status;
    await page.route('**/data', async (route) => {
      const res = await route.fetch();
      status = res.status();
      return route.fulfill({ response: res });
    });

    expect(await page.evaluate(() => fetch('/data').then((r) => r.text()))).toBe('from the server');
    expect(status).toBe(200);
    expect(guard.record().blocked).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test('under observe an override goes through and is recorded once', async ({ context }) => {
  const server = await serve(context);
  const guard = await install(context, { policy: 'observe', log: null });
  const page = await open(context);
  const routed = guard.record().routed_requests;
  await page.route('**/api/items', (route) => route.fallback({ method: 'POST' }));

  expect(await send(page, 'GET')).toBe(SERVED);
  expect(server.writes()).toEqual(['POST /api/items']);
  expect(guard.record()).toMatchObject({ blocked: 0, observed: 1, routed_requests: routed + 1, events: [write('observe', 'POST')] });
});

test('unroute(url, handler) removes that handler and keeps the others', async ({ context }) => {
  await serve(context);
  await install(context, { log: null });
  const page = await open(context);
  const seen = [];
  const keep = (route) => { seen.push('keep'); return route.fallback(); };
  const drop = (route) => { seen.push('drop'); return route.fallback(); };
  for (const target of [context, page]) {
    await target.route('**/api/items', keep);
    await target.route('**/api/items', drop);
  }
  expect(await send(page, 'GET')).toBe(SERVED);
  expect(seen).toEqual(['drop', 'keep', 'drop', 'keep']);

  seen.length = 0;
  await context.unroute('**/api/items', drop);
  await page.unroute('**/api/items', drop);
  expect(await send(page, 'GET')).toBe(SERVED);
  expect(seen).toEqual(['keep', 'keep']);
});

test('unrouteAll and unroute remove only the caller\'s own handlers', async ({ context }) => {
  const server = await serve(context);
  const guard = await install(context, { log: null });
  const page = await open(context);

  const handler = (route) => route.fulfill({ body: 'one' });
  await context.route('**/api/items', handler);
  expect(await send(page, 'GET')).toBe('one');
  await context.unroute('**/api/items', handler);

  const disposable = await context.route('**/api/items', (route) => route.fulfill({ body: 'two' }));
  expect(await send(page, 'GET')).toBe('two');
  await disposable.dispose();

  await context.route('**/api/items', (route) => route.fulfill({ body: 'context mock' }));
  await page.route('**/api/items', (route) => route.fallback());
  const before = guard.record().routed_requests;
  expect(await send(page, 'GET')).toBe('context mock');
  // Fulfilled before it reached an egress, so never judged or counted.
  expect(guard.record().routed_requests).toBe(before);

  await page.unrouteAll();
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  expect(await send(page, 'GET')).toBe(SERVED);
  expect(await send(page, 'POST')).toBe('network error');
  expect(server.writes()).toEqual([]);
});

test('destructive controls are refused before the app sees them', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null, controls: { icons: ['icon-trash'] } });
  const page = await open(context);

  await page.click('#del');
  await page.click('#trash');
  await page.focus('#del');
  await page.keyboard.press('Enter');
  await page.click('#view');
  expect(await hits(page)).toEqual(['view']);

  await expect.poll(() => guard.record().blocked).toBe(3);
  expect(guard.record().events).toEqual([
    { kind: 'control', action: 'block', reason: expect.any(String), label: 'Delete item', at: expect.any(String) },
    { kind: 'control', action: 'block', reason: expect.stringContaining('icon-trash'), label: '', at: expect.any(String) },
    { kind: 'control', action: 'block', reason: expect.any(String), label: 'Delete item', at: expect.any(String) },
  ]);
});

test('native dialogs are dismissed under read-only', async ({ context }) => {
  await serve(context);
  await install(context, { log: null });
  const page = await open(context);
  expect(await page.evaluate(() => confirm('Delete everything?'))).toBe(false);
});

test('a submit with no submitter is judged by the form\'s submit button', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await visit(context, '/forms');

  // The form's own text and its plain buttons do not count: only its first submit button
  // does, and a form with none is not judged.
  await page.evaluate(() => { for (const f of document.forms) f.requestSubmit(); });
  expect(await hits(page)).toEqual(['f-continue', 'f-none']);
  await expect.poll(() => guard.record().blocked).toBe(1);
  expect(guard.record().events).toEqual([control('Save')]);
});

test('Space and Enter are judged only on a control', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await context.newPage();
  await page.goto(`${APP}/controls`);

  // No click handler anywhere, and a div has no click activation on either key: only the
  // keydown listener stands between the key and the app. A tabindex div labelled Delete is
  // not a control, so it is not judged in the page; a role=button one is.
  for (const key of ['Space', 'Enter']) {
    for (const id of ['remove', 'drop', 'open']) {
      await page.focus(`#${id}`);
      await page.keyboard.press(key);
    }
  }
  expect(await hits(page)).toEqual(['remove Space', 'open Space', 'remove Enter', 'open Enter']);
  await expect.poll(() => guard.record().blocked).toBe(2);
  expect(guard.record().events).toEqual([control('Delete'), control('Delete')]);
});

test('an icon button is judged by its aria-label', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await context.newPage();
  await page.goto(`${APP}/controls`);

  // The click lands on the inner span, whose own text is "x": the label is the button's.
  await page.click('#icon');
  await page.click('#glyph');
  expect(await hits(page)).toEqual(['open item']);
  await expect.poll(() => guard.record().blocked).toBe(1);
  expect(guard.record().events).toEqual([control('Delete item')]);
});

test('dialogs are dismissed even when the caller accepts them',async ({ context }) => {
  await serve(context);
  await install(context, { log: null });
  const page = await open(context);
  // The context's dialog event is emitted before the page's; both callers lose.
  context.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  expect(await page.evaluate(() => confirm('Delete everything?'))).toBe(false);
});

test('a URL rewritten by continue() or fallback() is judged as the new URL', async ({ context }) => {
  const server = await serve(context);
  const guard = await install(context, { log: null, writes: [{ method: 'GET', url: '/api/danger$' }] });
  const page = await open(context);
  const danger = `${APP}/api/danger`;

  await page.route('**/api/items', (route) => route.continue({ url: danger }));
  expect(await send(page, 'GET')).toBe('network error');
  await page.unrouteAll();
  await page.route('**/api/items', (route) => route.fallback({ url: danger }));
  expect(await send(page, 'GET')).toBe('network error');

  expect(server.seen.filter((s) => s.includes('/api/'))).toEqual([]);
  const blocked = { kind: 'request', action: 'block', reason: expect.any(String), method: 'GET', url: danger, headerNames: expect.any(Array), at: expect.any(String) };
  expect(guard.record().events).toEqual([blocked, blocked]);
});

test('install judges the request client of a page that already exists', async ({ context, page }) => {
  const server = await listen();
  const guard = await install(context, { log: null });
  const url = `${server.origin}/api/items`;
  expect(await outcome(page.request.post(url))).toBe(refusal('POST', url));
  expect(await outcome(page.request.get(url))).toBe('ok');
  expect(server.lines()).toEqual(['GET /api/items']);
  expect(guard.record().events).toEqual([sent('block', 'POST', url, 'request-client')]);
});

test('the 403 page HTML-escapes the URL', async ({ context }) => {
  await serve(context);
  await install(context, { log: null, writes: [{ method: 'GET', url: '/api/' }] });
  const page = await context.newPage();

  const res = await page.goto(`${APP}/api/it's<b>?a=1&b=2`);
  expect(res.status()).toBe(403);
  const url = res.url();
  expect(url).toContain("it's");
  expect(url).toContain('&b=2');
  const html = await res.text();
  expect(html).toContain('it&#39;s');
  expect(html).toContain('a=1&#38;b=2');
  expect(html).not.toContain("it's");
  expect(html).not.toContain('<b>');
  await expect(page.locator('body')).toHaveText(`write-guard blocked GET ${url}`);
});

test('observe records writes and controls without blocking them', async ({ context }) => {
  const server = await serve(context);
  const guard = await install(context, { policy: 'observe', log: null });
  const page = await open(context);

  expect(await send(page, 'POST')).toBe(SERVED);
  await page.click('#del');
  expect(await hits(page)).toEqual(['del']);
  expect(server.writes()).toEqual(['POST /api/items']);
  expect(await page.evaluate(() => typeof confirm)).toBe('function');

  await expect.poll(() => guard.record().observed).toBe(2);
  const record = guard.record();
  expect(record).toMatchObject({ policy: 'observe', blocked: 0 });
  expect(record.events.map((e) => [e.kind, e.action])).toEqual([['request', 'observe'], ['control', 'observe']]);
});

test('every event is appended to the JSONL log', async ({ context }, testInfo) => {
  const log = testInfo.outputPath('write-guard.jsonl');
  writeFileSync(log, '{"earlier":true}\n');
  await serve(context);
  const guard = await install(context, { log });
  const page = await open(context);

  await send(page, 'PUT');
  await page.click('#del');
  await expect.poll(() => guard.record().blocked).toBe(2);
  const final = await guard.close();

  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines).toEqual([{ earlier: true }, ...final.events]);
  expect(lines.slice(1).map((e) => e.kind)).toEqual(['request', 'control']);
});

test('websockets: "block" refuses a socket under either policy', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { policy: 'observe', websockets: 'block', log: null });
  const page = await open(context);
  const routed = guard.record().routed_requests;

  const closed = await page.evaluate(() => new Promise((resolve) => {
    const ws = new WebSocket('ws://app.test/socket');
    ws.onclose = (e) => resolve(e.code);
  }));
  expect(closed).toBe(1008);
  await expect.poll(() => guard.record().blocked).toBe(1);
  const [event] = guard.record().events;
  expect(event).toEqual({ kind: 'request', action: 'block', reason: expect.any(String), url: 'ws://app.test/socket', at: expect.any(String) });
  expect(guard.record().routed_requests).toBe(routed);
});

test('a second install returns the same handle', async ({ context }) => {
  const first = await install(context, { log: null });
  const second = await install(context, { policy: 'observe', log: null });
  expect(second).toBe(first);
  expect(second.record().policy).toBe('read-only');
});

test('a request client GET goes through and its write is judged', async ({ context }) => {
  const server = await listen();
  const guard = await install(context, { log: null });
  const page = await context.newPage();
  const url = `${server.origin}/api/items`;

  // A page's client is its context's, one wrapper, so one send is one event.
  expect(page.request).toBe(context.request);
  expect(await outcome(context.request.get(url))).toBe('ok');
  expect(await outcome(page.request.post(url, { data: '{}' }))).toBe(refusal('POST', url));
  expect(await outcome(page.request.fetch(url, { method: 'delete' }))).toBe(refusal('DELETE', url));
  expect(server.lines()).toEqual(['GET /api/items']);

  const record = guard.record();
  expect(record).toMatchObject({ blocked: 2, observed: 0, mocked: 0, suspect: 0, routed_requests: 0 });
  expect(record.events).toEqual([sent('block', 'POST', url, 'request-client'), sent('block', 'DELETE', url, 'request-client')]);
  // Everything that is not a send reads through to the raw client.
  expect(typeof (await context.request.storageState()).cookies).toBe('object');
});

test('every send method is judged under read-only', async ({ context, page }) => {
  const server = await listen();
  const guard = await install(context, { log: null });
  const url = `${server.origin}/api/items`;
  for (const client of [context.request, page.request]) {
    for (const method of ['get', 'head']) expect(await outcome(client[method](url))).toBe(method === 'get' ? 'ok' : '');
    expect(await outcome(client.fetch(url))).toBe('ok');
    for (const method of ['post', 'put', 'patch', 'delete']) {
      expect(await outcome(client[method](url))).toBe(refusal(method.toUpperCase(), url));
    }
    expect(await outcome(client.fetch(url, { method: 'POST' }))).toBe(refusal('POST', url));
  }
  // Each send was judged once: the named methods call the raw client's fetch, not the wrapper's.
  expect(server.lines()).toEqual(Array(2).fill(['GET /api/items', 'HEAD /api/items', 'GET /api/items']).flat());
  expect(guard.record().blocked).toBe(10);
  expect(guard.record().events).toHaveLength(10);
});

test('a relative request client URL is judged after baseURL and params', async ({ browser, playwright }) => {
  const server = await listen();
  const base = `${server.origin}/app/`;
  const context = await browser.newContext({ baseURL: base });
  try {
    // The installer reads the private option Playwright keeps the context's baseURL in.
    expect(context._options.baseURL).toBe(base);
    const config = { log: null, writes: [{ method: 'GET', url: '^http://127[.]0[.]0[.]1:[0-9]+/app/api/do[?]x=1$' }, { method: 'GET', url: '^api/raw$' }] };
    const guard = await install(context, config);
    const target = `${server.origin}/app/api/do?x=1`;

    // Each of these sends GET /app/api/do?x=1, the anchored writes signature.
    const sends = [
      () => context.request.get('api/do', { params: { x: 1, y: undefined } }),
      () => context.request.get('api/do#frag', { params: { x: '1' } }),
      () => context.request.get('api/do?y=2', { params: 'x=1' }),
      () => context.request.get('api/do?x=1', { params: '' }),
      () => context.request.get('api/do?x=1', { params: new URLSearchParams() }),
      () => context.request.get('api/do?x=1', { params: 7 }),
      () => context.request.fetch('/app/api/do?x=1#top'),
    ];
    for (const s of sends) expect(await outcome(s())).toBe(refusal('GET', target));
    expect(server.lines()).toEqual([]);
    expect(guard.record().events).toEqual(Array(sends.length).fill(sent('block', 'GET', target, 'request-client')));

    // A harmless relative URL is resolved the same way and sent.
    expect(await outcome(context.request.get('api/ok', { params: { x: 1 } }))).toBe('ok');
    expect(server.lines()).toEqual(['GET /app/api/ok?x=1']);

    // guardRequestClient on a client of its own takes the baseURL it is given.
    const own = await playwright.request.newContext();
    try {
      const wrapped = guard.guardRequestClient(own, { baseURL: base });
      expect(await outcome(wrapped.get('api/do', { params: { x: 1 } }))).toBe(refusal('GET', target));
      // An invalid baseURL: the URL is parsed alone, and params still apply.
      const invalid = guard.guardRequestClient(own, { baseURL: 'not a url' });
      expect(await outcome(invalid.get(`${server.origin}/app/api/do`, { params: { x: 1 } }))).toBe(refusal('GET', target));
      // Without one, a relative URL is judged as the raw string.
      const bare = guard.guardRequestClient(own);
      expect(await outcome(bare.get('api/raw'))).toBe(refusal('GET', 'api/raw'));
      expect(guard.record().events.slice(-3)).toEqual([...Array(2).fill(sent('block', 'GET', target, 'request-client')), sent('block', 'GET', 'api/raw', 'request-client')]);
    } finally {
      await own.dispose();
    }
    expect(server.lines()).toEqual(['GET /app/api/ok?x=1']);
  } finally {
    await context.close();
  }
});

test('a captured request in the options is judged as Playwright merges it', async ({ context }) => {
  const server = await listen();
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await open(context);
  // A DELETE the page sent, captured: Playwright sends its method when the options carry it.
  const captured = page.waitForRequest((r) => r.method() === 'DELETE');
  await send(page, 'DELETE');
  const del = await captured;
  const harmless = `${server.origin}/api/harmless`;
  const other = `${server.origin}/api/other`;

  expect(await outcome(context.request.fetch(harmless, { request: del }))).toBe(refusal('DELETE', harmless));
  expect(await outcome(context.request.fetch(del, { url: harmless }))).toBe(refusal('DELETE', harmless));
  // options.url replaces the first argument.
  expect(await outcome(context.request.post(harmless, { url: other }))).toBe(refusal('POST', other));
  expect(await outcome(context.request.get(harmless, { url: other }))).toBe('ok');

  // The same merge at a caller's route.fetch.
  let message;
  await page.route('**/api/items', async (route) => {
    message = await route.fetch({ url: harmless, request: del }).then(() => 'fetched', (e) => e.message);
    return route.fulfill({ body: 'mocked' });
  });
  expect(await send(page, 'GET')).toBe('mocked');
  expect(message).toBe(`write-guard: route.fetch of DELETE ${harmless} is refused under read-only`);

  // Only the harmless GET reached the server.
  expect(server.lines()).toEqual(['GET /api/other']);
  expect(guard.record().events.map((e) => [e.action, e.method, e.url, e.via])).toEqual([
    ['block', 'DELETE', `${APP}/api/items`, undefined],
    ['block', 'DELETE', harmless, 'request-client'],
    ['block', 'DELETE', harmless, 'request-client'],
    ['block', 'POST', other, 'request-client'],
    ['block', 'DELETE', harmless, undefined],
  ]);
});

test('a request client body is judged as Playwright sends it', async ({ context }) => {
  const server = await listen();
  const url = `${server.origin}/api/q`;
  const guard = await install(context, { log: null, logBodies: true, allow: [{ method: 'POST', url: '/api/q$', body: '^"?query' }] });
  const read = () => server.seen.map((s) => s.body);

  // A String object is sent as its valueOf(), whatever its toString() says.
  const tricky = new String('mutation');
  tricky.toString = () => 'query';
  expect(await outcome(context.request.post(url, { data: tricky }))).toBe(refusal('POST', url));
  expect(await outcome(context.request.post(url, { data: new String('query') }))).toBe('ok');
  // A string that does not parse as JSON under exactly application/json is sent as its JSON.
  expect(await outcome(context.request.post(url, { data: 'query', headers: { 'Content-Type': 'application/json' } }))).toBe('ok');
  // A Buffer as UTF-8, an object as its JSON.
  expect(await outcome(context.request.post(url, { data: Buffer.from('query') }))).toBe('ok');
  expect(await outcome(context.request.post(url, { data: { q: 'query' } }))).toBe(refusal('POST', url));
  // The re-encoding check reads the first content-type entry; the event carries the last.
  for (const types of [['application/json', 'text/plain'], ['text/plain', 'application/json']]) {
    const headers = { 'Content-Type': types[0], 'content-type': types[1] };
    expect(await outcome(context.request.post(url, { data: 'mutation', headers }))).toBe(refusal('POST', url));
  }
  expect(read()).toEqual(['query', '"query"', 'query']);
  const typed = (body, contentType) => sent('block', 'POST', url, 'request-client', { body, contentType, headerNames: ['content-type'] });
  expect(guard.record().events).toEqual([
    sent('block', 'POST', url, 'request-client', { body: 'mutation' }),
    sent('block', 'POST', url, 'request-client', { body: '{"q":"query"}' }),
    typed('"mutation"', 'text/plain'),
    typed('mutation', 'application/json'),
  ]);

  // A String object as the first argument is judged, then refused by Playwright itself.
  expect(await outcome(context.request.get(new String(url)))).toContain('First argument must be either URL string or Request');
  expect(await outcome(context.request.post(new String(url)))).toBe(refusal('POST', url));
  expect(read()).toHaveLength(3);
});

test('Node fetch is judged through guardFetch', async ({ context }) => {
  const server = await listen();
  const guard = await install(context, { log: null });
  const guarded = guard.guardFetch(fetch);
  const url = `${server.origin}/api/items`;
  const go = (input, init) => guarded(input, init).then((r) => r.text(), (e) => e.message);

  expect(await go(url)).toBe('ok');
  expect(await go(new URL(`${url}#top`), { method: 'post', body: 'x', headers: [['X-A', '1'], ['x-a', '2']] })).toBe(refusal('POST', url, 'fetch'));
  expect(await go(new Request(url, { method: 'DELETE', headers: { 'X-B': '1' } }))).toBe(refusal('DELETE', url, 'fetch'));
  expect(server.lines()).toEqual(['GET /api/items']);
  expect(guard.record().events).toEqual([
    sent('block', 'POST', url, 'node-fetch', { headerNames: ['x-a'] }),
    sent('block', 'DELETE', url, 'node-fetch', { headerNames: ['x-b'] }),
  ]);
  expect(guard.record().routed_requests).toBe(0);
});

test('a context another process guards is refused, and nothing is installed', async ({ context }) => {
  await context.exposeBinding('__writeGuardReport', () => {});
  const server = await serve(context);
  await expect(install(context, { log: null })).rejects
    .toThrow('write-guard: this context is already guarded by another process; use one mode, not both');

  const page = await open(context);
  expect(await send(page, 'POST')).toBe(SERVED);
  await page.click('#del');
  expect(await hits(page)).toEqual(['del']);
  expect(server.writes()).toEqual(['POST /api/items']);
});

test('a malformed config throws before anything is installed', async ({ context }) => {
  const server = await serve(context);
  await expect(install(context, { policy: 'everything' })).rejects.toThrow(/^write-guard: policy: /);
  const page = await open(context);
  expect(await send(page, 'POST')).toBe(SERVED);
  expect(server.writes()).toEqual(['POST /api/items']);
});

test('loadConfig reads a path, then WRITE_GUARD_CONFIG, and honours WRITE_GUARD_POLICY', async ({}, testInfo) => {
  const a = testInfo.outputPath('a.json');
  const b = testInfo.outputPath('b.json');
  writeFileSync(a, JSON.stringify({ websockets: 'block' }));
  writeFileSync(b, JSON.stringify({ log: null }));
  const saved = { c: process.env.WRITE_GUARD_CONFIG, p: process.env.WRITE_GUARD_POLICY };
  try {
    delete process.env.WRITE_GUARD_POLICY;
    process.env.WRITE_GUARD_CONFIG = b;
    expect(loadConfig()).toEqual({ log: null });
    expect(loadConfig(a)).toEqual({ websockets: 'block' });
    process.env.WRITE_GUARD_POLICY = 'observe';
    expect(loadConfig(a)).toEqual({ websockets: 'block', policy: 'observe' });
    process.env.WRITE_GUARD_POLICY = 'anything';
    expect(() => loadConfig(a)).toThrow(/^write-guard: policy: /);
    delete process.env.WRITE_GUARD_POLICY;
    expect(() => loadConfig(testInfo.outputPath('missing.json'))).toThrow(/^write-guard: /);
    writeFileSync(a, '{ not json');
    expect(() => loadConfig(a)).toThrow(/^write-guard: /);
  } finally {
    for (const [k, v] of [['WRITE_GUARD_CONFIG', saved.c], ['WRITE_GUARD_POLICY', saved.p]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('each control kind is judged', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null, controls: { icons: ['icon-trash'] } });
  const page = await visit(context, '/kinds');

  // Each click lands on a child or on a control whose label comes from one source only.
  const cases = [
    ['#k-button span', 'Delete'],
    ['#k-a span', 'Delete'],
    ['#k-role span', 'Delete'],
    ['#k-title svg', 'Delete'],
    ['#k-value', 'Delete'],
    ['#k-icon', ''],
  ];
  for (const [i, [selector, label]] of cases.entries()) {
    await page.click(selector);
    await expect.poll(() => guard.record().blocked, { message: selector }).toBe(i + 1);
    expect(await hits(page), selector).toEqual([]);
    expect(guard.record().events[i], selector).toEqual(control(label));
  }
  expect(await page.evaluate(() => location.hash)).toBe('');

  // A tabindex div labelled Delete is not a control, so it is not judged in the page.
  await page.click('#k-tabindex span');
  expect(await hits(page)).toEqual(['k-tabindex']);

  // The submitter is judged, not the form, whose text also holds "Save".
  await page.click('#k-cancel');
  expect(await hits(page)).toEqual(['k-tabindex', 'k-cancel', 'submit k-cancel']);
  expect(guard.record().blocked).toBe(cases.length);
});

test('a page cannot neuter the refusal', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await visit(context, '/neuter');

  await page.click('#drop');
  await page.click('#leave');
  expect(await hits(page)).toEqual([]);
  expect(await page.evaluate(() => location.hash)).toBe('');
  await expect.poll(() => guard.record().blocked).toBe(2);
  expect(guard.record().events).toEqual([control('Delete'), control('Delete')]);
});

test('a synthetic click is judged', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await visit(context, '/kinds');

  await page.evaluate(() => document.getElementById('k-button').click());
  expect(await hits(page)).toEqual([]);
  await expect.poll(() => guard.record().blocked).toBe(1);
  expect(guard.record().events).toEqual([control('Delete')]);
});

test('a body signature is applied', async ({ context }) => {
  const server = await serve(context);
  await install(context, { log: null, allow: [{ method: 'POST', url: '/api/query$', body: 'kind.*read' }] });
  const page = await open(context);

  expect(await post(page, '/api/query', '{"kind":"read"}')).toBe(SERVED);
  expect(await post(page, '/api/query', '{"kind":"write"}')).toBe('network error');
  expect(server.writes()).toEqual(['POST /api/query']);
});

test('an override with no options is recorded once under observe', async ({ context }) => {
  const server = await serve(context);
  const guard = await install(context, { policy: 'observe', log: null });
  const page = await open(context);
  // fallback() is not an egress: the request goes on to the catch-all, the one egress it
  // reaches, is recorded there once and reaches the fake server, where continue() would
  // leave for the network.
  await page.route('**/api/items', (route) => route.fallback());

  expect(await send(page, 'POST')).toBe(SERVED);
  expect(server.writes()).toEqual(['POST /api/items']);
  expect(guard.record().events).toEqual([write('observe', 'POST', { contentType: TEXT_TYPE })]);
});

test('a refused override aborts with blockedbyclient', async ({ context }) => {
  const server = await serve(context);
  await install(context, { log: null });
  const page = await open(context);
  await page.route('**/api/items', (route) => route.continue({ method: 'DELETE' }));

  const failed = page.waitForEvent('requestfailed');
  expect(await send(page, 'GET')).toBe('network error');
  // Chromium reports a route abort as net::ERR_BLOCKED_BY_CLIENT.Inspector.
  expect((await failed).failure().errorText).toMatch(/^net::ERR_BLOCKED_BY_CLIENT\b/);
  expect(server.writes()).toEqual([]);
});

test('observe records request client writes and does not dismiss dialogs', async ({ context, page }) => {
  await serve(context);
  const server = await listen();
  const guard = await install(context, { policy: 'observe', log: null });
  const later = await open(context);
  const url = `${server.origin}/api/items`;

  // `page` existed before install, `later` was opened after it.
  for (const client of [context.request, page.request, later.request]) {
    expect(await outcome(client.post(url, { data: 'x', headers: { 'Content-Type': 'text/plain' } }))).toBe('ok');
  }
  expect(server.lines()).toEqual(Array(3).fill('POST /api/items'));
  expect(guard.record()).toMatchObject({ blocked: 0, observed: 3 });
  expect(guard.record().events).toEqual(Array(3).fill(sent('observe', 'POST', url, 'request-client', { contentType: 'text/plain', headerNames: ['content-type'] })));
  later.on('dialog', (d) => d.accept());
  expect(await later.evaluate(() => confirm('Delete everything?'))).toBe(true);
});

test('unroute matches an equal RegExp and route\'s disposable', async ({ context }) => {
  await serve(context);
  await install(context, { log: null });
  const page = await open(context);
  const seen = [];
  const h = (route) => { seen.push('h'); return route.fallback(); };
  const h2 = (route) => { seen.push('h2'); return route.fallback(); };
  await context.route(/\/api\/items$/, h);
  const disposable = await page.route('**/api/items', h2);
  expect(await send(page, 'GET')).toBe(SERVED);
  expect(seen).toEqual(['h2', 'h']);

  seen.length = 0;
  await context.unroute(/\/api\/items$/, h);
  await disposable.dispose();
  expect(await send(page, 'GET')).toBe(SERVED);
  expect(seen).toEqual([]);
});

test('the default config file is found', async ({}, testInfo) => {
  const dir = testInfo.outputPath('cwd');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'write-guard.config.json'), '{ "policy": "observe" }');
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    await withEnv({ WRITE_GUARD_CONFIG: undefined, WRITE_GUARD_POLICY: undefined }, () => {
      expect(loadConfig()).toEqual({ policy: 'observe' });
    });
  } finally {
    process.chdir(cwd);
  }
});

test('an empty WRITE_GUARD_POLICY is ignored', async ({}, testInfo) => {
  const file = testInfo.outputPath('observe.json');
  writeFileSync(file, '{ "policy": "observe" }');
  await withEnv({ WRITE_GUARD_POLICY: '' }, () => {
    expect(loadConfig(file).policy).toBe('observe');
  });
});

test('a mocked write is recorded as mocked', async ({ context, browser }) => {
  const server = await serve(context);
  const guard = await install(context, { log: null, logBodies: true });
  const page = await open(context);
  const routed = guard.record().routed_requests;

  // A caller can still mock a write; it is recorded as the handler received it.
  await page.route('**/api/items', (route) => route.fulfill({ status: 201, body: 'mocked' }));
  expect(await send(page, 'POST')).toBe('mocked');
  expect(await send(page, 'GET')).toBe('mocked');
  await page.unrouteAll();
  await context.route('**/api/items', (route) => route.abort('failed'));
  expect(await send(page, 'DELETE')).toBe('network error');
  // An earlier fallback override is what the mocking handler received.
  await page.route('**/api/items', (route) => route.fallback({ method: 'PUT', postData: 'changed' }));
  expect(await send(page, 'GET')).toBe('network error');
  await page.unrouteAll();
  await context.unrouteAll();

  // A request that reached egress through fetch(), by any handler, is not recorded again.
  let message;
  await context.route('**/api/items', (route) => route.fulfill({ body: 'context mock' }));
  await page.route('**/api/items', async (route) => {
    message = await route.fetch({ method: 'PATCH' }).then(() => 'fetched', (e) => e.message);
    return route.fallback();
  });
  expect(await send(page, 'POST')).toBe('context mock');
  expect(message).toBe(`write-guard: route.fetch of PATCH ${APP}/api/items is refused under read-only`);

  // Nothing left the browser; only the fetch reached an egress.
  expect(server.writes()).toEqual([]);
  expect(guard.record()).toMatchObject({ blocked: 1, observed: 0, mocked: 3, suspect: 0, routed_requests: routed + 1 });
  expect(guard.record().events).toEqual([
    write('mocked', 'POST', { contentType: TEXT_TYPE, body: '{}' }),
    write('mocked', 'DELETE', { contentType: TEXT_TYPE, body: '{}' }),
    write('mocked', 'PUT', { body: 'changed' }),
    write('block', 'PATCH', { contentType: TEXT_TYPE, body: '{}' }),
  ]);

  // Under observe a mocked write is recorded the same way.
  const other = await browser.newContext();
  try {
    await serve(other);
    const watcher = await install(other, { policy: 'observe', log: null });
    const seen = await open(other);
    await seen.route('**/api/items', (route) => route.fulfill({ body: 'mocked' }));
    expect(await send(seen, 'DELETE')).toBe('mocked');
    expect(watcher.record()).toMatchObject({ observed: 0, mocked: 1, events: [write('mocked', 'DELETE')] });
  } finally {
    await other.close();
  }
});

test('a continued or fetched write is judged at egress', async ({ context }) => {
  const server = await serve(context);
  const guard = await install(context, { log: null });
  const page = await open(context);
  const routed = guard.record().routed_requests;
  const api = () => server.seen.filter((s) => s.endsWith('/api/items'));

  // A write rewritten into a read before it leaves is a read: only what leaves is judged.
  await page.route('**/api/items', (route) => route.fallback({ method: 'GET' }));
  expect(await send(page, 'POST')).toBe(SERVED);
  expect(api()).toEqual(['GET /api/items']);
  expect(guard.record().events).toEqual([]);
  await page.unrouteAll();

  // A fallback override reaches a later handler's continue(), which judges it as overridden.
  let continued = 0;
  await page.route('**/api/items', (route) => route.fallback({ method: 'DELETE' }));
  await context.route('**/api/items', (route) => { continued++; return route.continue(); });
  expect(await send(page, 'GET')).toBe('network error');
  expect(continued).toBe(1);
  await page.unrouteAll();
  await context.unrouteAll();

  // A refused fetch, then a fallback to the catch-all: two egress attempts, one request.
  let message;
  await page.route('**/api/items', async (route) => {
    message = await route.fetch({ method: 'PATCH' }).then(() => 'fetched', (e) => e.message);
    return route.fallback();
  });
  expect(await send(page, 'GET')).toBe(SERVED);
  expect(message).toBe(`write-guard: route.fetch of PATCH ${APP}/api/items is refused under read-only`);

  expect(api()).toEqual(['GET /api/items', 'GET /api/items']);
  expect(guard.record()).toMatchObject({
    blocked: 2,
    routed_requests: routed + 3,
    events: [write('block', 'DELETE'), write('block', 'PATCH')],
  });
});

test('only real controls are judged', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await visit(context, '/real');

  // Each of these is a control labelled Delete, the open shadow one through its host.
  const judged = ['#j-menuitem', '#j-tab', '#j-link', '#j-submit', '#j-image', '#j-shadow'];
  for (const [i, selector] of judged.entries()) {
    await page.click(selector);
    await expect.poll(() => guard.record().blocked, { message: selector }).toBe(i + 1);
    expect(guard.record().events[i], selector).toEqual(control('Delete'));
  }
  expect(await hits(page)).toEqual([]);

  // None of these is a control: an anchor without href, a reset input, a summary, a tabindex
  // div, a plain onclick element, a checkbox in a tabindex row, plain text, and a button in
  // a closed shadow root.
  for (const selector of ['#n-reset', '#n-a', '#n-summary', '#n-tabindex', '#n-onclick', '#n-check', '#n-text', '#n-closed']) {
    await page.click(selector);
  }
  expect(await hits(page)).toEqual(['n-reset', 'n-a', 'n-summary', 'n-tabindex', 'n-onclick', 'n-check', 'n-row', 'n-text', 'n-closed']);
  expect(await page.isChecked('#n-check')).toBe(true);
  expect(guard.record().blocked).toBe(judged.length);
});

test('text fields never refuse a typed space or Enter', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await visit(context, '/text');

  await page.click('#t-input');
  await page.keyboard.type('Delete it');
  await page.keyboard.press('Enter');
  await page.click('#t-area');
  await page.keyboard.type('Remove all');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Save it');
  await page.click('#t-free');
  await page.keyboard.type('Send now');
  await page.keyboard.press('Enter');

  expect(await page.inputValue('#t-input')).toBe('Delete it');
  expect(await page.inputValue('#t-area')).toBe('Remove all\nSave it');
  expect(await page.inputValue('#t-free')).toBe('Send now');
  // Enter in the form's field submits it, judged by its harmless default button.
  expect(await hits(page)).toEqual(['submit t-go']);
  expect(guard.record()).toMatchObject({ blocked: 0, events: [] });
});

test('a refused click warns in the console', async ({ context, browser }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  // The page swaps console.warn out before anyone clicks; the guard kept the original.
  const page = await visit(context, '/neuter');
  const warnings = [];
  page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });

  const long = `Delete ${'x'.repeat(200)}`;
  await page.click('#drop');
  await page.evaluate((l) => document.body.insertAdjacentHTML('beforeend', `<button id="long">${l}</button>`), long);
  await page.click('#long');
  await expect.poll(() => warnings.length).toBe(2);
  await expect.poll(() => guard.record().blocked).toBe(2);
  const [a, b] = guard.record().events;
  expect(warnings).toEqual([
    `write-guard refused "Delete": ${a.reason}`,
    `write-guard refused "${long.slice(0, 120)}": ${b.reason}`,
  ]);

  // Under observe the click goes through and nothing reaches the console.
  const other = await browser.newContext();
  try {
    await serve(other);
    const watcher = await install(other, { policy: 'observe', log: null });
    const seen = await open(other);
    const messages = [];
    seen.on('console', (m) => messages.push(`${m.type()} ${m.text()}`));
    await seen.click('#del');
    await expect.poll(() => watcher.record().observed).toBe(1);
    await seen.evaluate(() => console.log('done'));
    await expect.poll(() => messages.length).toBeGreaterThan(0);
    expect(messages).toEqual(['log done']);
  } finally {
    await other.close();
  }
});

test('events carry the content type and, with logBodies, a body excerpt', async ({ context, browser }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await open(context);
  await page.evaluate(() => fetch('/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' }).catch(() => {}));
  await page.evaluate(() => fetch('/api/items', { method: 'DELETE' }).catch(() => {}));
  // No body by default; no content type when the request has none.
  expect(guard.record().events).toEqual([write('block', 'POST', { contentType: 'application/json' }), write('block', 'DELETE')]);

  const other = await browser.newContext();
  try {
    await serve(other);
    const watcher = await install(other, { log: null, logBodies: true });
    const seen = await open(other);
    const long = `${'a'.repeat(499)}bc`;
    await seen.evaluate((b) => fetch('/api/items', { method: 'PUT', body: b }).catch(() => {}), long);
    await seen.evaluate(() => fetch('/api/items', { method: 'DELETE' }).catch(() => {}));
    // An override's effective headers and body are what the event carries.
    await seen.route('**/api/items', (route) => route.fallback({ method: 'POST', headers: { 'Content-Type': 'text/csv' }, postData: 'a,b' }));
    await send(seen, 'GET');
    expect(watcher.record().events).toEqual([
      write('block', 'PUT', { contentType: TEXT_TYPE, body: `${'a'.repeat(499)}b` }),
      write('block', 'DELETE'),
      write('block', 'POST', { contentType: 'text/csv', body: 'a,b' }),
    ]);
  } finally {
    await other.close();
  }
});

test('a header signature allows a read', async ({ context }) => {
  const server = await serve(context);
  const guard = await install(context, { log: null, allow: [{ method: 'POST', url: '/api/action$', headers: { 'Next-Action': '^abc$' } }] });
  const page = await open(context);
  const act = (headers) => page.evaluate((h) => fetch('/api/action', { method: 'POST', headers: h, body: '[]' })
    .then((r) => r.text(), () => 'network error'), headers);

  expect(await act({ 'Next-Action': 'abc' })).toBe(SERVED);
  expect(await act({ 'Next-Action': 'abd' })).toBe('network error');
  expect(await act({})).toBe('network error');
  expect(server.writes()).toEqual(['POST /api/action']);

  // Overrides replace the whole header set, so an empty one drops the header the Sig needs.
  await page.route('**/api/action', (route) => route.continue({ headers: {} }));
  expect(await act({ 'Next-Action': 'abc' })).toBe('network error');
  await page.unrouteAll();
  await page.route('**/api/action', (route) => route.fallback({ headers: { ...route.request().headers(), 'x-extra': '1' } }));
  expect(await act({ 'Next-Action': 'abc' })).toBe(SERVED);

  expect(server.writes()).toEqual(['POST /api/action', 'POST /api/action']);
  expect(guard.record().blocked).toBe(3);
});

test('a websocket open is recorded', async ({ context }) => {
  // A page on https://app.test cannot open ws://127.0.0.1, so the page comes from the
  // socket server's own origin.
  const { host } = await listenEcho();
  const guard = await install(context, { log: null });
  const page = await context.newPage();
  await page.goto(`http://${host}/`);
  const routed = guard.record().routed_requests;

  const echo = await page.evaluate((u) => new Promise((resolve, reject) => {
    const ws = new WebSocket(u);
    ws.addEventListener('open', () => ws.send('hello'));
    ws.addEventListener('message', (e) => { resolve(e.data); ws.close(); });
    ws.addEventListener('error', () => reject(new Error('socket error')));
  }), `ws://${host}/socket`);

  expect(echo).toBe('hello');
  expect(guard.record()).toMatchObject({
    blocked: 0,
    observed: 0,
    routed_requests: routed,
    events: [{ kind: 'websocket', action: 'open', url: `ws://${host}/socket`, at: expect.any(String) }],
  });
  expect(Object.keys(guard.record().events[0]).sort()).toEqual(['action', 'at', 'kind', 'url']);
});

test('an overridden body is judged at continue', async ({ context }) => {
  const server = await serve(context);
  const guard = await install(context, { log: null, writes: [{ method: 'GET', url: '/api/items$', body: 'drop' }] });
  const page = await open(context);
  let override;
  await page.route('**/api/items', (route) => route.continue(override));

  // A string, a Buffer (read as UTF-8) and an object (read as its JSON), each carrying the body.
  for (override of [{ postData: 'drop it' }, { postData: Buffer.from('drop it') }, { postData: { op: 'drop' } }]) {
    expect(await send(page, 'GET')).toBe('network error');
  }
  // route.fetch sends its postData as the body, so it is judged as the body there too.
  await page.unrouteAll();
  let message;
  await page.route('**/api/items', async (route) => {
    message = await route.fetch({ postData: 'drop it' }).then(() => 'fetched', (e) => e.message);
    return route.fulfill({ body: 'mocked' });
  });
  expect(await send(page, 'GET')).toBe('mocked');
  expect(message).toBe(`write-guard: route.fetch of GET ${APP}/api/items is refused under read-only`);

  expect(server.seen.filter((s) => s.endsWith('/api/items'))).toEqual([]);
  expect(guard.record().events).toEqual(Array(4).fill(write('block', 'GET')));
});

test('an allowed or observed continue keeps its options', async ({ context }) => {
  // A server of its own on 127.0.0.1, and the page from its origin, so nothing is faked and
  // no request can leave the machine.
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers['x-guard'] ?? ''}`.trim());
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><p>Ok</p>');
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const guard = await install(context, { policy: 'observe', log: null });
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    seen.length = 0;
    await page.route('**/method', (route) => route.continue({ method: 'POST' }));
    await page.route('**/header', (route) => route.continue({ headers: { 'x-guard': 'kept' } }));

    // The observed write leaves as the POST it was rewritten into; the allowed read keeps its header.
    for (const path of ['/method', '/header']) await page.evaluate((p) => fetch(p).then((r) => r.text()), path);
    expect(seen).toEqual(['POST /method', 'GET /header kept']);
    expect(guard.record()).toMatchObject({ blocked: 0, observed: 1, events: [{ kind: 'request', action: 'observe', method: 'POST', url: `${origin}/method` }] });
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test('the content type comes from the effective headers', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await open(context);
  await page.route('**/api/items', (route) => route.continue({ method: 'POST', headers: { 'Content-Type': 'text/csv' } }));

  expect(await send(page, 'GET')).toBe('network error');
  expect(guard.record().events).toEqual([write('block', 'POST', { contentType: 'text/csv' })]);
});

test('each egress attempt records its own event', async ({ context }) => {
  const server = await serve(context);
  const guard = await install(context, { log: null });
  const page = await open(context);
  await page.route('**/api/items', async (route) => {
    await route.fetch({ method: 'PATCH' }).catch(() => {});
    return route.continue({ method: 'DELETE' });
  });

  expect(await send(page, 'GET')).toBe('network error');
  expect(server.writes()).toEqual([]);
  expect(guard.record()).toMatchObject({ blocked: 2, events: [write('block', 'PATCH'), write('block', 'DELETE')] });
});

test('a document blocked at a caller\'s continue gets the 403 page', async ({ context }) => {
  const server = await serve(context);
  await install(context, { log: null });
  const page = await open(context);
  await page.route('**/api/items', (route) => route.continue());

  await page.click('#go');
  await expect(page.locator('body')).toHaveText(`write-guard blocked POST ${APP}/api/items`);
  expect(server.writes()).toEqual([]);
});

test('the clicked submitter is judged, not the first submit button', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await visit(context, '/submitters');

  await page.click('#s-keep');
  expect(await hits(page)).toEqual(['submit s-keep']);
  expect(guard.record().blocked).toBe(0);

  await page.click('#s-delete');
  await expect.poll(() => guard.record().blocked).toBe(1);
  expect(await hits(page)).toEqual(['submit s-keep']);
});

test('the submit fallback finds plain, submit and form-owned buttons', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await visit(context, '/owners');

  for (const [i, id] of ['o-plain', 'o-typed', 'o-owned'].entries()) {
    await page.evaluate((f) => document.getElementById(f).requestSubmit(), id);
    await expect.poll(() => guard.record().blocked, { message: id }).toBe(i + 1);
    expect(guard.record().events[i], id).toEqual(control('Delete'));
  }
  expect(await hits(page)).toEqual([]);
});

test('a label that is only whitespace is skipped', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await visit(context, '/blank');

  await page.click('#b-blank');
  await expect.poll(() => guard.record().events).toEqual([control('Delete')]);
  expect(await hits(page)).toEqual([]);
});

test('the trimmed label is used in the warning', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await visit(context, '/trimmed');
  const warnings = [];
  page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });

  await page.click('#tr-delete');
  await expect.poll(() => warnings.length).toBe(1);
  expect(warnings).toEqual([`write-guard refused "Delete": ${guard.record().events[0].reason}`]);
  expect(await hits(page)).toEqual([]);
});

test('the innermost control on the composed path is judged', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await visit(context, '/nested');

  await page.click('#ne-delete');
  await expect.poll(() => guard.record().events).toEqual([control('Delete')]);
  expect(await hits(page)).toEqual([]);
});

test('the submit fallback takes the first submit button', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await visit(context, '/first');

  await page.evaluate(() => document.getElementById('fi-form').requestSubmit());
  await expect.poll(() => guard.record().events).toEqual([control('Delete')]);
  expect(await hits(page)).toEqual([]);
});

test('a route.fetch is judged once', async ({ context }) => {
  const server = await listen();
  const guard = await install(context, { policy: 'observe', log: null });
  const page = await context.newPage();
  await page.goto(`${server.origin}/`);
  const routed = guard.record().routed_requests;
  await page.route('**/api/save', async (route) => route.fulfill({ response: await route.fetch({ method: 'POST', postData: 'x' }) }));

  expect(await page.evaluate(() => fetch('/api/save').then((r) => r.text()))).toBe('ok');
  expect(server.lines().filter((l) => l.includes('/api/'))).toEqual(['POST /api/save']);
  // One egress, one event: route.fetch reaches the raw client, never the request-client
  // wrapper, and the fulfill after it is not a mock.
  expect(guard.record()).toMatchObject({ observed: 1, mocked: 0, routed_requests: routed + 1 });
  expect(guard.record().events).toEqual([
    { kind: 'request', action: 'observe', reason: expect.any(String), method: 'POST', url: `${server.origin}/api/save`, headerNames: expect.any(Array), at: expect.any(String) },
  ]);
});

test('a suspect GET is recorded and not blocked', async ({ context }) => {
  const server = await serve(context);
  const real = await listen();
  const guard = await install(context, { log: null, suspectGets: ['/api/ping$'] });
  const page = await open(context);
  const get = (path) => page.evaluate((p) => fetch(p).then((r) => r.text(), () => 'network error'), path);

  // Browser egress: suspect GETs go through and are recorded; a POST there is a write.
  for (const path of ['/api/logout', '/api/items?action=drop', '/api/ping', '/api/catalog']) expect(await get(path)).toBe(SERVED);
  expect(await post(page, '/api/logout', '{}')).toBe('network error');
  // Request clients and Node fetch.
  expect(await outcome(context.request.get(`${real.origin}/api/sign_out`))).toBe('ok');
  expect(await outcome(context.request.head(`${real.origin}/api/unsubscribe?t=1`))).toBe('');
  expect(await guard.guardFetch(fetch)(`${real.origin}/api/logout#x`).then((r) => r.text())).toBe('ok');
  // A GET a caller fulfills is never recorded as suspect.
  await page.route('**/api/confirm', (route) => route.fulfill({ body: 'mocked' }));
  expect(await get('/api/confirm')).toBe('mocked');

  expect(server.seen.filter((s) => s.includes('/api/'))).toEqual(['GET /api/logout', 'GET /api/items', 'GET /api/ping', 'GET /api/catalog']);
  expect(real.lines()).toEqual(['GET /api/sign_out', 'HEAD /api/unsubscribe?t=1', 'GET /api/logout']);
  const suspect = (method, url, via) => ({ kind: 'request', action: 'suspect', reason: expect.any(String), method, url, ...(via ? { via } : {}), headerNames: expect.any(Array), at: expect.any(String) });
  expect(guard.record().events).toEqual([
    suspect('GET', `${APP}/api/logout`),
    suspect('GET', `${APP}/api/items?action=drop`),
    suspect('GET', `${APP}/api/ping`),
    write('block', 'POST', { url: `${APP}/api/logout`, contentType: TEXT_TYPE }),
    suspect('GET', `${real.origin}/api/sign_out`, 'request-client'),
    suspect('HEAD', `${real.origin}/api/unsubscribe?t=1`, 'request-client'),
    suspect('GET', `${real.origin}/api/logout`, 'node-fetch'),
  ]);
  expect(guard.record()).toMatchObject({ suspect: 6, blocked: 1, observed: 0, mocked: 0 });
});

test('request events carry header names', async ({ context }) => {
  await serve(context);
  const server = await listen();
  const url = `${server.origin}/api/mode`;
  const guard = await install(context, { log: null, allow: [{ method: 'POST', url: '/api/mode$', headers: { 'X-Mode': '^read$' } }] });
  const page = await open(context);

  // Browser egress: the effective header names, lower case, unique, sorted; never the values.
  await page.evaluate(() => fetch('/api/items', { method: 'POST', headers: { 'X-B': '1', 'X-A': '2', 'Content-Type': 'text/csv' }, body: 'a' }).catch(() => {}));
  const [browserEvent] = guard.record().events;
  expect(browserEvent.headerNames).toEqual(expect.arrayContaining(['content-type', 'x-a', 'x-b']));
  expect(browserEvent.headerNames).toEqual([...new Set(browserEvent.headerNames.map((n) => n.toLowerCase()))].sort());
  expect(Object.keys(browserEvent).sort()).toEqual(['action', 'at', 'contentType', 'headerNames', 'kind', 'method', 'reason', 'url']);

  // A request client: names as for...in enumerates them (inherited ones too), undefined values
  // skipped, and of names equal after lower-casing the last is judged, as Playwright sends it.
  const headers = Object.assign(Object.create({ 'X-Inherited': '1' }), { 'X-Mode': 'read', 'x-mode': 'write', 'Content-Type': 'text/csv', 'content-type': 'text/plain', 'X-Undefined': undefined });
  expect(await outcome(context.request.post(url, { data: 'a', headers }))).toBe(refusal('POST', url));
  expect(await outcome(context.request.post(url, { data: 'a', headers: { 'x-mode': 'write', 'X-Mode': 'read' } }))).toBe('ok');
  expect(server.seen.map((s) => s.headers['x-mode'])).toEqual(['read']);
  // Node fetch: through new Headers(), so repeated names are one.
  await guard.guardFetch(fetch)(url, { method: 'PUT', headers: new Headers([['X-Z', '1'], ['x-z', '2'], ['Content-Type', 'text/csv']]) }).catch(() => {});
  expect(server.seen).toHaveLength(1);
  expect(guard.record().events.slice(1)).toEqual([
    sent('block', 'POST', url, 'request-client', { contentType: 'text/plain', headerNames: ['content-type', 'x-inherited', 'x-mode'] }),
    sent('block', 'PUT', url, 'node-fetch', { contentType: 'text/csv', headerNames: ['content-type', 'x-z'] }),
  ]);
});

test('a matching WebSocket frame is dropped and recorded', async ({ context, browser }) => {
  // The page comes from the echo server's own origin (a page on https://app.test cannot open ws://127.0.0.1).
  const echo = await listenEcho();
  const url = `ws://${echo.host}/socket`;
  // Sends each frame in order and resolves with the first message the page receives.
  const talk = (p, frames) => p.evaluate(([u, fs]) => new Promise((resolve, reject) => {
    const ws = new WebSocket(u);
    ws.addEventListener('open', () => { for (const f of fs) ws.send(f === 'binary' ? new Uint8Array([1, 2, 3]) : f); });
    ws.addEventListener('message', (e) => { resolve(e.data); ws.close(); });
    ws.addEventListener('error', () => reject(new Error('socket error')));
  }), [url, frames]);

  const guard = await install(context, { log: null, websocketWrites: ['^deleteItem '] });
  const page = await context.newPage();
  await page.goto(`http://${echo.host}/`);
  // The matching frame never reaches the server; a binary frame and any other text frame do.
  expect(await talk(page, ['deleteItem 1', 'binary', 'hello'])).toBe('hello');
  expect(echo.frames).toEqual(['binary 3', 'hello']);
  expect(guard.record()).toMatchObject({ blocked: 1, observed: 0 });
  expect(guard.record().events).toEqual([
    { kind: 'websocket', action: 'open', url, at: expect.any(String) },
    { kind: 'websocket', action: 'block', reason: expect.any(String), url, at: expect.any(String) },
  ]);

  // Under observe it is recorded, with its text under logBodies, and forwarded; the echo the
  // server sends back is never judged.
  const other = await browser.newContext();
  try {
    const watcher = await install(other, { policy: 'observe', log: null, logBodies: true, websocketWrites: ['^deleteItem '] });
    const seen = await other.newPage();
    await seen.goto(`http://${echo.host}/`);
    expect(await talk(seen, ['deleteItem 2'])).toBe('deleteItem 2');
    expect(echo.frames).toEqual(['binary 3', 'hello', 'deleteItem 2']);
    expect(watcher.record()).toMatchObject({ blocked: 0, observed: 1 });
    expect(watcher.record().events[1]).toEqual({ kind: 'websocket', action: 'observe', reason: expect.any(String), url, frame: 'deleteItem 2', at: expect.any(String) });
  } finally {
    await other.close();
  }
});

test('a suspect link is refused and a plain link is not', async ({ context, browser }) => {
  const server = await serve(context);
  const guard = await install(context, { log: null });
  const page = await visit(context, '/links');
  const warnings = [];
  page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });

  // Navigating links with a suspect URL are refused whatever their label, and do not navigate.
  for (const id of ['l-out', 'l-quiet', 'l-go']) await page.click(`#${id}`);
  expect(await hits(page)).toEqual([]);
  expect(page.url()).toBe(`${APP}/links`);
  await expect.poll(() => guard.record().blocked).toBe(3);
  const link = (label) => ({ kind: 'control', action: 'block', reason: expect.stringContaining('suspect'), label, at: expect.any(String) });
  expect(guard.record().events).toEqual([link('Log out'), link('Open'), link('Bye')]);
  await expect.poll(() => warnings).toEqual(guard.record().events.map((e) => `write-guard refused "${e.label}": ${e.reason}`));

  // A plain link is not judged in the page. Links that do not navigate (a hash, javascript:
  // even with a tab inside the scheme, an empty href) keep the label rule.
  await page.click('#l-plain');
  expect(await hits(page)).toEqual(['l-plain']);
  for (const id of ['l-hash', 'l-js', 'l-tab', 'l-empty']) await page.click(`#${id}`);
  await expect.poll(() => guard.record().blocked).toBe(7);
  expect(await hits(page)).toEqual(['l-plain']);
  expect(guard.record().events.slice(3)).toEqual(Array(4).fill(control('Delete')));
  expect(server.seen.filter((s) => s.includes('logout'))).toEqual([]);

  // Under observe a suspect link is recorded and goes through.
  const other = await browser.newContext();
  try {
    await serve(other);
    const watcher = await install(other, { policy: 'observe', log: null });
    const seen = await visit(other, '/links');
    await seen.click('#l-quiet');
    expect(await hits(seen)).toEqual(['l-quiet']);
    await expect.poll(() => watcher.record().observed).toBe(1);
    expect(watcher.record().events).toEqual([{ kind: 'control', action: 'observe', reason: expect.stringContaining('suspect'), label: 'Open', at: expect.any(String) }]);
  } finally {
    await other.close();
  }
});

test('a navigation link is not judged by its text', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null, controls: { icons: ['icon-trash'] } });
  const page = await visit(context, '/nav');

  // Verbs in the text, or a destructive icon, do not make a navigating link destructive.
  for (const id of ['v-help', 'v-nav', 'v-icon']) await page.click(`#${id}`);
  expect(await hits(page)).toEqual(['v-help', 'v-nav', 'v-icon']);
  // A [role=link] that is not an a[href] keeps the label rule.
  await page.click('#v-role');
  await expect.poll(() => guard.record().events).toEqual([control('Delete')]);
  expect(await hits(page)).toEqual(['v-help', 'v-nav', 'v-icon']);
});

test('URLSearchParams and array params are judged as Playwright sends them', async ({ context }) => {
  const server = await listen();
  await install(context, { log: null });
  const url = `${server.origin}/api/q`;

  // A URLSearchParams is the query; an array goes through Object.entries, so [['op', 'delete']] is `0=op%2Cdelete`.
  const sends = [
    [new URLSearchParams('op=delete'), '?op=delete'],
    [[['op', 'delete']], '?0=op%2Cdelete'],
  ];
  for (const [params, query] of sends) {
    expect(await outcome(context.request.post(url, { params }))).toBe(refusal('POST', `${url}${query}`));
    // The URL judged is the URL sent: a GET with the same params reaches the server with that query.
    expect(await outcome(context.request.get(url, { params }))).toBe('ok');
    expect(server.lines().at(-1)).toBe(`GET /api/q${query}`);
  }
});

test('a form send with a captured request is judged with no body', async ({ context }) => {
  const server = await listen();
  await serve(context);
  const target = `${server.origin}/api/x`;
  // Only a POST whose body starts with "query" is allowed.
  const guard = await install(context, { log: null, logBodies: true, allow: [{ method: 'POST', url: '/api/x$', body: '^query' }] });
  const page = await open(context);
  const captured = page.waitForRequest((r) => r.method() === 'POST');
  await post(page, '/api/items', 'query');
  const req = await captured;

  // The captured request's own body matches the allow entry.
  expect(await outcome(context.request.fetch(target, { request: req }))).toBe('ok');
  expect(server.seen.map((s) => [s.line, s.body])).toEqual([['POST /api/x', 'query']]);
  // Playwright sends the form, not that body, so no body is judged: the entry cannot match.
  expect(await outcome(context.request.fetch(target, { request: req, form: { a: '1' } }))).toBe(refusal('POST', target));
  expect(server.lines()).toEqual(['POST /api/x']);
  const events = guard.record().events.filter((e) => e.via === 'request-client');
  expect(events).toHaveLength(1);
  expect(events[0]).not.toHaveProperty('body');
});

test('a relative route.fetch URL is judged after the context baseURL', async ({ browser }) => {
  const server = await listen();
  const context = await browser.newContext({ baseURL: server.origin });
  try {
    // Only the absolute URL is allowed; a raw relative one matches nothing.
    const guard = await install(context, { log: null, allow: [{ method: 'POST', url: '^http://127[.]0[.]0[.]1:[0-9]+/api/fetched$' }] });
    const page = await context.newPage();
    await page.goto(`${server.origin}/`);
    let message;
    await page.route('**/api/trigger', async (route) => {
      message = await route.fetch({ url: '/api/fetched', method: 'POST' }).then(() => 'fetched', (e) => e.message);
      return route.fulfill({ body: 'mocked' });
    });

    expect(await page.evaluate(() => fetch('/api/trigger').then((r) => r.text()))).toBe('mocked');
    expect(message).toBe('fetched');
    expect(server.lines()).toEqual(['GET /', 'POST /api/fetched']);
    expect(guard.record()).toMatchObject({ blocked: 0, observed: 0 });
  } finally {
    await context.close();
  }
});

// Sends each frame in order, then a text frame to hear its echo, which proves the frames before it were handled.
const echoFrames = (page, url, frames) => page.evaluate(([u, fs]) => new Promise((resolve, reject) => {
  const ws = new WebSocket(u);
  ws.addEventListener('open', () => {
    for (const f of fs) ws.send(typeof f === 'string' ? f : new Uint8Array(f));
    ws.send('hello');
  });
  ws.addEventListener('message', (e) => { resolve(e.data); ws.close(); });
  ws.addEventListener('error', () => reject(new Error('socket error')));
}), [url, frames]);

test('a recorded frame is cut at 500 characters', async ({ context }) => {
  const echo = await listenEcho();
  const url = `ws://${echo.host}/socket`;
  const guard = await install(context, { log: null, logBodies: true, websocketWrites: ['^deleteItem '] });
  const page = await context.newPage();
  await page.goto(`http://${echo.host}/`);
  const frame = `deleteItem ${'a'.repeat(600)}`;

  // The long frame is refused, so the echo server only ever sees the short one.
  expect(await echoFrames(page, url, [frame])).toBe('hello');
  expect(echo.frames).toEqual(['hello']);
  const [, blocked] = guard.record().events;
  expect(blocked).toMatchObject({ kind: 'websocket', action: 'block', url });
  expect(blocked.frame).toHaveLength(500);
  expect(blocked.frame).toBe(frame.slice(0, 500));
});

test('a binary frame is never judged', async ({ context }) => {
  const echo = await listenEcho();
  const url = `ws://${echo.host}/socket`;
  const guard = await install(context, { log: null, logBodies: true, websocketWrites: ['^deleteItem '] });
  const page = await context.newPage();
  await page.goto(`http://${echo.host}/`);

  // Bytes that read as a matching text frame are still not a text frame: forwarded, not recorded.
  const bytes = [...Buffer.from('deleteItem 1')];
  expect(await echoFrames(page, url, [bytes])).toBe('hello');
  expect(echo.frames).toEqual(['binary 12', 'hello']);
  expect(guard.record().events).toEqual([{ kind: 'websocket', action: 'open', url, at: expect.any(String) }]);
});

test('a Node fetch string body is judged', async ({ context }) => {
  const server = await listen();
  const guard = await install(context, { log: null, logBodies: true, allow: [{ method: 'POST', url: '/api/q$', body: '^query' }] });
  const guarded = guard.guardFetch(fetch);
  const url = `${server.origin}/api/q`;
  const go = (body) => guarded(url, { method: 'POST', body }).then((r) => r.text(), (e) => e.message);

  // The body is what the allow entry and the event see: a matching one goes through, any other is refused and recorded.
  expect(await go('query')).toBe('ok');
  expect(await go('mutation')).toBe(refusal('POST', url, 'fetch'));
  expect(server.seen.map((s) => [s.line, s.body])).toEqual([['POST /api/q', 'query']]);
  expect(guard.record().events).toEqual([sent('block', 'POST', url, 'node-fetch', { body: 'mutation' })]);
});

// Pages for a 127.0.0.1 server that run `code` while they are being left, on each of `events`,
// with W the window whose APIs it uses and T naming the sender and the event: the page itself
// ('top'), an about:blank frame it made ('blank', called from the page's own handler, before
// that frame has seen any event) and a same-origin frame with a handler of its own ('child').
// `keep(name, value)` stores a result in sessionStorage, which outlives the page.
const leavingPages = (code, events = ['pagehide']) => {
  const script = (senders) => `<script>
const keep = (k, v) => sessionStorage.setItem(k, String(v));
const run = (W, T) => { try { ${code} } catch (e) { keep(T + ' threw', e.message); } };
for (const ev of ${JSON.stringify(events)}) addEventListener(ev, () => { ${senders} });
</script>`;
  return {
    '/editor': `<!doctype html><a id="away" href="/other">Other</a><iframe src="/child"></iframe><script>
const blank = document.body.appendChild(document.createElement('iframe'));
</script>${script("run(window, 'top-' + ev); run(blank.contentWindow, 'blank-' + ev);")}`,
    '/child': `<!doctype html>${script("run(window, 'child-' + ev);")}`,
  };
};
const LEAVES = ['page.goto', 'a link click', 'page.close'];
// Opens the leaving page in a new page and leaves it `how`, then gives the browser a fixed second
// to deliver what the page sent, so counts at the server do not depend on a race. Returns what the
// page kept (nothing after page.close).
async function leave(context, server, how) {
  server.seen.length = 0;
  const page = await context.newPage();
  await page.goto(`${server.origin}/editor`);
  if (how === 'page.goto') await page.goto(`${server.origin}/other`);
  if (how === 'a link click') {
    await page.click('#away');
    await page.waitForURL('**/other');
  }
  if (how === 'page.close') await page.close();
  await new Promise((settle) => setTimeout(settle, 1000));
  return how === 'page.close' ? null : page.evaluate(() => ({ ...sessionStorage }));
}
// What reached the server other than reads, sorted.
const writesAt = (server) => server.lines().filter((l) => !l.startsWith('GET ')).sort();
const unloadRefusal = (method, url) => `write-guard: ${method} ${url} from a hidden or unloading page is refused under read-only`;
const SENDERS = ['blank', 'child', 'top'];

test('an allowed write from a leaving page still goes out', async ({ context }) => {
  const server = await listen(leavingPages(`
keep(T, W.navigator.sendBeacon('/api/kept-beacon-' + T + '#f', 'keep') + ' ' + W.navigator.sendBeacon('/api/kept-beacon-' + T, 'nope'));
W.fetch('/api/kept-fetch-' + T + '#f', { method: 'POST', body: 'keep', keepalive: true });
const x = new W.XMLHttpRequest();
x.open('put', '/api/kept-xhr-' + T);
x.setRequestHeader('X-Kind', 'draft');
x.send('x');
keep('xhr-' + T, 'sent');
// A second open forgets the header, so this one is refused.
const y = new W.XMLHttpRequest();
y.open('PUT', '/api/kept-xhr-' + T);
y.setRequestHeader('X-Kind', 'draft');
y.open('PUT', '/api/kept-xhr-' + T);
try { y.send('x'); keep('reopened-' + T, 'sent'); } catch (e) { keep('reopened-' + T, e.message); }`));
  // The resolved URL without its fragment, the body, the content type fetch derives and an XHR
  // header are what the entries match.
  await install(context, {
    log: null,
    allow: [
      { method: 'POST', url: '^http://127[.]0[.]0[.]1:[0-9]+/api/kept-beacon-[a-z]+-pagehide$', body: '^keep$' },
      { method: 'POST', url: '^http://127[.]0[.]0[.]1:[0-9]+/api/kept-fetch-[a-z]+-pagehide$', body: '^keep$', headers: { 'content-type': '^text/plain;charset=UTF-8$' } },
      { method: 'PUT', url: '/api/kept-xhr-', headers: { 'x-kind': '^draft$' } },
    ],
  });
  for (const how of LEAVES) {
    const kept = await leave(context, server, how);
    // A beacon or keepalive fetch allowed this way reaches the server; an XHR may be cancelled with the document.
    const posts = writesAt(server).filter((l) => l.startsWith('POST '));
    expect(posts, how).toEqual(SENDERS.flatMap((t) => [`POST /api/kept-beacon-${t}-pagehide`, `POST /api/kept-fetch-${t}-pagehide`]).sort());
    if (kept) {
      for (const t of SENDERS) {
        expect(kept[`${t}-pagehide`], `${how} ${t}`).toBe('true false');
        expect(kept[`xhr-${t}-pagehide`], `${how} ${t}`).toBe('sent');
        expect(kept[`reopened-${t}-pagehide`], `${how} ${t}`).toBe(unloadRefusal('PUT', `${server.origin}/api/kept-xhr-${t}-pagehide`));
      }
    }
  }
});

test('an unload beacon does not reach the server under read-only', async ({ context }) => {
  const server = await listen(leavingPages(`keep(T, W.navigator.sendBeacon('/api/beacon-' + T, 'x'));`, ['visibilitychange', 'pagehide']));
  const guard = await install(context, { log: null });
  for (const how of LEAVES) {
    const kept = await leave(context, server, how);
    expect(writesAt(server), how).toEqual([]);
    if (kept) {
      for (const t of SENDERS) expect(kept[`${t}-pagehide`], `${how} ${t}`).toBe('false');
      expect(new Set(Object.values(kept)), how).toEqual(new Set(['false']));
    }
  }
  // A send judged in a leaving page is recorded nowhere.
  expect(guard.record().events).toEqual([]);
});

test('a keepalive fetch on pagehide does not reach the server under read-only', async ({ context }) => {
  const server = await listen(leavingPages(`
W.fetch('/api/keep-' + T, { method: 'POST', body: 'x', keepalive: true }).then(() => keep(T, 'sent'), (e) => keep(T, e.name + ': ' + e.message));
const x = new W.XMLHttpRequest();
x.open('POST', '/api/xhr-' + T);
try { x.send('x'); keep('xhr-' + T, 'sent'); } catch (e) { keep('xhr-' + T, e.name + ': ' + e.message); }`));
  await install(context, { log: null });
  for (const how of LEAVES) {
    const kept = await leave(context, server, how);
    expect(writesAt(server), how).toEqual([]);
    if (kept) {
      for (const t of SENDERS) {
        const T = `${t}-pagehide`;
        expect(kept[T], how).toBe(`TypeError: ${unloadRefusal('POST', `${server.origin}/api/keep-${T}`)}`);
        expect(kept[`xhr-${T}`], how).toBe(`TypeError: ${unloadRefusal('POST', `${server.origin}/api/xhr-${T}`)}`);
      }
    }
  }
});

test('a beacon sent while the page stays open is judged', async ({ context }) => {
  const server = await listen();
  const guard = await install(context, { log: null, allow: [{ method: 'POST', url: '/api/allowed$' }] });
  const page = await context.newPage();
  await page.goto(`${server.origin}/`);

  // Untouched: the browser queues both, and each is judged at egress like any other request.
  expect(await page.evaluate(() => [navigator.sendBeacon('/api/refused', 'x'), navigator.sendBeacon('/api/allowed', 'x')])).toEqual([true, true]);
  await expect.poll(() => guard.record().events).toEqual([{
    kind: 'request', action: 'block', reason: expect.any(String), method: 'POST', url: `${server.origin}/api/refused`,
    contentType: TEXT_TYPE, headerNames: expect.any(Array), at: expect.any(String),
  }]);
  await expect.poll(() => writesAt(server)).toEqual(['POST /api/allowed']);
});

test('fetchLater is removed under read-only', async ({ browser, context }) => {
  const server = await listen();
  // Without the guard the browser has fetchLater, and a POST through it reaches the server
  // unrouted, so the check below means something.
  const bare = await browser.newContext();
  try {
    const page = await bare.newPage();
    await page.goto(`${server.origin}/`);
    expect(await page.evaluate(() => {
      fetchLater('/api/later', { method: 'POST', body: 'x', activateAfter: 0 });
      return 'fetchLater' in window;
    })).toBe(true);
    await expect.poll(() => writesAt(server)).toEqual(['POST /api/later']);
  } finally {
    await bare.close();
  }

  server.seen.length = 0;
  await install(context, { log: null });
  const page = await context.newPage();
  await page.goto(`${server.origin}/`);
  // Gone from the page and from a frame it makes, so nothing sends through it.
  expect(await page.evaluate(() => {
    const blank = document.body.appendChild(document.createElement('iframe'));
    return [window, blank.contentWindow].map((W) => {
      if (typeof W.fetchLater === 'function') W.fetchLater('/api/later', { method: 'POST', body: 'x', activateAfter: 0 });
      return 'fetchLater' in W;
    });
  })).toEqual([false, false]);
  await page.close();
  await new Promise((settle) => setTimeout(settle, 1000));
  expect(writesAt(server)).toEqual([]);
});

test('a same-origin frame behind a cross-origin frame is judged when it leaves', async ({ playwright }) => {
  // The top and the inner frame are on 127.0.0.1; the middle frame is on middle.test, which the
  // browser maps to the same server, so it is cross-origin to both.
  const pages = {};
  const server = await listen(pages);
  const middle = server.origin.replace('127.0.0.1', 'middle.test');
  pages['/top'] = `<!doctype html><iframe src="${middle}/middle"></iframe><script>
addEventListener('pagehide', () => {
  const W = frames[0].frames[0];
  W.navigator.sendBeacon('/api/inner-beacon', 'x');
  W.fetch('/api/inner-fetch', { method: 'POST', body: 'x', keepalive: true }).catch(() => {});
});
</script>`;
  pages['/middle'] = `<!doctype html><iframe src="${server.origin}/inner"></iframe>`;
  const browser = await playwright.chromium.launch({ args: ['--host-resolver-rules=MAP middle.test 127.0.0.1'] });
  try {
    const context = await browser.newContext();
    await install(context, { log: null });
    for (const how of ['page.goto', 'page.close']) {
      server.seen.length = 0;
      const page = await context.newPage();
      await page.goto(`${server.origin}/top`);
      // The top reaches the inner frame through the cross-origin middle one.
      expect(await page.evaluate(() => frames[0].frames[0].location.href), how).toBe(`${server.origin}/inner`);
      if (how === 'page.goto') await page.goto(`${server.origin}/other`); else await page.close();
      await new Promise((settle) => setTimeout(settle, 1000));
      expect(writesAt(server), how).toEqual([]);
      if (how === 'page.goto') await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('a SharedWorker is refused under read-only', async ({ context }) => {
  const server = await listen();
  await install(context, { log: null });
  const page = await context.newPage();
  await page.goto(`${server.origin}/`);

  // Gone from the page and from a frame it makes, so an app that detects it falls back; a
  // dedicated Worker, which is routed, stays.
  const present = await page.evaluate(() => {
    const blank = document.body.appendChild(document.createElement('iframe'));
    return [window, blank.contentWindow].flatMap((W) => ['SharedWorker' in W, typeof W.Worker]);
  });
  expect(present).toEqual([false, 'function', false, 'function']);
});

test('observe leaves sendBeacon, keepalive and SharedWorker alone', async ({ browser, context }) => {
  const server = await listen(leavingPages(`
W.navigator.sendBeacon('/api/beacon-' + T, 'x');
W.fetch('/api/keep-' + T, { method: 'POST', body: 'x', keepalive: true });`));
  // fetchLater is expected exactly when the browser has it without the guard.
  const bare = await browser.newContext();
  let later;
  try {
    const page = await bare.newPage();
    await page.goto(`${server.origin}/`);
    later = await page.evaluate(() => typeof window.fetchLater);
  } finally {
    await bare.close();
  }
  await install(context, { log: null, policy: 'observe' });
  const page = await context.newPage();
  await page.goto(`${server.origin}/`);
  expect(await page.evaluate(() => typeof window.fetchLater)).toBe(later);

  const natives = await page.evaluate(() => [window.fetch, Navigator.prototype.sendBeacon, XMLHttpRequest.prototype.open,
    XMLHttpRequest.prototype.setRequestHeader, XMLHttpRequest.prototype.send, window.SharedWorker]
    .map((f) => Function.prototype.toString.call(f).endsWith('{ [native code] }')));
  expect(natives).toEqual(Array(6).fill(true));
  expect(await page.evaluate(() => typeof new SharedWorker('data:text/javascript,'))).toBe('object');
  // Sends from a leaving page are neither judged nor refused.
  await leave(context, server, 'page.goto');
  expect(writesAt(server)).toEqual(SENDERS.flatMap((t) => [`POST /api/beacon-${t}-pagehide`, `POST /api/keep-${t}-pagehide`]).sort());
});
