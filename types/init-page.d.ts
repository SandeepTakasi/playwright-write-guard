// playwright-write-guard/init-page: the `browser.initPage` entry for Playwright MCP and the Playwright CLI.

import type { Page } from 'playwright-core';
import type { GuardHandle } from './install.js';

/** Guards `page.context()` with `loadConfig()`; once per context, however many pages it is handed. */
declare function initPage(args: { page: Page }): Promise<GuardHandle>;

export default initPage;
