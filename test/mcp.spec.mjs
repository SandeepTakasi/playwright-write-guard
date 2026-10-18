// Drives a real Playwright MCP over stdio against the guarded launcher. It reaches the npm
// registry, so it runs only when WRITE_GUARD_MCP names an @playwright/mcp version or dist-tag.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { startGuardedBrowser } from '../src/browser.mjs';
import { startDemoServer, demoStorageState } from '../demo/server.mjs';

const version = process.env.WRITE_GUARD_MCP;
const label = version ?? '(set WRITE_GUARD_MCP)';
test.skip(!version, 'set WRITE_GUARD_MCP to an @playwright/mcp version or dist-tag to run');

test(`Playwright MCP ${label} drives the guarded launcher and a Delete click is refused`, async () => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(join(tmpdir(), 'wg-mcp-'));
  let server, launcher, mcp;
  try {
    server = await startDemoServer({ port: 0 });
    launcher = await startGuardedBrowser({ storageState: demoStorageState, config: { log: null } });

    // cwd is a temp dir, so MCP's .playwright-mcp output never lands in the repo
    mcp = spawn('npx', ['-y', `@playwright/mcp@${version}`, '--endpoint', launcher.wsEndpoint], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    mcp.stderr.on('data', (d) => { stderr += d; });
    const pending = new Map();
    let id = 0;
    createInterface({ input: mcp.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const n = ++id;
      const t = setTimeout(() => reject(new Error(`${method} timed out; stderr: ${stderr.slice(-500)}`)), 120_000);
      pending.set(n, (m) => { clearTimeout(t); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); });
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
    const call = async (name, args) => {
      const r = await rpc('tools/call', { name, arguments: args });
      return (r.content || []).map((c) => c.text || '').join('\n');
    };

    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'write-guard-test', version: '0' } });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    // The element ref parameter is named differently across MCP versions: read it from the schema.
    const { tools } = await rpc('tools/list', {});
    const props = tools.find((t) => t.name === 'browser_click').inputSchema.properties;
    const refParam = ['target', 'ref'].find((k) => k in props);
    expect(refParam, `browser_click schema: ${JSON.stringify(props)}`).toBeTruthy();

    await call('browser_navigate', { url: server.url });
    await call('browser_wait_for', { text: 'First item' });
    const snap = await call('browser_snapshot', {});
    const ref = (snap.match(/button "Delete"[^\n]*?\[ref=(\w+)\]/) || [])[1];
    expect(ref, `no Delete button in snapshot:\n${snap.slice(0, 1500)}`).toBeTruthy();

    await call('browser_click', { element: 'Delete button for the first item', [refParam]: ref });

    await expect.poll(() => launcher.guard.record().events.some((e) => e.kind === 'control' && e.action === 'block' && /delete/i.test(e.label))).toBe(true);
    expect(server.stats().writes).toBe(0);
  } finally {
    if (mcp) {
      mcp.kill('SIGTERM');
      await new Promise((r) => { mcp.once('exit', r); setTimeout(r, 3000); });
      mcp.kill('SIGKILL');
    }
    await launcher?.close();
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
