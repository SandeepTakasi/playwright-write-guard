// The store admin demo (demo/shop): a 127.0.0.1 app behind a session, its request log, and the
// log pane that prints what reached the server and what the guard refused.
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startShop } from '../demo/shop/server.mjs';
import { startGuardedBrowser } from '../src/browser.mjs';

const logPane = fileURLToPath(new URL('../demo/shop/log.mjs', import.meta.url));
const requests = (shop) => readFileSync(shop.requestLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const writes = (shop) => requests(shop).filter((r) => r.method !== 'GET');
const cookie = { cookie: 'session=staff' };

let shop;
test.beforeEach(async () => { shop = await startShop(); });
test.afterEach(async () => { await shop.close(); });

test('the store admin requires a session', async () => {
  const signIn = await fetch(`${shop.url}/orders`);
  expect(signIn.status).toBe(200);
  expect(await signIn.text()).toContain('Sign in');
  for (const [method, path] of [['GET', '/api/orders'], ['GET', '/api/customers'], ['DELETE', '/api/orders/1045']]) {
    expect((await fetch(`${shop.url}${path}`, { method })).status).toBe(401);
  }

  const orders = await (await fetch(`${shop.url}/api/orders`, { headers: cookie })).json();
  expect(orders).toHaveLength(12);
  expect(orders.filter((o) => o.test)).toHaveLength(4);
  expect(shop.storageState.cookies).toMatchObject([{ name: 'session', value: 'staff', domain: '127.0.0.1' }]);
  // The unauthenticated DELETE still reached the server, so it is logged.
  expect(requests(shop).map((r) => `${r.method} ${r.path}`)).toContain('DELETE /api/orders/1045');
  expect(requests(shop)[0]).toEqual({ at: expect.any(String), method: 'GET', path: '/orders' });
});

test('without the guard the store\'s buttons write', async ({ browser }) => {
  const context = await browser.newContext({ storageState: shop.storageState });
  try {
    const page = await context.newPage();
    await page.goto(`${shop.url}/orders`);
    await expect(page.locator('tbody tr')).toHaveCount(12);

    await page.getByRole('button', { name: 'Delete order #1047' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete order' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(11);

    await page.getByRole('button', { name: 'Refund order #1045' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^Refund/ }).click();
    await expect(page.getByRole('row', { name: /#1045/ })).toContainText('Refunded');

    await page.getByRole('checkbox', { name: 'Select order #1050' }).check();
    await page.getByRole('checkbox', { name: 'Select order #1052' }).check();
    await page.getByRole('button', { name: 'Delete selected' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete 2 orders' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(9);

    expect(writes(shop).map((r) => `${r.method} ${r.path}`)).toEqual([
      'DELETE /api/orders/1047', 'POST /api/orders/1045/refund', 'POST /api/orders/bulk-delete',
    ]);
  } finally {
    await context.close();
  }
});

test('a guarded agent can read orders but no write reaches the store', async () => {
  const g = await startGuardedBrowser({ storageState: shop.storageState, config: { log: null } });
  const client = await chromium.connect(g.wsEndpoint);
  try {
    const page = await client.contexts()[0].newPage();
    await page.goto(`${shop.url}/orders`);
    await expect(page.locator('tbody tr')).toHaveCount(12);
    await expect(page.getByRole('row', { name: /#1045/ })).toContainText('Test order');

    // The click layer refuses Delete and Delete selected, so no confirm dialog opens.
    await page.getByRole('button', { name: 'Delete order #1047' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.getByRole('checkbox', { name: 'Select order #1050' }).check();
    await page.getByRole('button', { name: 'Delete selected' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // Refund is a built-in destructive verb, so its click is refused too and no dialog opens.
    await page.getByRole('button', { name: 'Refund order #1045' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // The network layer still covers refunds and deletes sent without a click.
    const send = (path, method) => page.evaluate(([p, m]) => fetch(p, { method: m }).then((r) => r.status, () => 'failed'), [path, method]);
    expect(await send('/api/orders/1045/refund', 'POST')).toBe('failed');
    expect(await send('/api/orders/1045', 'DELETE')).toBe('failed');

    await page.goto(`${shop.url}/orders/1045`);
    await expect(page.getByRole('heading', { name: /#1045/ })).toBeVisible();

    const events = g.guard.record().events.filter((e) => e.action === 'block');
    expect(events.map((e) => (e.kind === 'control' ? `click ${e.label}` : `${e.method} ${new URL(e.url).pathname}`))).toEqual([
      'click Delete order #1047', 'click Delete selected', 'click Refund order #1045',
      'POST /api/orders/1045/refund', 'DELETE /api/orders/1045',
    ]);
    expect(requests(shop).some((r) => r.path === '/api/orders/1045')).toBe(true);
    expect(writes(shop)).toEqual([]);
    expect(await (await fetch(`${shop.url}/api/orders`, { headers: cookie })).json()).toHaveLength(12);
  } finally {
    await client.close().catch(() => {});
    await g.close();
  }
});

test('the log pane shows reads and refusals', async ({}, testInfo) => {
  const requestLog = testInfo.outputPath('requests.jsonl');
  const guardLog = testInfo.outputPath('guard.jsonl');
  // An earlier write is counted in the footer but not printed: the pane tails from the end.
  writeFileSync(requestLog, `${JSON.stringify({ at: 't', method: 'POST', path: '/api/old' })}\n`);

  const child = spawn(process.execPath, [logPane, requestLog, guardLog], { timeout: 15_000, env: { ...process.env, NO_COLOR: '1' } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const lines = () => out.split('\n').filter(Boolean);
  try {
    await expect.poll(lines).toContain('writes received by the server: 1');

    appendFileSync(requestLog, `${JSON.stringify({ at: 't', method: 'GET', path: '/api/orders' })}\n`);
    // The guard log does not exist until now; a partial line waits for its newline.
    const block = { kind: 'request', action: 'block', reason: 'DELETE is a write method', method: 'DELETE', url: 'http://127.0.0.1:1/api/orders/1045' };
    const json = JSON.stringify(block);
    writeFileSync(guardLog, json.slice(0, 20));
    await expect.poll(lines).toContain('server  GET /api/orders');
    appendFileSync(guardLog, `${json.slice(20)}\n`
      + `${JSON.stringify({ kind: 'control', action: 'block', reason: '"Delete" matches a destructive label', label: 'Delete' })}\n`
      + `${JSON.stringify({ kind: 'websocket', action: 'open', url: 'ws://127.0.0.1:1/' })}\n`);
    await expect.poll(lines).toContain('guard   refused "Delete"');
    appendFileSync(requestLog, `${JSON.stringify({ at: 't', method: 'DELETE', path: '/api/orders/1046' })}\n`);
    await expect.poll(lines).toContain('writes received by the server: 2');

    expect(lines()).toEqual([
      'writes received by the server: 1',
      'server  GET /api/orders',
      'guard   refused DELETE http://127.0.0.1:1/api/orders/1045: DELETE is a write method',
      'guard   refused "Delete"',
      'server  DELETE /api/orders/1046',
      'writes received by the server: 2',
    ]);
  } finally {
    child.kill();
  }
});
