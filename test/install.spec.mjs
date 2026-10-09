// The installer, end to end in Chromium. Every page and API is served by routes on the fake
// host https://app.test, so these tests need no network.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { install, loadConfig } from '../src/install.mjs';

const APP = 'https://app.test';
const SERVED = '{"ok":true}';
const HOME = `<!doctype html>
<script>window.hits = [];</script>
<form method="post" action="/api/items"><button id="go" type="submit">Go</button></form>
<button id="del" onclick="window.hits.push('del')">Delete item</button>
<button id="view" onclick="window.hits.push('view')">View</button>
<button id="trash" onclick="window.hits.push('trash')"><i class="icon-trash"></i></button>`;

// The fake server. Registered before `install`, so it is not the caller's to remove, and it
// records every request that reaches it.
async function serve(context) {
  const seen = [];
  await context.route(`${APP}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    seen.push(`${req.method()} ${url.pathname}`);
    if (url.pathname.startsWith('/api/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: SERVED });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: HOME });
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
