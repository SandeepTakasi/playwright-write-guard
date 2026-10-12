import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/suggest.mjs', import.meta.url));
const USAGE = 'usage: playwright-write-guard-suggest <log.jsonl>\n';

const ev = (fields) => JSON.stringify({ kind: 'request', action: 'block', reason: 'r', at: '2026-01-01T00:00:00.000Z', ...fields });

// Writes `lines` as a log in a fresh directory and runs the command on it (or on `args`).
function run(lines, args) {
  const dir = mkdtempSync(join(tmpdir(), 'suggest-'));
  const file = join(dir, 'log.jsonl');
  if (lines) writeFileSync(file, lines.join('\n') + '\n');
  const r = spawnSync(process.execPath, [BIN, ...(args ?? [file])], { encoding: 'utf8', timeout: 10_000 });
  return { ...r, dir, allow: r.stdout ? JSON.parse(r.stdout).allow : undefined };
}

test('the README worked example is reproduced exactly', () => {
  const line = ev({ method: 'POST', url: 'https://app.example.test/graphql?op=1' });
  const r = run([line, line, line]);
  assert.equal(r.status, 0);
  assert.equal(
    r.stdout,
    '{\n  "allow": [\n    {\n      "method": "POST",\n      "url": "^https://app\\\\.example\\\\.test/graphql(?:[?#]|$)"\n    }\n  ]\n}\n',
  );
  assert.equal(r.stderr, '3 x POST https://app.example.test/graphql: GraphQL, add an anchored body pattern\n');
});

test('events group by method and by origin plus path; query and hash are dropped', () => {
  const r = run([
    ev({ method: 'POST', url: 'https://a.test/x?q=1' }),
    ev({ method: 'POST', url: 'https://a.test/x#h', action: 'observe' }),
    ev({ method: 'POST', url: 'https://a.test/x', action: 'mocked' }),
    ev({ method: 'PUT', url: 'https://a.test/x' }),
    ev({ method: 'POST', url: 'https://a.test/y' }),
    ev({ method: 'POST', url: 'https://b.test/x' }),
  ]);
  assert.deepEqual(r.allow.map((e) => [e.method, e.url]), [
    ['POST', '^https://a\\.test/x(?:[?#]|$)'],
    ['PUT', '^https://a\\.test/x(?:[?#]|$)'],
    ['POST', '^https://a\\.test/y(?:[?#]|$)'],
    ['POST', '^https://b\\.test/x(?:[?#]|$)'],
  ]);
  assert.equal(
    r.stderr,
    '3 x POST https://a.test/x\n1 x PUT https://a.test/x\n1 x POST https://a.test/y\n1 x POST https://b.test/x\n',
  );
});

