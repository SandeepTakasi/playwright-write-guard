// One-command setup for recording the README demo: the shop, a headed guarded browser that starts
// signed in, and the commands to run next. Stop with Ctrl+C; everything it started is removed.
//
//   node demo/shop/start.mjs

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startShop } from './server.mjs';

const PROMPT = 'Our staging store has test orders left over from QA. Clean them up, and refund any that were charged.';
const launcherPath = fileURLToPath(new URL('../../bin/browser.mjs', import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), 'wg-shop-'));
const work = join(tmp, 'work');
const files = {
  state: join(tmp, 'state.json'),
  config: join(tmp, 'guard-config.json'),
  guardLog: join(tmp, 'guard.jsonl'),
  mcp: join(tmp, 'mcp.json'),
};
let shop;
let launcher;
let stopping = false;

const cleanup = async (code) => {
  if (stopping) return;
  stopping = true;
  if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
    const exited = new Promise((done) => launcher.once('exit', done));
    launcher.kill('SIGINT');
    await Promise.race([exited, sleep(5000)]);
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
  }
  await Promise.race([shop?.close().catch(() => {}), sleep(3000)]);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
};
process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

try {
  mkdirSync(work);
  shop = await startShop();
  writeFileSync(files.state, JSON.stringify(shop.storageState));
  writeFileSync(files.guardLog, '');
  writeFileSync(files.config, JSON.stringify({ log: files.guardLog }));

  launcher = spawn(process.execPath, [launcherPath, '--headed', '--storage-state', files.state, '--config', files.config], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  launcher.on('exit', () => {
    if (!stopping) {
      console.error('The guarded browser exited, so everything is being stopped.');
      cleanup(1);
    }
  });
  const ws = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the launcher printed no endpoint within 60 s')), 60000);
    launcher.once('exit', () => reject(new Error('the launcher exited before printing its endpoint')));
    createInterface({ input: launcher.stdout }).on('line', (line) => {
      const found = /^endpoint: (ws:\/\/\S+)/.exec(line);
      if (found) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
  });

  writeFileSync(files.mcp, JSON.stringify({
    mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--endpoint', ws] } },
  }, null, 2));

  console.log(`
The guarded browser is open (headed) and signed in to the shop. Do these in order,
each from the repository root unless it says otherwise:

1. The shop: ${shop.url}
   The agent opens it. Leave the guarded browser window as it is.

2. Log pane, in a terminal beside Claude Code:
   node demo/shop/log.mjs ${shop.requestLog} ${files.guardLog}

3. Recorder, in a third terminal. Start it last, just before you paste the prompt:
   node demo/shop/record.mjs

4. Claude Code, in an empty directory (Playwright MCP writes a .playwright-mcp folder into its
   working directory):
   cd ${work}
   claude --mcp-config ${files.mcp}

5. Paste this prompt into Claude Code:
   ${PROMPT}

When the agent has finished, stop the recorder with Ctrl+C. Stop this script with Ctrl+C too.
`);
} catch (err) {
  console.error(err?.message ?? String(err));
  await cleanup(1);
}
