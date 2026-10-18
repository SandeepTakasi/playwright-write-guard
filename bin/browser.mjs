#!/usr/bin/env node
// playwright-write-guard-browser: start a guarded Chromium and print how an agent attaches.

import { parseArgs } from 'node:util';
import { PLAYWRIGHT_MCP_VERSION, startGuardedBrowser } from '../src/browser.mjs';
import { loadConfig } from '../src/install.mjs';

const USAGE = 'usage: playwright-write-guard-browser [--config <path>] [--headed] [--host <h>] [--port <n>] [--storage-state <path>] [--proxy <url>] [--ignore-https-errors] [--print-mcp-config]';

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      config: { type: 'string' },
      headed: { type: 'boolean' },
      host: { type: 'string' },
      port: { type: 'string' },
      'storage-state': { type: 'string' },
      proxy: { type: 'string' },
      'ignore-https-errors': { type: 'boolean' },
      'print-mcp-config': { type: 'boolean' },
    },
  }));
} catch {
  args = null;
}
const port = args?.port === undefined ? 0 : Number(args.port);
if (!args || !Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(USAGE);
  process.exit(1);
}

let guarded;
try {
  guarded = await startGuardedBrowser({
    config: loadConfig(args.config),
    headless: !args.headed,
    host: args.host ?? '127.0.0.1',
    port,
    storageState: args['storage-state'],
    proxy: args.proxy === undefined ? undefined : { server: args.proxy },
    ignoreHTTPSErrors: args['ignore-https-errors'],
  });
} catch (err) {
  console.error(err?.message ?? String(err));
  process.exit(1);
}

const ws = guarded.wsEndpoint;
const file = guarded.guard.record().config_file;
console.log(file === null ? 'config: none, using the defaults' : `config: ${file}`);
console.log(`endpoint: ${ws}`);
if (args['print-mcp-config']) {
  // The version the docs say both attach modes were checked with.
  const mcp = { mcpServers: { playwright: { command: 'npx', args: ['-y', `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, '--endpoint', ws] } } };
  console.log("MCP config (paste into your client's MCP settings):");
  console.log(JSON.stringify(mcp, null, 2));
}
console.log('Attach one of:');
console.log(`  Playwright MCP: --endpoint ${ws} (without --isolated, which would make a new, unguarded context)`);
console.log(`  Playwright CLI: playwright-cli attach --endpoint=${ws}`);
console.log('Stop with Ctrl+C.');

// Playwright's own signal handlers close the browser and exit 130; this process closes it
// itself and exits 0, so they go.
process.removeAllListeners('SIGINT');
process.removeAllListeners('SIGTERM');
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await guarded.close().catch((err) => console.error(err?.message ?? String(err)));
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
