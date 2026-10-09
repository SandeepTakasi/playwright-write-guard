import { defineConfig, devices } from '@playwright/test';

// The package's own browser tests: fake hosts served by routes, so no network is needed.
export default defineConfig({
  testDir: 'test',
  testMatch: '*.spec.mjs',
  retries: 0,
  use: { headless: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
