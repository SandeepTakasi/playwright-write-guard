// The installer, end to end in Chromium. Every page and API is served by routes on the fake
// host https://app.test, and the socket test by a server of its own on 127.0.0.1, so these
// tests need no network.

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

const PAGES = { '/controls': CONTROLS, '/kinds': KINDS, '/neuter': NEUTER, '/real': REAL, '/forms': FORMS, '/text': TEXT };

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
const write = (action, method, extra = {}) => ({ kind: 'request', action, reason: expect.any(String), method, url: `${APP}/api/items`, ...extra, at: expect.any(String) });
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

// An unlocked APIRequestContext refuses a negative maxRetries in its own option check, before
// sending anything; a locked one answers with the guard's refusal first. No request leaves.
const sendThrough = (client, method) => client[method](`${APP}/api/items`, { maxRetries: -1 }).then(() => 'sent', (e) => e.message);
const OWN_CHECK = "'maxRetries' must be greater than or equal to '0'";

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
    { kind: 'request', action: 'block', reason: expect.any(String), method: 'POST', url: `${APP}/api/items`, contentType: TEXT_TYPE, at: expect.any(String) },
    { kind: 'request', action: 'block', reason: expect.any(String), method: 'DELETE', url: `${APP}/api/items`, contentType: TEXT_TYPE, at: expect.any(String) },
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
  const blocked = { kind: 'request', action: 'block', reason: expect.any(String), method: 'GET', url: danger, at: expect.any(String) };
  expect(guard.record().events).toEqual([blocked, blocked]);
});

test('install locks the request of a page that already exists', async ({ context, page }) => {
  await install(context, { log: null });
  await expect(page.request.post(`${APP}/api/items`)).rejects
    .toThrow('write-guard: post through APIRequestContext is refused under read-only');
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
    ws.onclose = () => resolve(true);
  }));
  expect(closed).toBe(true);
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

test('read-only locks APIRequestContext send methods', async ({ context }) => {
  await install(context, { log: null });
  const page = await context.newPage();
  await expect(context.request.post(`${APP}/api/items`)).rejects
    .toThrow('write-guard: post through APIRequestContext is refused under read-only');
  await expect(page.request.get(`${APP}/api/items`)).rejects
    .toThrow('write-guard: get through APIRequestContext is refused under read-only');
  await expect(page.request.fetch(`${APP}/api/items`)).rejects
    .toThrow('write-guard: fetch through APIRequestContext is refused under read-only');
  expect(typeof context.request.storageState).toBe('function');
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

test('every send method is refused under read-only', async ({ context, page }) => {
  const server = await serve(context);
  await install(context, { log: null });
  for (const client of [context.request, page.request]) {
    for (const method of ['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head']) {
      expect(await sendThrough(client, method)).toBe(`write-guard: ${method} through APIRequestContext is refused under read-only`);
    }
  }
  expect(server.seen).toEqual([]);
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

test('observe neither locks request clients nor dismisses dialogs', async ({ context, page }) => {
  await serve(context);
  await install(context, { policy: 'observe', log: null });
  const later = await open(context);

  // `page` existed before install, `later` was opened after it.
  for (const client of [context.request, page.request, later.request]) {
    expect(await sendThrough(client, 'post')).toContain(OWN_CHECK);
  }
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

test('a caller can fulfill or abort a write', async ({ context }) => {
  const server = await serve(context);
  const guard = await install(context, { log: null });
  const page = await open(context);
  const routed = guard.record().routed_requests;

  await page.route('**/api/items', (route) => route.fulfill({ status: 201, body: 'mocked' }));
  expect(await send(page, 'POST')).toBe('mocked');
  await page.unrouteAll();
  await context.route('**/api/items', (route) => route.abort('failed'));
  expect(await send(page, 'DELETE')).toBe('network error');

  // Neither reached an egress: nothing left the browser, nothing is judged or recorded.
  expect(server.writes()).toEqual([]);
  expect(guard.record()).toMatchObject({ blocked: 0, observed: 0, routed_requests: routed, events: [] });
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
  // socket server's own origin. It answers one short text frame with its echo.
  const sockets = [];
  const server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><p>Socket</p>'));
  server.on('upgrade', (req, socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (d) => {
      if ((d[0] & 0x0f) !== 1) return;
      const length = d[1] & 0x7f;
      const mask = d.subarray(2, 6);
      const payload = Buffer.from(d.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i % 4]));
      socket.write(Buffer.concat([Buffer.from([0x81, length]), payload]));
    });
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  try {
    const host = `127.0.0.1:${server.address().port}`;
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
  } finally {
    for (const s of sockets) s.destroy();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
