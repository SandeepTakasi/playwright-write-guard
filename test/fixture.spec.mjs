// The Playwright Test fixture, end to end in Chromium. Every page and API is served by a real
// node:http server on 127.0.0.1, so these tests need no outside network and "never reaches the
// server" is read from what that server actually received. Specs here use ordinary clicks and
// fetches: the guard has to stop writes with no help from them.

import { request as apiRequest, chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test, expect } from '../src/fixture.mjs';

// The servers a test started, closed after it.
const servers = [];

test.afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => { s.close(done); s.closeAllConnections(); })));
});

// A real server on a free port of 127.0.0.1, recording every request that reaches it. The page
// loads from its origin, past anything a route in the browser could answer.
async function serve(page, body) {
  const seen = [];
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    seen.push(`${req.method} ${pathname}`);
    req.resume();
    if (pathname.startsWith('/api/')) return res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    if (pathname.endsWith('.js')) return res.writeHead(200, { 'content-type': 'text/javascript' }).end('');
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><body>${body}</body></html>`);
  });
  servers.push(server);
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${origin}/items`);
  return { origin, seen, writes: () => seen.filter((s) => !s.startsWith('GET ')) };
}

const COUNTER = `<script>
  window.counts = {};
  function bump(id) { counts[id] = (counts[id] || 0) + 1; document.getElementById(id).textContent = String(counts[id]); }
</script>`;

// A harmless button that runs `code` on click and reports the outcome in #state.
const ACT = (code) => `<button id="go">Go</button><span id="state">idle</span>
<script>
  const done = (s) => { document.getElementById('state').textContent = s; };
  document.getElementById('go').addEventListener('click', () => { ${code} });
</script>`;

// The refusals that hold under both policies: every way to get a context, request client or
// connection the guard does not sit in front of.
function refusals() {
  test('contexts, request clients and connections outside the guard are refused', async ({ page, browser, playwright }) => {
    await serve(page, '<p>Items</p>');
    const refused = /^write-guard: /;
    await expect(browser.newContext()).rejects.toThrow(refused);
    await expect(browser.newPage()).rejects.toThrow(refused);
    await expect(playwright.request.newContext()).rejects.toThrow(refused);
    await expect(apiRequest.newContext()).rejects.toThrow(refused);
    // Port 9 would refuse the connection anyway; the assertion is on the guard's message.
    await expect(fetch('http://127.0.0.1:9/api/items', { method: 'POST', body: '{}' })).rejects.toThrow(refused);
    for (const type of [chromium, playwright.firefox, playwright.webkit]) {
      await expect(type.launch()).rejects.toThrow(refused);
      await expect(type.launchPersistentContext('')).rejects.toThrow(refused);
      await expect(type.launchServer()).rejects.toThrow(refused);
      await expect(type.connect('ws://127.0.0.1:9')).rejects.toThrow(refused);
      await expect(type.connectOverCDP('http://127.0.0.1:9')).rejects.toThrow(refused);
    }
  });

  test.describe('a page made in beforeAll', () => {
    // Playwright's documented way to share a page across serial tests; it must not escape the guard.
    let made;
    test.beforeAll(async ({ browser }) => {
      made = await browser.newPage().then(() => 'made an unguarded page', (e) => e);
    });

    test('browser.newPage in beforeAll is refused', () => {
      expect(made).toBeInstanceOf(Error);
      expect(made.message).toMatch(/^write-guard: /);
    });
  });
}

