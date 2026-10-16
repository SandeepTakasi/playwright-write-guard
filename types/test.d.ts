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
  /**
   * Settable with `test.use`. Default `false`. When `true`, a test fails if its guard, or a
   * context made in the test, recorded a blocked event: after every record is attached, the
   * fixture throws `write-guard: <n> blocked event(s) and writeGuardFailOnBlocked is set: <items>`
   * (the first 5 blocked events as `request <METHOD> <URL>`, `control "<label>"` or `websocket <URL>`).
   * Mocked, suspect and observed events never count, and neither do sends that are not recorded.
   */
  writeGuardFailOnBlocked: boolean;
}

export declare const test: TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & WriteGuardOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
>;

export { expect } from '@playwright/test';
