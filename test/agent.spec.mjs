// The two agent modes, end to end in Chromium. The launcher's client serves its pages with its
// own routes on the fake host https://app.test, and the launcher binds to 127.0.0.1, so these
// tests need no network.

import { test, expect, chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
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

  test('a client page.route continue still reaches the guard', async () => {
    const server = await serve(context);
    const page = await open(context);
    // The route turns the page's GET into a DELETE. Its continue() passes the overridden request
    // on, and the guard judges what would actually be sent.
    await page.route('**/api/**', (route) => route.continue({ method: 'DELETE' }));
    const failed = page.waitForEvent('requestfailed');

    expect(await send(page, 'GET')).toBe('network error');
    expect((await failed).failure().errorText).toMatch(/BLOCKED_BY_CLIENT/);
    expect(server.writes()).toEqual([]);
    expect(server.seen).toEqual(['GET /']);
    expect(launcher.guard.record()).toMatchObject({ blocked: 1 });
    expect(launcher.guard.record().events[0]).toMatchObject({ kind: 'request', action: 'block', method: 'DELETE', url: `${APP}/api/items` });
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

// A page and a text-frame echo socket on one 127.0.0.1 port: an https page could not open this
// ws:// socket (mixed content), so the page has to come from the same http origin.
async function serveEcho() {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><p>echo</p>');
  });
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // One masked client text frame of under 126 bytes is all the test sends; it comes back unmasked.
    socket.on('data', (frame) => {
      if ((frame[0] & 0x0f) === 8) return socket.end();
      const len = frame[1] & 0x7f;
      const mask = frame.subarray(2, 6);
      const text = Buffer.from(frame.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]));
      socket.write(Buffer.concat([Buffer.from([0x81, len]), text]));
    });
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('the launcher records a websocket open', async () => {
  const { server, origin } = await serveEcho();
  const g = await startGuardedBrowser({ port: 0, config: { log: null } });
  const client = await chromium.connect(g.wsEndpoint);
  try {
    const page = await client.contexts()[0].newPage();
    await page.goto(`${origin}/`);
    const url = `${origin.replace('http', 'ws')}/echo`;
    const echoed = await page.evaluate((u) => new Promise((resolve, reject) => {
      const ws = new WebSocket(u);
      ws.onopen = () => ws.send('hello');
      ws.onmessage = (e) => resolve(e.data);
      ws.onerror = () => reject(new Error('socket failed'));
    }), url);

    expect(echoed).toBe('hello');
    const { events } = g.guard.record();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: 'websocket', action: 'open', url, at: expect.any(String) });
  } finally {
    await client.close().catch(() => {});
    await g.close();
    await new Promise((done) => { server.close(done); server.closeAllConnections(); });
  }
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
    // Spy on both closes: close() must finish the guard before it starts closing the context.
    const order = [];
    const guardClose = g.guard.close.bind(g.guard);
    g.guard.close = async () => { order.push('guard:start'); const r = await guardClose(); order.push('guard:end'); return r; };
    const contextClose = g.context.close.bind(g.context);
    g.context.close = async (...a) => { order.push('context:start'); return contextClose(...a); };
    await g.close();
    closed = true;
    expect(order.slice(0, 3)).toEqual(['guard:start', 'guard:end', 'context:start']);
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines).toHaveLength(events.length);
    expect(lines.every((l) => l.action === 'block')).toBe(true);
  } finally {
    await client.close().catch(() => {});
    if (!closed) await g.close();
  }
});