test.describe('read-only', () => {
  test.use({ writeGuardConfig: { policy: 'read-only' } });

  test('a page that is only read loads and works', async ({ page }) => {
    const server = await serve(page, `${COUNTER}<button onclick="bump('opened')">Open details</button><span id="opened">0</span>`);
    await page.getByRole('button', { name: 'Open details' }).click();
    await expect(page.locator('#opened')).toHaveText('1');
    expect(await page.evaluate(() => fetch('/api/items').then((r) => r.text()))).toBe('ok');
    expect(server.seen).toContain('GET /api/items');
    expect(server.writes()).toEqual([]);
  });

  test('a fetch POST is blocked and never reaches the server', async ({ page }) => {
    const server = await serve(page, ACT(`fetch('/api/items', { method: 'POST', body: '{}' }).then(() => done('reached'), () => done('failed'));`));
    await page.click('#go');
    await expect(page.locator('#state')).toHaveText('failed');
    expect(server.writes()).toEqual([]);
  });

  test('a test can mock a write with page.route', async ({ page }) => {
    const server = await serve(page, ACT(`fetch('/api/items', { method: 'POST', body: '{}' }).then((r) => r.text()).then(done, () => done('failed'));`));
    // The test's own route answers the write, so it is a mock and never the real server.
    await page.route('**/api/items', (route) => route.fulfill({ status: 201, contentType: 'application/json', body: '{"mocked":true}' }));
    await page.click('#go');
    await expect(page.locator('#state')).toHaveText('{"mocked":true}');
    expect(server.writes()).toEqual([]);
  });

  test('an XHR PUT is blocked and never reaches the server', async ({ page }) => {
    const server = await serve(page, ACT(`const x = new XMLHttpRequest(); x.open('PUT', '/api/items/1'); x.onload = () => done('reached'); x.onerror = () => done('failed'); x.send('{}');`));
    await page.click('#go');
    await expect(page.locator('#state')).toHaveText('failed');
    expect(server.writes()).toEqual([]);
  });

  test('a beacon is blocked and never reaches the server', async ({ page }) => {
    const server = await serve(page, ACT(`done(String(navigator.sendBeacon('/api/beacon', 'x')));`));
    const failed = page.waitForEvent('requestfailed', (r) => r.url().endsWith('/api/beacon'));
    await page.click('#go');
    // The page is told the beacon was queued; the network layer is what stops it.
    await expect(page.locator('#state')).toHaveText('true');
    expect((await failed).failure()?.errorText).toMatch(/ERR_BLOCKED_BY_CLIENT/);
    expect(server.writes()).toEqual([]);
  });

  test('a form submit is blocked and the page shows why', async ({ page }) => {
    const server = await serve(page, '<form method="post" action="/api/items"><button type="submit">Go</button></form>');
    const response = page.waitForResponse(`${server.origin}/api/items`);
    await page.getByRole('button', { name: 'Go' }).click();
    expect((await response).status()).toBe(403);
    await expect(page.locator('body')).toHaveText(`write-guard blocked POST ${server.origin}/api/items`);
    expect(server.writes()).toEqual([]);
  });

  test('a destructive click is refused before the app sees it', async ({ page }) => {
    await serve(page, `${COUNTER}
      <button onclick="bump('opened')">Open details</button><span id="opened">0</span>
      <button onclick="bump('deleted')">Delete item</button><span id="deleted">0</span>
      <form onsubmit="bump('saved'); return false"><button type="submit">Save</button></form><span id="saved">0</span>`);
    await page.getByRole('button', { name: 'Delete item' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Delete item' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Open details' }).click();
    await expect(page.locator('#opened')).toHaveText('1');
    await expect(page.locator('#deleted')).toHaveText('0');
    await expect(page.locator('#saved')).toHaveText('0');
  });

  test('page.request and context.request refuse to send', async ({ page, context }) => {
    const server = await serve(page, '<p>Items</p>');
    await expect(page.request.get(`${server.origin}/api/items`)).rejects.toThrow(/^write-guard: /);
    await expect(context.request.post(`${server.origin}/api/items`)).rejects.toThrow(/^write-guard: /);
  });

  test('service workers are blocked', async ({ page, context }) => {
    await serve(page, '<p>Items</p>');
    // Chromium accepts the registration of a blocked worker and never starts it. (Where
    // workers are allowed, this unroutable script makes the registration itself fail.)
    const outcome = await page.evaluate(() => navigator.serviceWorker.register('/sw.js').then(
      () => Promise.race([navigator.serviceWorker.ready.then(() => 'ready'), new Promise((r) => setTimeout(() => r('no worker'), 1000))]),
      (e) => `registration failed: ${e.name}`));
    expect(outcome).toBe('no worker');
    expect(context.serviceWorkers()).toEqual([]);
  });

  refusals();
});

