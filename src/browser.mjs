// playwright-write-guard/browser: a guarded Chromium that an agent attaches to. The guard runs
// in this process, so an attached client cannot remove it. Its context.route overrides, its
// route.fetch() and any context other than this one are not seen (see the README's limits).

import { chromium } from 'playwright-core';
import { install, loadConfig } from './install.mjs';

export async function startGuardedBrowser({ config = loadConfig(), headless = true, host = '127.0.0.1', port = 0, title = 'write-guard', storageState, proxy, ignoreHTTPSErrors } = {}) {
  const browser = await chromium.launch({ headless });
  try {
    const contextOptions = { serviceWorkers: 'block' };
    for (const [key, value] of Object.entries({ storageState, proxy, ignoreHTTPSErrors })) {
      if (value !== undefined) contextOptions[key] = value;
    }
    const context = await browser.newContext(contextOptions);
    const guard = await install(context, config);
    const { endpoint } = await browser.bind(title, { host, port });
    return {
      wsEndpoint: endpoint,
      browser,
      context,
      guard,
      async close() {
        await guard.close();
        await context.close();
        await browser.close();
      },
    };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}
