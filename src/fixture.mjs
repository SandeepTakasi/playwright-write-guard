// playwright-write-guard/test: Playwright Test's `test` and `expect`, with every context guarded.
//
// The test's own context is guarded with `install`, which also judges each send through
// context.request and page.request. The `request` fixture's sends are judged too: by the test's
// guard in a test and its beforeEach and afterEach hooks, and with the config alone (recorded
// nowhere) in beforeAll and afterAll. While the test's own function runs, Node's global fetch is
// judged by the test's guard, and browser.newContext and browser.newPage return guarded contexts.
// Worker-level locks refuse request.newContext and the launch and connect family while a guarded
// test or hook runs, and newContext, newPage and fetch outside the test's own function. Node's
// own http, https and net are not seen. Playwright's own creation of the test's context and of
// the request fixture is the one exception, and the window that allows it is shut again straight
// after.

import { test as base, expect } from '@playwright/test';
import { compileConfig } from './core.mjs';
import { _judgeRequestClient, install, loadConfig } from './install.mjs';

// Open only while Playwright builds this test's context, or its request fixture.
let contextWindow = false;
let requestWindow = false;

// The running test's guard, its config, its testInfo and the guards of the contexts it made,
// set while the `context` fixture is up.
let current = null;

// True while the test's own function runs: not a hook, not a fixture's setup or teardown.
// Playwright 1.64 keeps the running step in a private field; anything else refuses.
const inTestFunction = () => {
  const r = current?.testInfo._timeoutManager?._running?.runnable;
  return r?.type === 'test' && !r.fixture;
};

const refuse = (what) => new Error(
  `write-guard: ${what} is refused: it would make a context, request client or connection the guard cannot see. `
  + 'Drive the app through the test\'s own page and context.');

const serviceWorkersError = (value) => new Error(
  `write-guard: serviceWorkers is '${value}'; the guard needs 'block', or a service worker can send requests it never sees`);

// A context made in the test's own function, guarded with the test's config before it is returned.
async function guardedContext(newContext, options = {}) {
  const { config, made } = current;
  if (options.serviceWorkers !== undefined && options.serviceWorkers !== 'block') throw serviceWorkersError(options.serviceWorkers);
  const context = await newContext({ ...options, serviceWorkers: 'block' });
  made.push(await install(context, { ...config, log: null }));
  return context;
}

export const test = base.extend({
  // The guard's config. Evaluated when a test first needs it, so a bad config file is that
  // test's error rather than a failure to load the file. `test.use` replaces it, used as given.
  writeGuardConfig: [async ({}, use) => { await use(loadConfig()); }, { option: true }],

  // Fail the test when its guard, or a context made in it, recorded a block.
  writeGuardFailOnBlocked: [false, { option: true }],

  // A service worker can send requests the guard's route never sees.
  serviceWorkers: 'block',

  // Once per worker. It depends on `browser`, so Playwright has launched its own browser
  // before the launch family is locked.
  _writeGuardWorker: [async ({ browser, playwright }, use) => {
    const restore = [];
    // `pass(original)` returns the function to call instead, or nothing to refuse.
    const lock = (obj, name, label, pass = () => null) => {
      if (typeof obj?.[name] !== 'function') return;
      const original = obj[name].bind(obj);
      const own = obj[name];
      restore.push(() => { obj[name] = own; });
      obj[name] = async (...args) => {
        const call = pass(original);
        if (call) return call(...args);
        throw refuse(label);
      };
    };
    lock(browser, 'newContext', 'browser.newContext()', (original) => {
      if (contextWindow) return original;
      return inTestFunction() ? (options) => guardedContext(original, options) : null;
    });
    // Playwright 1.64's newPage calls this.newContext, the guarded one above.
    lock(browser, 'newPage', 'browser.newPage()', (original) => (inTestFunction() ? original : null));
    lock(playwright.request, 'newContext', 'request.newContext()', (original) => (requestWindow ? original : null));
    lock(globalThis, 'fetch', 'fetch() (Node\'s own, outside the test function)',
      (original) => (inTestFunction() ? current.guard.guardFetch(original) : null));
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
  context: async ({ context, writeGuardConfig, writeGuardFailOnBlocked, serviceWorkers }, use, testInfo) => {
    contextWindow = false;
    // install cannot change how the context was created; a project that asked for service
    // workers made a context the guard cannot fully see.
    if (serviceWorkers !== 'block') throw serviceWorkersError(serviceWorkers);
    const guard = await install(context, { ...writeGuardConfig, log: null });
    const made = [];
    current = { guard, config: writeGuardConfig, testInfo, made };
    try {
      await use(context);
    } finally {
      current = null;
      const records = [];
      const attach = async (name, g) => {
        const record = await g.close();
        records.push(record);
        await testInfo.attach(name, { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
      };
      await attach('write-guard.json', guard);
      for (const [i, g] of made.entries()) await attach(`write-guard-${i + 2}.json`, g);
      if (writeGuardFailOnBlocked) {
        const blocked = records.flatMap((r) => r.events).filter((e) => e.action === 'block');
        // A request event without a method is a refused WebSocket.
        const item = (e) => (e.kind === 'control' ? `control "${e.label}"` : e.kind === 'request' && e.method ? `request ${e.method} ${e.url}` : `websocket ${e.url}`);
        if (blocked.length) {
          throw new Error(`write-guard: ${blocked.length} blocked event(s) and writeGuardFailOnBlocked is set: ${blocked.slice(0, 5).map(item).join('; ')}`);
        }
      }
    }
  },

  // Playwright builds the request fixture with request.newContext(), so the window opens for
  // that. Fixtures are set up in parameter order, so this one comes first.
  _writeGuardRequestWindow: async ({}, use) => {
    requestWindow = true;
    try { await use(); } finally { requestWindow = false; }
  },

  // Not dependent on `context`, which Playwright refuses in beforeAll and afterAll. Each call
  // is judged by the guard of the moment: the test's while its context is up, else the config alone.
  request: async ({ _writeGuardRequestWindow, request, writeGuardConfig, baseURL }, use) => {
    requestWindow = false;
    const unrecorded = _judgeRequestClient(request, compileConfig(writeGuardConfig), { baseURL });
    const client = () => (current ? current.guard.guardRequestClient(request, { baseURL }) : unrecorded);
    await use(new Proxy(request, {
      get: (obj, prop) => (typeof obj[prop] === 'function' ? (...args) => client()[prop](...args) : obj[prop]),
    }));
  },
});

export { expect };
