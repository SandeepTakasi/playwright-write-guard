// playwright-write-guard/init-page: the `browser.initPage` entry for Playwright MCP and the
// Playwright CLI. They load it with require(), so nothing it imports uses top-level await.

import { install, loadConfig } from './install.mjs';

/** Guards `page.context()` with `loadConfig()`; install() makes it once per context. */
export default async function initPage({ page }) {
  return install(page.context(), loadConfig());
}
