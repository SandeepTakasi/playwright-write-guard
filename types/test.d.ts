// playwright-write-guard/test: Playwright Test's `test` and `expect`, with every context guarded.

import type {
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestType,
} from '@playwright/test';
import type { Config } from './core.js';

export interface WriteGuardOptions {
  /** The guard's config, settable with `test.use`. Default `loadConfig()`. Its `log` is ignored: the fixture never writes a log file. */
  writeGuardConfig: Config;
}

export declare const test: TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & WriteGuardOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
>;

export { expect } from '@playwright/test';
