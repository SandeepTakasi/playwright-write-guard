// playwright-write-guard/test: Playwright Test's `test` and `expect`, with every context guarded.
//
// The test's own context is guarded with `install` (which also locks context.request and
// page.request under read-only). Worker-level locks refuse the Playwright APIs that would make
// a context, a request client or a connection the guard cannot see (newContext, newPage,
// request.newContext, the global fetch, and the launch and connect family) while a guarded test
// or hook runs. Nothing else is refused: Node's own http, https and net are not seen.
// Playwright's own creation of the test's context (and, under observe, of the request
// fixture) is the one exception, and the window that allows it is shut again straight after.

import { test as base, expect } from '@playwright/test';
import { compileConfig } from './core.mjs';
import { install, loadConfig } from './install.mjs';

// Open only while Playwright builds this test's context, or its request fixture.
let contextWindow = false;
let requestWindow = false;

const refuse = (what) => new Error(
  `write-guard: ${what} is refused: it would make a context, request client or connection the guard cannot see. `
  + 'Drive the app through the test\'s own page and context.');

export const test = base.extend({
  // The guard's config. Evaluated when a test first needs it, so a bad config file is that
  // test's error rather than a failure to load the file. `test.use` replaces it, used as given.
  writeGuardConfig: [async ({}, use) => { await use(loadConfig()); }, { option: true }],

  // A service worker can send requests the guard's route never sees.
  serviceWorkers: 'block',

  // Once per worker. It depends on `browser`, so Playwright has launched its own browser
  // before the launch family is locked.
  _writeGuardWorker: [async ({ browser, playwright }, use) => {
    const restore = [];
    const lock = (obj, name, label, open = () => false) => {
      if (typeof obj?.[name] !== 'function') return;
      const original = obj[name];
      restore.push(() => { obj[name] = original; });
      obj[name] = async (...args) => {
        if (open()) return original.apply(obj, args);
        throw refuse(label);
      };
    };
    lock(browser, 'newContext', 'browser.newContext()', () => contextWindow);
    lock(browser, 'newPage', 'browser.newPage()');
    lock(playwright.request, 'newContext', 'request.newContext()', () => requestWindow);
    lock(globalThis, 'fetch', 'fetch() (Node\'s own, from the test)');
    for (const type of [playwright.chromium, playwright.firefox, playwright.webkit]) {
      for (const method of ['launch', 'launchPersistentContext', 'launchServer', 'connect', 'connectOverCDP']) {
        lock(type, method, `${type.name()}.${method}()`);
      }
    }
    try {
      await use();
    } finally {
      for (const r of restore.reverse()) r();
    }
  }, { scope: 'worker', auto: true }],

  // Set up before the auto fixture below forces the context, so the window is open exactly
  // while Playwright builds this test's context, and shut whatever happens.
  _writeGuardOpen: [async ({}, use) => {
    contextWindow = true;
    try { await use(); } finally { contextWindow = false; }
  }, { auto: true }],

  // Every guarded test gets the built-in context, used or not, so the window always closes in
  // the context fixture below rather than staying open through a test that never asked for a page.
  _writeGuardContext: [async ({ context }, use) => { await use(); }, { auto: true }],

  // Wraps the built-in context rather than creating one, so storageState, video and trace
  // settings all survive.
  context: async ({ context, writeGuardConfig, serviceWorkers }, use, testInfo) => {
    contextWindow = false;
    // install cannot change how the context was created; a project that asked for service
    // workers made a context the guard cannot fully see.
    if (serviceWorkers !== 'block') {
      throw new Error(`write-guard: serviceWorkers is '${serviceWorkers}'; the guard needs 'block', or a service worker can send requests it never sees`);
    }
    const guard = await install(context, { ...writeGuardConfig, log: null });
    try {
      await use(context);
    } finally {
      await testInfo.attach('write-guard.json', { body: JSON.stringify(await guard.close(), null, 2), contentType: 'application/json' });
    }
  },

  // Playwright builds the request fixture with request.newContext(), so under observe the
  // window opens for that. Fixtures are set up in parameter order, so this one comes first.
  // Under read-only this is where the fixture is refused, at setup, before anything is built.
  _writeGuardRequestWindow: async ({ writeGuardConfig }, use) => {
    if (compileConfig(writeGuardConfig).policy === 'read-only') {
      throw new Error('write-guard: the request fixture is refused under read-only');
    }
    requestWindow = true;
    try { await use(); } finally { requestWindow = false; }
  },

  request: async ({ _writeGuardRequestWindow, request }, use) => {
    requestWindow = false;
    await use(request);
  },
});

export { expect };
