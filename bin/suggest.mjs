#!/usr/bin/env node
// playwright-write-guard-suggest: draft `allow` entries from an audit log. Reads one file, writes none.

import { readFileSync } from 'node:fs';

const USAGE = 'usage: playwright-write-guard-suggest <log.jsonl>';

const args = process.argv.slice(2);
let text;
try {
  if (args.length !== 1) throw new Error('usage');
  text = readFileSync(args[0], 'utf8');
} catch {
  console.error(USAGE);
  process.exit(1);
}

const KEPT = new Set(['observe', 'block', 'mocked']);
const groups = new Map();
for (const line of text.split(/\r\n|\r|\n/)) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  if (e === null || typeof e !== 'object' || typeof e.method !== 'string' || e.method === '') continue;
  if (e.kind !== 'request' || !KEPT.has(e.action)) continue;
  let u;
  try {
    u = new URL(e.url);
  } catch {
    continue;
  }
  const path = u.origin + u.pathname;
  const key = JSON.stringify([e.method, path]);
  const g = groups.get(key) ?? { method: e.method, path, count: 0, nextAction: false };
  g.count++;
  if (Array.isArray(e.headerNames) && e.headerNames.includes('next-action')) g.nextAction = true;
  groups.set(key, g);
}

const rows = [...groups.values()].map((g) => ({
  ...g,
  url: '^' + g.path.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') + '(?:[?#]|$)',
}));
// Code unit order, as Array.prototype.sort compares strings by default.
rows.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : 0));

console.log(JSON.stringify({ allow: rows.map(({ method, url }) => ({ method, url })) }, null, 2));
for (const g of rows) {
  const hint = g.nextAction
    ? ': carries next-action, pin its action IDs with a headers entry'
    : g.path.endsWith('/graphql') ? ': GraphQL, add an anchored body pattern' : '';
  console.error(`${g.count} x ${g.method} ${g.path}${hint}`);
}
