// playwright-write-guard/browser: a guarded Chromium that an agent attaches to.

import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright-core';
import type { Config } from './core.js';
import type { GuardHandle } from './install.js';

export interface GuardedBrowserOptions {
  /** Default `loadConfig()`. */
  config?: Config;
  /** Default `true`. */
  headless?: boolean;
  /** Default `"127.0.0.1"`. */
  host?: string;
  /** Default `0`: the OS picks a free port. */
  port?: number;
  /** Default `"write-guard"`. */
  title?: string;
  /** A storage-state file path or object: the context starts with those cookies and local storage. Passed only when defined. */
  storageState?: BrowserContextOptions['storageState'];
  /** A Playwright proxy, for example `{ server: 'http://127.0.0.1:8080' }`. Passed only when defined. */
  proxy?: BrowserContextOptions['proxy'];
  /** Accept certificate errors, for example a self-signed certificate. Passed only when defined. */
  ignoreHTTPSErrors?: boolean;
}

export interface GuardedBrowser {
  /** The endpoint `browser.bind` returned, `ws://<host>:<port>/<id>`. */
  wsEndpoint: string;
  browser: Browser;
  /** The one guarded context; an attached client sees it as `contexts()[0]`. */
  context: BrowserContext;
  guard: GuardHandle;
  /** Flushes the guard's log, then closes the context and the browser. */
  close(): Promise<void>;
}

/** The Playwright MCP version the launcher's printed config and the demos pin; the version the guard was checked with. */
export const PLAYWRIGHT_MCP_VERSION: string;

export function startGuardedBrowser(options?: GuardedBrowserOptions): Promise<GuardedBrowser>;