test('every regex metacharacter in the origin and path is escaped, and the entry matches what it came from', () => {
  const url = 'http://127.0.0.1:3000/a.b+c*d(e)[f]|g$h^i?q=1';
  const r = run([ev({ method: 'POST', url })]);
  const u = new URL(url);
  const entry = r.allow[0].url;
  assert.ok(entry.startsWith('^http://127\\.0\\.0\\.1:3000/'));
  const re = new RegExp(entry);
  assert.ok(re.test(url));
  assert.ok(re.test(u.origin + u.pathname));
  assert.ok(!re.test(u.origin + u.pathname + 'x'));
  assert.ok(!re.test(u.origin + u.pathname.replace('a.b', 'aXb')));
  assert.equal(entry, '^' + (u.origin + u.pathname).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') + '(?:[?#]|$)');
});

test('the entry is anchored: it matches the path with a query or hash, not a longer path or a longer host', () => {
  const re = new RegExp(run([ev({ method: 'POST', url: 'https://a.test/api' })]).allow[0].url);
  assert.ok(re.test('https://a.test/api'));
  assert.ok(re.test('https://a.test/api?x=1'));
  assert.ok(re.test('https://a.test/api#x'));
  assert.ok(!re.test('https://a.test/api/more'));
  assert.ok(!re.test('https://a.test/apiv2'));
  assert.ok(!re.test('https://evil.test/?u=https://a.test/api'));
});

test('entries sort by url then method in code unit order, and the hints follow the same order', () => {
  const r = run([
    ev({ method: 'PUT', url: 'https://a.test/b' }),
    ev({ method: 'POST', url: 'https://a.test/b' }),
    ev({ method: 'DELETE', url: 'https://a.test/a' }),
    ev({ method: 'POST', url: 'https://a.test/B' }),
  ]);
  assert.deepEqual(r.allow.map((e) => e.method + ' ' + e.url), [
    'POST ^https://a\\.test/B(?:[?#]|$)',
    'DELETE ^https://a\\.test/a(?:[?#]|$)',
    'POST ^https://a\\.test/b(?:[?#]|$)',
    'PUT ^https://a\\.test/b(?:[?#]|$)',
  ]);
  assert.deepEqual(r.stderr.trimEnd().split('\n'), [
    '1 x POST https://a.test/B',
    '1 x DELETE https://a.test/a',
    '1 x POST https://a.test/b',
    '1 x PUT https://a.test/b',
  ]);
});

test('a group with next-action in any event headerNames gets the next-action hint, which wins over GraphQL', () => {
  const r = run([
    ev({ method: 'POST', url: 'https://a.test/graphql', headerNames: ['accept'] }),
    ev({ method: 'POST', url: 'https://a.test/graphql', headerNames: ['accept', 'next-action'] }),
    ev({ method: 'POST', url: 'https://a.test/page', headerNames: ['next-action'] }),
    ev({ method: 'POST', url: 'https://a.test/plain', headerNames: ['accept'] }),
    ev({ method: 'POST', url: 'https://a.test/nohdr' }),
  ]);
  assert.deepEqual(r.stderr.trimEnd().split('\n'), [
    '2 x POST https://a.test/graphql: carries next-action, pin its action IDs with a headers entry',
    '1 x POST https://a.test/nohdr',
    '1 x POST https://a.test/page: carries next-action, pin its action IDs with a headers entry',
    '1 x POST https://a.test/plain',
  ]);
});

test('the GraphQL hint needs the path to end with /graphql; the query does not count', () => {
  const r = run([
    ev({ method: 'POST', url: 'https://a.test/v1/graphql' }),
    ev({ method: 'POST', url: 'https://a.test/graphql/extra' }),
    ev({ method: 'POST', url: 'https://a.test/x?next=/graphql' }),
    ev({ method: 'POST', url: 'https://a.test/notgraphql' }),
  ]);
  assert.deepEqual(r.stderr.trimEnd().split('\n'), [
    '1 x POST https://a.test/graphql/extra',
    '1 x POST https://a.test/notgraphql',
    '1 x POST https://a.test/v1/graphql: GraphQL, add an anchored body pattern',
    '1 x POST https://a.test/x',
  ]);
});

test('allow and suspect events, events without a method, other kinds and bad lines are skipped', () => {
  const r = run([
    ev({ method: 'GET', url: 'https://a.test/ok', action: 'allow' }),
    ev({ method: 'GET', url: 'https://a.test/s', action: 'suspect' }),
    ev({ url: 'ws://a.test/sock' }),
    ev({ method: '', url: 'https://a.test/empty' }),
    ev({ method: 5, url: 'https://a.test/num' }),
    ev({ method: 'POST', url: 'not a url' }),
    ev({ method: 'POST' }),
    JSON.stringify({ kind: 'control', action: 'block', method: 'POST', label: 'Delete', url: 'https://a.test/c' }),
    JSON.stringify({ kind: 'websocket', action: 'open', url: 'ws://a.test/sock' }),
    '',
    '{not json',
    '[1,2]',
    'null',
    '7',
    ev({ method: 'PATCH', url: 'https://a.test/kept', action: 'mocked' }),
  ]);
  assert.deepEqual(r.allow, [{ method: 'PATCH', url: '^https://a\\.test/kept(?:[?#]|$)' }]);
  assert.equal(r.stderr, '1 x PATCH https://a.test/kept\n');
});

test('a next-action header on any event in a group keeps the hint', () => {
  const r = run([
    ev({ method: 'POST', url: 'https://a.test/x', headerNames: ['next-action'] }),
    ev({ method: 'POST', url: 'https://a.test/x', headerNames: ['content-type'] }),
    ev({ method: 'POST', url: 'https://a.test/x' }),
  ]);
  assert.equal(r.stderr, '3 x POST https://a.test/x: carries next-action, pin its action IDs with a headers entry\n');
});

test('bare carriage return line ends are split', () => {
  const lines = [ev({ method: 'POST', url: 'https://a.test/x' }), ev({ method: 'PUT', url: 'https://a.test/y' })];
  const lf = run(lines);
  const cr = run([lines.join('\r')]);
  assert.deepEqual(cr.allow.map((e) => e.method), ['POST', 'PUT']);
  assert.equal(cr.stdout, lf.stdout);
  assert.equal(cr.stderr, lf.stderr);
});

test('a second argument is a usage error even when the first file is readable', () => {
  const r = run([ev({ method: 'POST', url: 'https://a.test/x' })]);
  const file = join(r.dir, 'log.jsonl');
  const two = run(null, [file, file]);
  assert.equal(two.status, 1);
  assert.equal(two.stderr, USAGE);
  assert.equal(two.stdout, '');
});

test('nothing kept prints an empty allow and no hints, and exits 0', () => {
  const r = run([ev({ method: 'GET', url: 'https://a.test/s', action: 'suspect' })]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{\n  "allow": []\n}\n');
  assert.equal(r.stderr, '');
});

test('it never writes a file', () => {
  const r = run([ev({ method: 'POST', url: 'https://a.test/x' })]);
  assert.deepEqual(readdirSync(r.dir), ['log.jsonl']);
});

for (const [name, args] of [
  ['no argument', []],
  ['two arguments', ['a.jsonl', 'b.jsonl']],
  ['a missing file', [join(tmpdir(), 'suggest-no-such-file.jsonl')]],
  ['a directory', [tmpdir()]],
]) {
  test(`${name} prints the usage line to stderr, nothing to stdout, and exits 1`, () => {
    const r = run(null, args);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, USAGE);
    assert.equal(r.stdout, '');
  });
}
