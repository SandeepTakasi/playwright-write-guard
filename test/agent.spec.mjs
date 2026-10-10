// The two agent modes, end to end in Chromium. The launcher's client serves its pages with its
// own routes on the fake host https://app.test, and the launcher binds to 127.0.0.1, so these
// tests need no network.

import { test, expect, chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startGuardedBrowser } from '../src/browser.mjs';
import initPage from '../src/init-page.mjs';

const APP = 'https://app.test';
const SERVED = '{"ok":true}';
const BIN = fileURLToPath(new URL('../bin/browser.mjs', import.meta.url));
const HOME = `<!doctype html>
<script>window.hits = [];</script>
<button id="del" onclick="window.hits.push('del')">Delete item</button>
<button id="view" onclick="window.hits.push('view')">View</button>`;

// The fake server, as the attached client's own route. It records every request that reaches
// it; a request the guard blocks never does.
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

const send = (page, method, path = '/api/items') => page.evaluate(([m, p]) => fetch(p, { method: m, body: m === 'GET' ? undefined : '{}' })
  .then((r) => r.text(), () => 'network error'), [method, path]);

test.describe('the launcher', () => {
  let launcher;
  let client;
  let context;

  test.beforeEach(async () => {
    launcher = await startGuardedBrowser({ port: 0, config: { log: null } });
    client = await chromium.connect(launcher.wsEndpoint);
    context = client.contexts()[0];
  });

  test.afterEach(async () => {
    await client?.close();
    await launcher?.close();
    launcher = client = context = undefined;
  });

  test('binds to 127.0.0.1 and hands the client its one guarded context', async () => {
    expect(launcher.wsEndpoint).toMatch(/^ws:\/\/127[.]0[.]0[.]1:\d+\//);
    expect(client.contexts()).toHaveLength(1);
    expect(launcher.guard.record()).toMatchObject({ installed: true, policy: 'read-only', blocked: 0 });
  });

  test('a client cannot POST', async () => {
    const server = await serve(context);
    const page = await open(context);

    expect(await send(page, 'GET')).toBe(SERVED);
    expect(await send(page, 'POST')).toBe('network error');
    expect(server.writes()).toEqual([]);
    expect(launcher.guard.record()).toMatchObject({ blocked: 1 });
    expect(launcher.guard.record().events[0]).toMatchObject({ kind: 'request', action: 'block', method: 'POST', url: `${APP}/api/items` });
  });

  test('a client\'s own route with continue() cannot let a blocked request past', async () => {
    await serve(context);
    const page = await open(context);
    // Newest handler first: without the guard these would send the POST to the network, where
    // the fake host does not resolve. The client's page route may see the request, but its
    // continue() passes it on to the guard, which aborts it.
    await context.route('**/api/**', (route) => route.continue());
    await page.route('**/api/**', (route) => route.continue());
    const failed = page.waitForEvent('requestfailed');

    expect(await send(page, 'POST')).toBe('network error');
    expect((await failed).failure().errorText).toMatch(/BLOCKED_BY_CLIENT/);
    expect(launcher.guard.record()).toMatchObject({ blocked: 1 });
  });

  test('a client\'s unrouteAll() leaves the guard in place', async () => {
    await serve(context);
    const page = await open(context);
    await context.unrouteAll();
    await page.unrouteAll();
    // Serve again: if unrouteAll had removed the guard, this route would receive the POST.
    const server = await serve(context);

    expect(await send(page, 'GET')).toBe(SERVED);
    expect(await send(page, 'POST')).toBe('network error');
    expect(server.writes()).toEqual([]);
    expect(launcher.guard.record()).toMatchObject({ blocked: 1 });
  });

  test('a new tab the client opens is guarded', async () => {
    const server = await serve(context);
    await open(context);
    const tab = await open(context);
    const popup = await Promise.all([tab.waitForEvent('popup'), tab.evaluate((u) => window.open(u), `${APP}/popup`)]).then(([p]) => p);
    await popup.waitForLoadState();

    expect(await send(tab, 'PUT')).toBe('network error');
    expect(await send(popup, 'DELETE')).toBe('network error');
    expect(server.writes()).toEqual([]);
    expect(launcher.guard.record()).toMatchObject({ blocked: 2 });
  });

  test('a service worker never becomes ready in its context', async () => {
    await serve(context);
    // Newest handler first: the worker script is real JavaScript, so where workers are allowed
    // it registers and becomes ready, and only the launcher's block makes this test pass.
    await context.route(`${APP}/sw.js`, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    const page = await open(context);
    const outcome = await page.evaluate(() => navigator.serviceWorker.register('/sw.js').then(
      () => Promise.race([navigator.serviceWorker.ready.then(() => 'ready'), new Promise((r) => setTimeout(() => r('no worker'), 1000))]),
      (e) => `registration failed: ${e.name}`));

    expect(outcome).toBe('no worker');
    expect(context.serviceWorkers()).toEqual([]);
  });

  test('a destructive click in the client\'s page is refused', async () => {
    await serve(context);
    const page = await open(context);

    await page.click('#view');
    await page.click('#del');
    expect(await page.evaluate(() => window.hits)).toEqual(['view']);
    await expect.poll(() => launcher.guard.record().blocked).toBe(1);
    expect(launcher.guard.record().events[0]).toMatchObject({ kind: 'control', action: 'block', label: 'Delete item' });
  });
});

test('the launcher\'s log is complete after close', async ({}, testInfo) => {
  const log = testInfo.outputPath('guard.log');
  const g = await startGuardedBrowser({ port: 0, config: { log } });
  const client = await chromium.connect(g.wsEndpoint);
  let closed = false;
  try {
    const context = client.contexts()[0];
    await serve(context);
    const page = await open(context);
    // Back to back, so appends are still pending when close() is called.
    await page.evaluate(() => Promise.all(['POST', 'PUT', 'DELETE', 'PATCH', 'POST'].map((m) => fetch('/api/items', { method: m, body: '{}' }).catch(() => {}))));
    const { events } = g.guard.record();
    expect(events.length).toBeGreaterThanOrEqual(5);
    await g.close();
    closed = true;
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines).toHaveLength(events.length);
    expect(lines.every((l) => l.action === 'block')).toBe(true);
  } finally {
    await client.close().catch(() => {});
    if (!closed) await g.close();
  }
});

test.describe('the command', () => {
  test('prints the endpoint and how to attach, and exits 0 on SIGTERM', async ({}, testInfo) => {
    const config = testInfo.outputPath('config.json');
    writeFileSync(config, JSON.stringify({ log: null }));
    const child = spawn(process.execPath, [BIN, '--config', config, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
    try {
      let out = '';
      child.stdout.setEncoding('utf8');
      await new Promise((done, fail) => {
        child.stdout.on('data', (d) => { out += d; if (/^endpoint: .*\n[\s\S]*attach --endpoint=/m.test(out)) done(); });
        child.on('exit', () => fail(new Error(`exited early: ${out}`)));
      });
      const endpoint = out.match(/^endpoint: (ws:\/\/127[.]0[.]0[.]1:\d+\/\S+)$/m)?.[1];
      expect(endpoint).toBeTruthy();
      expect(out).toContain(`--endpoint ${endpoint}`);
      expect(out).toContain('--isolated');
      expect(out).toContain(`playwright-cli attach --endpoint=${endpoint}`);

      const client = await chromium.connect(endpoint);
      expect(client.contexts()).toHaveLength(1);
      await client.close();
    } finally {
      child.kill('SIGTERM');
    }
    expect(await exited).toEqual({ code: 0, signal: null });
  });

  test('the command reads the config named by --config', async ({}, testInfo) => {
    const config = testInfo.outputPath('observe.json');
    writeFileSync(config, JSON.stringify({ policy: 'observe', log: null }));
    const env = { ...process.env };
    delete env.WRITE_GUARD_CONFIG;
    delete env.WRITE_GUARD_POLICY;
    const child = spawn(process.execPath, [BIN, '--config', config, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], env });
    const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
    try {
      let out = '';
      child.stdout.setEncoding('utf8');
      await new Promise((done, fail) => {
        child.stdout.on('data', (d) => { out += d; if (/^endpoint: .*\n/m.test(out)) done(); });
        child.on('exit', () => fail(new Error(`exited early: ${out}`)));
      });
      const endpoint = out.match(/^endpoint: (ws:\/\/127[.]0[.]0[.]1:\d+\/\S+)$/m)?.[1];
      expect(endpoint).toBeTruthy();

      const client = await chromium.connect(endpoint);
      const server = await serve(client.contexts()[0]);
      const page = await open(client.contexts()[0]);
      // Under the default read-only this POST is blocked and never reaches the client's route.
      expect(await send(page, 'POST')).toBe(SERVED);
      expect(server.writes()).toEqual(['POST /api/items']);
      await client.close();
    } finally {
      child.kill('SIGTERM');
    }
    expect(await exited).toEqual({ code: 0, signal: null });
  });

  test('an unknown flag or a flag missing its value prints the usage line and exits 1', () => {
    for (const args of [['--nope'], ['--port'], ['--config']]) {
      const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('usage: playwright-write-guard-browser [--config <path>] [--headed] [--host <h>] [--port <n>]');
    }
  });
});

test.describe('the initPage entry', () => {
  let saved;
  test.beforeEach(async ({}, testInfo) => {
    // A config file proves the entry reads loadConfig(): it names GET /api/report a write.
    const file = testInfo.outputPath('write-guard.config.json');
    writeFileSync(file, JSON.stringify({ log: null, writes: [{ method: 'GET', url: '/api/report$' }] }));
    saved = { c: process.env.WRITE_GUARD_CONFIG, p: process.env.WRITE_GUARD_POLICY };
    process.env.WRITE_GUARD_CONFIG = file;
    delete process.env.WRITE_GUARD_POLICY;
  });
  test.afterEach(() => {
    for (const [k, v] of [['WRITE_GUARD_CONFIG', saved.c], ['WRITE_GUARD_POLICY', saved.p]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test('guards the page it is handed, with loadConfig()', async ({ context, page }) => {
    const server = await serve(context);
    const guard = await initPage({ page });
    await page.goto(`${APP}/`);

    expect(await send(page, 'GET')).toBe(SERVED);
    expect(await send(page, 'POST')).toBe('network error');
    expect(await send(page, 'GET', '/api/report')).toBe('network error');
    expect(server.writes()).toEqual([]);
    expect(guard.record()).toMatchObject({ installed: true, policy: 'read-only', blocked: 2 });
  });

  test('locks the request fixture of the page it is handed', async ({ context, page }) => {
    const server = await serve(context);
    await initPage({ page });

    await expect(page.request.post(`${APP}/api/items`, { data: {} }))
      .rejects.toThrow('write-guard: post through APIRequestContext is refused under read-only');
    expect(server.writes()).toEqual([]);
  });

  test('called twice, or for every tab, it installs once', async ({ context, page }) => {
    const server = await serve(context);
    const [a, b] = await Promise.all([initPage({ page }), initPage({ page })]);
    const tab = await context.newPage();
    const c = await initPage({ page: tab });
    expect(b).toBe(a);
    expect(c).toBe(a);

    await tab.goto(`${APP}/`);
    expect(await send(tab, 'POST')).toBe('network error');
    expect(server.writes()).toEqual([]);
    // One guard, so one event for one blocked request.
    expect(a.record()).toMatchObject({ blocked: 1 });
  });
});
