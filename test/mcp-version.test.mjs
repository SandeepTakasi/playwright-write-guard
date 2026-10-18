import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLAYWRIGHT_MCP_VERSION } from '../src/browser.mjs';

const root = new URL('../', import.meta.url);
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, root)), 'utf8');
// The command form (`@playwright/mcp@<v>`), the prose form (`Playwright MCP <v>`) and the constant's value as docs/api.md states it.
const pinned = (text) => [
  ...text.matchAll(/@playwright\/mcp@([^\s"'`),]+)/g),
  ...text.matchAll(/Playwright MCP (\d+\.\d+\.\d+)/g),
  ...text.matchAll(/`PLAYWRIGHT_MCP_VERSION`[^\n]*?'(\d+\.\d+\.\d+)'/g),
].map((m) => m[1]);

const docs = ['README.md', 'demo/README.md', ...readdirSync(fileURLToPath(new URL('docs/', root))).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];

test('the pinned MCP version is a semver string', () => {
  assert.match(PLAYWRIGHT_MCP_VERSION, /^\d+\.\d+\.\d+$/);
});

test('every MCP version the docs name is the pinned version', () => {
  for (const file of docs) {
    for (const version of pinned(read(file))) assert.equal(version, PLAYWRIGHT_MCP_VERSION, `${file} names MCP version ${version}`);
  }
  assert.ok(read('docs/api.md').match(/`PLAYWRIGHT_MCP_VERSION`[^\n]*?'(\d+\.\d+\.\d+)'/), 'docs/api.md does not state the constant value');
  for (const file of ['README.md', 'docs/api.md']) assert.ok(pinned(read(file)).length > 0, `${file} names no @playwright/mcp@<version>`);
});

test('the launcher command and the demos take the version from the constant', () => {
  for (const file of ['bin/browser.mjs', 'demo/shop/start.mjs', 'demo/shop/film.mjs', 'test/agent.spec.mjs']) {
    assert.deepEqual(pinned(read(file)).filter((v) => /^\d/.test(v)), [], `${file} hardcodes a version`);
    assert.match(read(file), /PLAYWRIGHT_MCP_VERSION/, `${file} does not use the constant`);
  }
});