test.describe('a config given with test.use is applied as given', () => {
  test.use({ writeGuardConfig: { allow: [{ method: 'POST', url: '^http://127[.]0[.]0[.]1:[0-9]+/api/read$' }] } });

  test('an allow-listed POST goes through and any other write is blocked', async ({ page }) => {
    const server = await serve(page, '<p>Items</p>');
    const post = (path) => page.evaluate((p) => fetch(p, { method: 'POST', body: '{}' }).then((r) => r.text(), () => 'failed'), path);
    expect(await post('/api/read')).toBe('ok');
    expect(await post('/api/write')).toBe('failed');
    expect(server.writes()).toEqual(['POST /api/read']);
  });
});

test.describe('observe', () => {
  test.use({ writeGuardConfig: { policy: 'observe' } });

  test.describe.serial('the record', () => {
    let earlier;

    test('writes go through and are recorded', async ({ page, request }, testInfo) => {
      earlier = testInfo;
      const server = await serve(page, `${COUNTER}<button onclick="bump('deleted')">Delete item</button><span id="deleted">0</span>`);
      // The request fixture works under observe.
      expect(typeof request.get).toBe('function');
      expect(await page.evaluate(() => fetch('/api/items', { method: 'POST', body: '{}' }).then((r) => r.text()))).toBe('ok');
      await page.getByRole('button', { name: 'Delete item' }).click();
      await expect(page.locator('#deleted')).toHaveText('1');
      expect(server.writes()).toEqual(['POST /api/items']);
    });

    test('that test attached its record as write-guard.json', () => {
      const attached = earlier.attachments.filter((a) => a.name === 'write-guard.json');
      expect(attached).toHaveLength(1);
      expect(attached[0].contentType).toBe('application/json');
      const record = JSON.parse(attached[0].body.toString());
      expect(record).toMatchObject({ installed: true, policy: 'observe', blocked: 0, observed: 2 });
      expect(record.events.map((e) => [e.kind, e.action])).toEqual([['request', 'observe'], ['control', 'observe']]);
    });
  });

  test.describe('the request fixture', () => {
    test.use({ writeGuardConfig: { policy: 'observe', log: null } });

    test('the request window closes after setup under observe', async ({ request, playwright }) => {
      expect(typeof request.get).toBe('function');
      await expect(playwright.request.newContext()).rejects.toThrow(/^write-guard: /);
    });
  });

  refusals();
});