test('the launcher defaults its config to loadConfig', async ({}, testInfo) => {
  const file = testInfo.outputPath('observe.json');
  writeFileSync(file, JSON.stringify({ policy: 'observe', log: null }));
  const saved = { c: process.env.WRITE_GUARD_CONFIG, p: process.env.WRITE_GUARD_POLICY };
  process.env.WRITE_GUARD_CONFIG = file;
  delete process.env.WRITE_GUARD_POLICY;
  let g;
  let client;
  try {
    g = await startGuardedBrowser({ port: 0 });
    client = await chromium.connect(g.wsEndpoint);
    const server = await serve(client.contexts()[0]);
    const page = await open(client.contexts()[0]);
    // Under the default read-only this POST is blocked and never reaches the client's route.
    expect(await send(page, 'POST')).toBe(SERVED);
    expect(server.writes()).toEqual(['POST /api/items']);
    expect(g.guard.record()).toMatchObject({ policy: 'observe' });
  } finally {
    for (const [k, v] of [['WRITE_GUARD_CONFIG', saved.c], ['WRITE_GUARD_POLICY', saved.p]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await client?.close().catch(() => {});
    await g?.close();
  }
});

test('close() closes the browser', async () => {
  const g = await startGuardedBrowser({ port: 0, config: { log: null } });
  expect(g.browser.isConnected()).toBe(true);
  await g.close();
  expect(g.browser.isConnected()).toBe(false);
});

test('the launcher binds under its title', async ({}, testInfo) => {
  // Playwright writes one descriptor per bound browser, with its title, into the server registry.
  const dir = testInfo.outputPath('registry');
  const saved = process.env.PWTEST_SERVER_REGISTRY;
  process.env.PWTEST_SERVER_REGISTRY = dir;
  let g;
  try {
    g = await startGuardedBrowser({ port: 0, title: 'items-run', config: { log: null } });
    const found = readdirSync(dir).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
    expect(found.map((d) => d.title)).toEqual(['items-run']);
    expect(found[0].endpoint).toBe(g.wsEndpoint);
  } finally {
    if (saved === undefined) delete process.env.PWTEST_SERVER_REGISTRY; else process.env.PWTEST_SERVER_REGISTRY = saved;
    await g?.close();
  }
});

// Spawns the command and resolves once it has printed everything up to its last line, so its
// signal handlers are in place.
async function runCommand(args, testInfo) {
  const config = testInfo.outputPath('config.json');
  writeFileSync(config, JSON.stringify({ log: null }));
  const child = spawn(process.execPath, [BIN, '--config', config, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  // 'close' comes after the output streams end, so stderr is complete once this resolves.
  const exited = new Promise((done) => child.on('close', (code, signal) => done({ code, signal })));
  let out = '';
  child.stdout.setEncoding('utf8');
  await new Promise((done, fail) => {
    child.stdout.on('data', (d) => { out += d; if (out.includes('Stop with Ctrl+C.\n')) done(); });
    child.on('exit', () => fail(new Error(`exited early: ${out}`)));
  });
  // The child swaps its signal handlers right after that last line; a signal that lands in
  // between would find none, so give it a moment.
  await new Promise((done) => setTimeout(done, 300));
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { err += d; });
  return { child, exited, stderr: () => err, stdout: () => out, config, endpoint: out.match(/^endpoint: (\S+)$/m)?.[1] };
}

test.describe('the command', () => {
  test('the command prints which config it loaded', async ({}, testInfo) => {
    const named = await runCommand(['--port', '0'], testInfo);
    try {
      expect(named.stdout().split('\n')[0]).toBe(`config: ${named.config}`);
    } finally {
      named.child.kill('SIGTERM');
    }
    expect(await named.exited).toEqual({ code: 0, signal: null });

    // No --config, no environment variable, and no write-guard.config.json in an empty directory.
    const cwd = testInfo.outputPath('empty');
    mkdirSync(cwd, { recursive: true });
    const env = { ...process.env };
    delete env.WRITE_GUARD_CONFIG;
    delete env.WRITE_GUARD_POLICY;
    const child = spawn(process.execPath, [BIN, '--port', '0'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, killSignal: 'SIGKILL' });
    const exited = new Promise((done) => child.on('close', (code, signal) => done({ code, signal })));
    try {
      let out = '';
      child.stdout.setEncoding('utf8');
      await new Promise((done, fail) => {
        child.stdout.on('data', (d) => { out += d; if (out.includes('Stop with Ctrl+C.\n')) done(); });
        child.on('exit', () => fail(new Error(`exited early: ${out}`)));
      });
      expect(out.split('\n')[0]).toBe('config: none, using the defaults');
    } finally {
      // The signal handlers are swapped right after the last line, so give them a moment.
      await new Promise((done) => setTimeout(done, 300));
      child.kill('SIGTERM');
    }
    expect(await exited).toEqual({ code: 0, signal: null });
  });

  test('the command honours --host and --port', async ({}, testInfo) => {
    const probe = net.createServer();
    await new Promise((done) => probe.listen(0, '127.0.0.1', done));
    const { port } = probe.address();
    await new Promise((done) => probe.close(done));

    // The second host differs from the default, so a command that ignored --host would show.
    for (const [host, shown] of [['127.0.0.1', '127.0.0.1'], ['::1', '[::1]']]) {
      const { child, exited, endpoint } = await runCommand(['--host', host, '--port', String(port)], testInfo);
      try {
        expect(endpoint.startsWith(`ws://${shown}:${port}/`)).toBe(true);
      } finally {
        child.kill('SIGTERM');
      }
      expect(await exited).toEqual({ code: 0, signal: null });
    }
  });

  test('the command exits 0 on SIGINT', async ({}, testInfo) => {
    const { child, exited, stderr } = await runCommand(['--port', '0'], testInfo);
    child.kill('SIGINT');
    expect(await exited).toEqual({ code: 0, signal: null });
    // If Playwright's own SIGINT handler were still in place it would close the browser at the
    // same time, and the command's own close would then report an error.
    expect(stderr()).toBe('');
  });

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
      const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('usage: playwright-write-guard-browser [--config <path>] [--headed] [--host <h>] [--port <n>]');
    }
  });

  test('an invalid --port prints the usage line', () => {
    const r = spawnSync(process.execPath, [BIN, '--port', 'abc'], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('usage: playwright-write-guard-browser [--config <path>] [--headed] [--host <h>] [--port <n>]');
  });

  test('a startup failure exits 1 with its message', ({}, testInfo) => {
    // The config file does not exist, so loadConfig throws before the browser starts.
    const env = { ...process.env };
    delete env.WRITE_GUARD_CONFIG;
    delete env.WRITE_GUARD_POLICY;
    const missing = testInfo.outputPath('missing.json');
    const r = spawnSync(process.execPath, [BIN, '--config', missing], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL', env });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^write-guard:/);
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

  test('judges the request client of the page it is handed', async ({ page }) => {
    // A request client skips routes, so it sends to a real server on 127.0.0.1.
    const seen = [];
    const server = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.end('ok'); });
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/items`;
      const guard = await initPage({ page });

      await expect(page.request.post(url, { data: {} }))
        .rejects.toThrow(`write-guard: POST ${url} through APIRequestContext is refused under read-only`);
      expect(await (await page.request.get(url)).text()).toBe('ok');
      expect(seen).toEqual(['GET /api/items']);
      expect(guard.record()).toMatchObject({ blocked: 1, events: [{ kind: 'request', action: 'block', method: 'POST', url, via: 'request-client' }] });
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
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
