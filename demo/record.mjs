// Records docs/demo.gif: an agent drives the signed-in demo through Playwright MCP attached to the
// guarded launcher, clicks Delete, and the server's write count stays 0.
//
//   node demo/record.mjs
//
// It installs @playwright/mcp@0.0.83 into a temp directory (npm registry access) and turns the
// screenshots into a GIF with Python 3 and Pillow (`python3` on PATH, or set PYTHON).

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startGuardedBrowser } from '../src/browser.mjs';
import { startDemoServer, demoStorageState } from './server.mjs';

const out = fileURLToPath(new URL('../docs/demo.gif', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'wg-record-'));
const framesDir = join(tmp, 'frames');
mkdirSync(framesDir);
const frames = [];
let server, guarded, client, mcp, capture;
let recording = false;
let ok = false;

// Frames are PNG screenshots; Pillow writes them as one looping GIF with their real durations.
const ENCODE = `import sys, json
from PIL import Image
out, spec = sys.argv[1], json.loads(sys.argv[2])
ims = [Image.open(f['file']).convert('RGB') for f in spec]
ims[0].save(out, save_all=True, append_images=ims[1:], duration=[f['ms'] for f in spec], loop=0, optimize=True)`;

try {
  // MCP runs from the temp directory: it writes a .playwright-mcp folder into its cwd.
  execFileSync('npm', ['init', '-y'], { cwd: tmp, stdio: 'pipe' });
  execFileSync('npm', ['i', '@playwright/mcp@0.0.83', '--no-audit', '--no-fund'], { cwd: tmp, stdio: 'pipe' });

  // The agent starts signed in: the launcher loads the session cookie from a storage-state file.
  const storageState = join(tmp, 'state.json');
  writeFileSync(storageState, JSON.stringify(demoStorageState));
  server = await startDemoServer();
  guarded = await startGuardedBrowser({ config: { log: null }, storageState, headless: true });

  // A second client on the same launcher records the agent's page.
  client = await chromium.connect(guarded.wsEndpoint);
  const context = client.contexts()[0];
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 560 });
  let refusal = '';
  page.on('console', (m) => { if (m.text().startsWith('write-guard refused')) refusal = m.text(); });

  // A caption bar drawn by this recorder (not by the app), hidden from the agent's snapshot.
  const caption = (lines, outline = false) => page.evaluate(({ lines, outline }) => {
    let bar = document.getElementById('recorder-caption');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'recorder-caption';
      bar.setAttribute('aria-hidden', 'true');
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;padding:10px 16px;background:#1d2330;color:#f4f6fa;'
        + 'font:14px/1.5 ui-monospace,Menlo,monospace;pointer-events:none;white-space:pre-wrap';
      document.body.append(bar);
    }
    bar.replaceChildren(...lines.map((t) => Object.assign(document.createElement('div'), { textContent: t })));
    if (outline) document.querySelector('#items button').style.outline = '3px solid #c62828';
  }, { lines, outline });

  mcp = spawn(join(tmp, 'node_modules', '.bin', 'playwright-mcp'), ['--endpoint', guarded.wsEndpoint], { cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  mcp.stderr.on('data', (d) => { stderr += d; });
  const pending = new Map();
  let id = 0;
  createInterface({ input: mcp.stdout }).on('line', (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const rpc = (method, params) => new Promise((res, rej) => {
    const n = ++id;
    const t = setTimeout(() => rej(new Error(`${method} timed out; stderr: ${stderr.slice(-500)}`)), 60000);
    pending.set(n, (m) => { clearTimeout(t); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return (r.content || []).map((c) => c.text || '').join('\n');
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo-recorder', version: '0' } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // The agent's steps, each held long enough to read.
  await call('browser_navigate', { url: server.url });
  await call('browser_wait_for', { text: 'First item' });
  if (!page.url().startsWith(server.url)) throw new Error(`the agent is not on the recorded page (${page.url()})`);
  await caption(['Agent (Playwright MCP on the guarded launcher)', `browser_navigate ${server.url}/  signed in from a storage-state file`]);
  recording = true;
  capture = (async () => {
    while (recording) {
      const t = Date.now();
      const file = join(framesDir, `frame-${String(frames.length).padStart(4, '0')}.png`);
      await page.screenshot({ path: file });
      frames.push({ file, t });
      await sleep(Math.max(0, 150 - (Date.now() - t)));
    }
  })();
  await sleep(2200);

  const snap = await call('browser_snapshot', {});
  const found = snap.match(/button "Delete"[^\n]*?\[ref=(\w+)\]/);
  if (!found) throw new Error(`no Delete button in the snapshot:\n${snap.slice(0, 1500)}`);
  await caption(['Agent: browser_snapshot', `found ${found[0]} on the first item`]);
  await sleep(2000);

  await caption(['Agent: browser_click', `${found[0]}  (delete the first item)`]);
  await sleep(1200);
  await call('browser_click', { element: 'Delete button for the first item', target: found[1] });
  await sleep(800);
  if (!refusal) throw new Error('the guard printed no refusal for the click');
  await caption(['Browser console:', refusal], true);
  await sleep(2500);

  const writes = server.stats().writes;
  await caption([`Browser console: ${refusal}`, `The server received ${writes} writes; the first item is still listed.`], true);
  await sleep(600);
  recording = false;
  await capture;
  console.log(`frames: ${frames.length}, writes received by the server: ${writes}`);
  if (writes !== 0) throw new Error('the server received a write');

  // Each frame lasts until the next one; the last is held about 2 seconds.
  const spec = frames.map((f, i) => ({ file: f.file, ms: i + 1 < frames.length ? frames[i + 1].t - f.t : 2000 }));
  execFileSync(process.env.PYTHON || 'python3', ['-c', ENCODE, out, JSON.stringify(spec)], { stdio: 'inherit' });
  console.log(`wrote ${out} (${statSync(out).size} bytes)`);
  ok = true;
} catch (err) {
  console.error(`ERROR ${err.message}`);
} finally {
  recording = false;
  await capture?.catch(() => {});
  if (mcp) {
    mcp.kill('SIGTERM');
    await sleep(1000);
    mcp.kill('SIGKILL');
  }
  await client?.close().catch(() => {});
  await guarded?.close().catch(() => {});
  await server?.close();
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
