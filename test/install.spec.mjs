// The installer, end to end in Chromium. Every page and API is served by routes on the fake
// host https://app.test, so these tests need no network.

import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
<form id="save" onsubmit="window.hits.push('save'); return false"><button>Save</button></form>
<form id="find" onsubmit="window.hits.push('find'); return false"><button>Search</button></form>
<div id="remove" tabindex="0" onkeydown="window.hits.push('remove ' + event.code)">Delete</div>
<div id="open" tabindex="0" onkeydown="window.hits.push('open ' + event.code)">Open</div>
<button aria-label="Delete item" onclick="window.hits.push('delete')"><span id="icon">x</span></button>
<button aria-label="Open item" onclick="window.hits.push('open item')"><span id="glyph">x</span></button>`;

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

// A page that tries to switch the refusal off before anyone clicks.
const NEUTER = `<!doctype html>
<script>
window.hits = [];
Event.prototype.preventDefault = function () {};
Event.prototype.stopImmediatePropagation = function () {};
window.__writeGuardReport = () => {};
</script>
<button id="drop">Delete</button>
<a id="leave" href="#gone">Delete</a>
<script>
for (const id of ['drop', 'leave']) document.getElementById(id).addEventListener('click', () => window.hits.push(id));
</script>`;

const PAGES = { '/controls': CONTROLS, '/kinds': KINDS, '/neuter': NEUTER };

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
const write = (action, method) => ({ kind: 'request', action, reason: expect.any(String), method, url: `${APP}/api/items`, at: expect.any(String) });
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
    { kind: 'request', action: 'block', reason: expect.any(String), method: 'POST', url: `${APP}/api/items`, at: expect.any(String) },
    { kind: 'request', action: 'block', reason: expect.any(String), method: 'DELETE', url: `${APP}/api/items`, at: expect.any(String) },
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
  // Present page (the fixture's) and context alike; newest handlers run first.
  await context.route('**/api/items', (route) => { calls++; return route.continue(); });
  await page.route('**/api/items', (route) => { calls++; return route.continue(); });

  expect(await send(page, 'POST')).toBe('network error');
  expect(calls).toBe(0);
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
  // Seen by the page wrapper, the context wrapper and the catch-all, judged once.
  expect(guard.record().routed_requests).toBe(before + 1);

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

test('a form sent with requestSubmit() is judged by its label', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await context.newPage();
  await page.goto(`${APP}/controls`);

  await page.evaluate(() => {
    document.getElementById('save').requestSubmit();
    document.getElementById('find').requestSubmit();
  });
  expect(await hits(page)).toEqual(['find']);
  await expect.poll(() => guard.record().blocked).toBe(1);
  expect(guard.record().events).toEqual([control('Save')]);
});

test('Space and Enter on a focusable element are judged by its label', async ({ context }) => {
  await serve(context);
  const guard = await install(context, { log: null });
  const page = await context.newPage();
  await page.goto(`${APP}/controls`);

  // No click handler anywhere, and a div has no click activation on either key: only the
  // keydown listener stands between the key and the app.
  for (const key of ['Space', 'Enter']) {
    await page.focus('#remove');
    await page.keyboard.press(key);
    await page.focus('#open');
    await page.keyboard.press(key);
  }
  expect(await hits(page)).toEqual(['open Space', 'open Enter']);
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
    ['#k-tabindex span', 'Delete'],
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

  // The submitter is judged, not the form, whose text also holds "Save".
  await page.click('#k-cancel');
  expect(await hits(page)).toEqual(['k-cancel', 'submit k-cancel']);
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
  // An override with no options sends the original request, already judged and recorded.
  // fallback() takes the same judging path as continue() and reaches the fake server, where
  // continue() would leave for the network.
  await page.route('**/api/items', (route) => route.fallback());

  expect(await send(page, 'POST')).toBe(SERVED);
  expect(server.writes()).toEqual(['POST /api/items']);
  expect(guard.record().events).toEqual([write('observe', 'POST')]);
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
