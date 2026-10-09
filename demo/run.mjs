// One command, the whole pitch: an agent attaches to a guarded browser and tries to delete an
// item two ways. The demo server must end up with zero writes.
//
//   node demo/run.mjs

import { chromium } from 'playwright-core';
import { startGuardedBrowser } from '../src/browser.mjs';
import { startDemoServer } from './server.mjs';

const server = await startDemoServer();
const guarded = await startGuardedBrowser({ config: { log: null } });
let client;
let writes = -1;
let blocked = 0;

try {
  // Attach the way an agent does: connect to the endpoint and use the guarded context.
  client = await chromium.connect(guarded.wsEndpoint);
  const page = await client.contexts()[0].newPage();
  await page.goto(server.url);
  await page.getByRole('button', { name: 'Delete' }).first().waitFor();

  // 1. Click Delete: the guard refuses the click inside the page, so the app never sees it.
  await page.getByRole('button', { name: 'Delete' }).first().click();

  // 2. Skip the UI and send the DELETE from the page: the guard aborts it at the network.
  const outcome = await page.evaluate((url) =>
    fetch(`${url}/api/items/1`, { method: 'DELETE' }).then(
      (res) => `status ${res.status}`,
      (err) => `refused (${err.message})`,
    ), server.url);
  console.log(`fetch DELETE: ${outcome}`);

  writes = server.stats().writes;
  blocked = guarded.guard.record().blocked;
} finally {
  await client?.close().catch(() => {});
  await guarded.close().catch(() => {});
  await server.close();
}

console.log(`writes received by the server: ${writes}`);
console.log(`writes blocked by the guard: ${blocked}`);
process.exit(writes === 0 && blocked >= 2 ? 0 : 1);
