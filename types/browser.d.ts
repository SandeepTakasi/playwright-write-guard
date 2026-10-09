// playwright-write-guard/browser: a guarded Chromium that an agent attaches to.

import type { Browser, BrowserContext } from 'playwright-core';
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

export function startGuardedBrowser(options?: GuardedBrowserOptions): Promise<GuardedBrowser>;