// The parts that are only visible from outside a test: a test that fails at fixture setup,
// the config default read lazily, the environment. Each runs a small Playwright project.
test.describe('in a Playwright run of its own', () => {
  test.use({ writeGuardConfig: {} });
  test.setTimeout(120_000);

  const run = promisify(execFile);
  const cli = join(dirname(createRequire(import.meta.url).resolve('@playwright/test/package.json')), 'cli.js');
  const fixture = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../src/fixture.mjs')).href;

  async function playwrightRun(testInfo, { spec, env = {} }) {
    const dir = testInfo.outputPath('project');
    mkdirSync(dir, { recursive: true });
    const config = { testDir: '.', testMatch: '*.spec.mjs', retries: 0, workers: 1, use: { headless: true } };
    writeFileSync(join(dir, 'playwright.config.mjs'), `export default ${JSON.stringify(config)};\n`);
    // `home()` starts a real server for the nested spec and returns its origin; it is closed after each test.
    const prelude = `import { test, expect } from ${JSON.stringify(fixture)};
import { createServer } from 'node:http';
const homes = [];
const home = async () => {
  const s = createServer((q, r) => { q.resume(); r.writeHead(200, { 'content-type': 'text/html' }).end('<p>x</p>'); });
  homes.push(s);
  await new Promise((ready) => s.listen(0, '127.0.0.1', ready));
  return 'http://127.0.0.1:' + s.address().port;
};
test.afterEach(async () => { await Promise.all(homes.splice(0).map((s) => new Promise((done) => { s.close(done); s.closeAllConnections(); }))); });
`;
    writeFileSync(join(dir, 'nested.spec.mjs'), `${prelude}${spec}`);
    const inherited = Object.entries(process.env).filter(([k]) => !/^(PW_|PLAYWRIGHT_|TEST_|WRITE_GUARD_|FORCE_COLOR)/.test(k));
    const done = await run(process.execPath, [cli, 'test', '-c', dir, '--reporter=json', `--output=${join(dir, 'results')}`], {
      cwd: dir,
      env: { ...Object.fromEntries(inherited), FORCE_COLOR: '0', ...env },
    }).catch((e) => e);
    let report;
    try { report = JSON.parse(done.stdout); } catch { throw new Error(`no JSON report:\n${done.stdout}\n${done.stderr}`); }
    const flat = (suite) => [
      ...(suite.specs ?? []).map((s) => [s.title, s.tests[0].results.at(-1)]),
      ...(suite.suites ?? []).flatMap(flat),
    ];
    return Object.fromEntries(report.suites.flatMap(flat).map(([title, r]) => [title, { status: r.status, error: r.error?.message ?? '' }]));
  }

  const PROBE = `
    const post = async (page) => {
      await page.goto(await home());
      return page.evaluate(() => fetch('/api/items', { method: 'POST', body: '{}' }).then((r) => r.status, () => 'failed'));
    };`;

  test('the request fixture fails the test at setup under read-only', async ({}, testInfo) => {
    const results = await playwrightRun(testInfo, {
      spec: `
        test.use({ writeGuardConfig: { policy: 'read-only' } });
        test('uses request', async ({ request }) => {});`,
    });
    expect(results['uses request'].status).toBe('failed');
    expect(results['uses request'].error).toContain('write-guard: the request fixture is refused under read-only');
  });

  test('WRITE_GUARD_POLICY applies to the default config, not to one given with test.use', async ({}, testInfo) => {
    const results = await playwrightRun(testInfo, {
      env: { WRITE_GUARD_POLICY: 'observe' },
      spec: `${PROBE}
        test('default config', async ({ page }) => { expect(await post(page)).toBe(200); });
        test.describe('given', () => {
          test.use({ writeGuardConfig: { policy: 'read-only' } });
          test('used as given', async ({ page }) => { expect(await post(page)).toBe('failed'); });
        });`,
    });
    expect(results['default config']).toMatchObject({ status: 'passed' });
    expect(results['used as given']).toMatchObject({ status: 'passed' });
  });

  test('a bad config file fails the tests that read it, and no others', async ({}, testInfo) => {
    const bad = testInfo.outputPath('bad.json');
    writeFileSync(bad, '{ nope');
    const results = await playwrightRun(testInfo, {
      env: { WRITE_GUARD_CONFIG: bad },
      spec: `
        test('default config', async ({ page }) => {});
        test.describe('given', () => {
          test.use({ writeGuardConfig: {} });
          test('used as given', async ({ page }) => {});
        });`,
    });
    expect(results['default config'].status).toBe('failed');
    expect(results['default config'].error).toMatch(/write-guard: .*bad\.json: is not valid JSON/);
    expect(results['used as given'].status).toBe('passed');
  });

  test('a config naming a log leaves no log file behind', async ({}, testInfo) => {
    const results = await playwrightRun(testInfo, {
      spec: `
        test.describe.serial('blocked write', () => {
          test.use({ writeGuardConfig: { policy: 'read-only', log: 'write-guard.jsonl' } });
          let earlier;
          test('blocks a write', async ({ page }, info) => {
            earlier = info;
            await page.goto(await home());
            expect(await page.evaluate(() => fetch('/api/items', { method: 'POST', body: '{}' }).then((r) => r.status, () => 'failed'))).toBe('failed');
          });
          test('recorded the block', () => {
            const record = JSON.parse(earlier.attachments.find((a) => a.name === 'write-guard.json').body.toString());
            expect(record.blocked).toBeGreaterThan(0);
          });
        });`,
    });
    expect(results['blocks a write'].status).toBe('passed');
    expect(results['recorded the block'].status).toBe('passed');
    // The nested run's working directory is its project directory; a honoured log would be there.
    expect(existsSync(join(testInfo.outputPath('project'), 'write-guard.jsonl'))).toBe(false);
  });

  test('a test that allows service workers is refused', async ({}, testInfo) => {
    const results = await playwrightRun(testInfo, {
      spec: `
        test.use({ serviceWorkers: 'allow' });
        test('any test', async ({ page }) => {});`,
    });
    expect(results['any test'].status).toBe('failed');
    expect(results['any test'].error).toMatch(/^.*write-guard: .*serviceWorkers/s);
  });
});
