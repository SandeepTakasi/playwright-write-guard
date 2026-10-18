import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileConfig, decideControl, decideFrame, decideRequest, decideSuspect } from '../src/core.mjs';

const cfg = (raw) => compileConfig(raw);
const req = (method, url, body = null) => ({ method, url, body });
const ctl = (label, icons = []) => ({ label, icons });

// A GraphQL-style host: queries and mutations share one URL, only the body tells them apart.
const GRAPHQL = {
  writes: [
    { method: 'POST', url: '/graphql$', body: '"query"\\s*:\\s*"\\s*mutation\\b' },
    { method: 'DELETE', url: '/api/' },
    { method: '*', url: '/upload' },
  ],
  allow: [{ method: 'POST', url: '/api/search' }],
};
const MUTATION = JSON.stringify({ query: 'mutation Rename { rename(id: 1) { id } }' });
const QUERY = JSON.stringify({ query: 'query List { items { id } }' });

// --- compileConfig: defaults ------------------------------------------------------

test('compileConfig applies every default for null, undefined and {}', () => {
  for (const raw of [null, undefined, {}]) {
    const c = cfg(raw);
    assert.equal(c.policy, 'read-only');
    assert.deepEqual(c.allow, []);
    assert.deepEqual(c.writes, []);
    assert.ok(c.text instanceof RegExp);
    assert.deepEqual(c.icons, []);
    assert.equal(c.websockets, 'allow');
    assert.equal(c.log, 'write-guard.jsonl');
    assert.equal(c.logBodies, false);
    assert.deepEqual(c.graphql, []);
  }
});

test('unknown keys are ignored', () => {
  assert.doesNotThrow(() => cfg({ colour: 'red', controls: { other: 1 } }));
});

test('log can be turned off with null and set to a path', () => {
  assert.equal(cfg({ log: null }).log, null);
  assert.equal(cfg({ log: 'out/x.jsonl' }).log, 'out/x.jsonl');
});

test('policy observe and websockets block are accepted', () => {
  const c = cfg({ policy: 'observe', websockets: 'block' });
  assert.equal(c.policy, 'observe');
  assert.equal(c.websockets, 'block');
});

// --- compileConfig: the label pattern ----------------------------------------------

test('built-in verbs match as whole words, case-insensitive', () => {
  const { text } = cfg();
  assert.ok(text.test('Save'));
  assert.ok(text.test('DELETE item'));
  assert.ok(text.test('Log out'));
  assert.ok(text.test('sign out now'));
  assert.ok(!text.test('Saved searches'), 'saved is not save');
  assert.ok(!text.test('Payment history'), 'payment is not pay');
});

test('the 12 built-in verbs are present and every dropped one is absent', () => {
  const { text } = cfg();
  const verbs = ['save', 'delete', 'remove', 'publish', 'send', 'archive', 'pay', 'purchase', 'refund',
    'log out', 'sign out', 'logout'];
  assert.equal(verbs.length, 12);
  for (const v of verbs) assert.ok(text.test(v), v);
  const dropped = ['share', 'submit', 'upload', 'import', 'rename', 'duplicate', 'update', 'confirm',
    'invite', 'reset', 'restore', 'approve', 'reject'];
  for (const v of dropped) assert.ok(!text.test(v), v);
  assert.ok(!text.test('Reset filters'));
});

test('logout matches as a whole word, case-insensitive', () => {
  const { text } = cfg();
  assert.ok(text.test('Logout'));
  assert.ok(text.test('LOGOUT now'));
  assert.ok(!text.test('Logouts'));
});

test('logBodies defaults to false and accepts a boolean', () => {
  assert.equal(cfg().logBodies, false);
  assert.equal(cfg({ logBodies: false }).logBodies, false);
  assert.equal(cfg({ logBodies: true }).logBodies, true);
});

test('controls.text is added to the built-ins, never replacing them', () => {
  const c = cfg({ controls: { text: ['^Wipe all$', 'nuke'] } });
  assert.ok(c.text.test('Save'));
  assert.ok(c.text.test('NUKE it'));
  assert.ok(c.text.test('wipe all'));
  assert.ok(!c.text.test('wipe all now'));
});

test('defaultControls false drops the built-ins; with no text the pattern is null', () => {
  assert.equal(cfg({ defaultControls: false }).text, null);
  const c = cfg({ defaultControls: false, controls: { text: ['nuke'] } });
  assert.ok(c.text.test('nuke'));
  assert.ok(!c.text.test('Save'));
});

test('there are no built-in icons; controls.icons is passed through', () => {
  assert.deepEqual(cfg().icons, []);
  assert.deepEqual(cfg({ controls: { icons: ['icon-trash', 'fa-bomb'] } }).icons, ['icon-trash', 'fa-bomb']);
});

test('signatures compile with method, url and optional body', () => {
  const c = cfg(GRAPHQL);
  assert.equal(c.writes.length, 3);
  assert.equal(c.writes[0].method, 'POST');
  assert.ok(c.writes[0].url instanceof RegExp);
  assert.ok(c.writes[0].body instanceof RegExp);
  assert.equal(c.writes[1].body, null);
  assert.equal(c.allow.length, 1);
  assert.equal(cfg({ allow: [{ method: 'GET', url: 'x', body: null }] }).allow[0].body, null);
});

test('a signature without headers compiles to an empty headers list', () => {
  const c = cfg({ allow: [{ method: 'GET', url: 'x' }, { method: 'GET', url: 'y', headers: null }] });
  assert.deepEqual(c.allow[0].headers, []);
  assert.deepEqual(c.allow[1].headers, []);
});

test('signature headers compile to lower-case names with regex values', () => {
  const c = cfg({ allow: [{ method: 'POST', url: 'x', headers: { 'Next-Action': '^abc$', 'X-Y': 'z' } }] });
  const h = c.allow[0].headers;
  assert.deepEqual(h.map((e) => e.name), ['next-action', 'x-y']);
  assert.ok(h[0].value instanceof RegExp);
  assert.equal(h[0].value.flags, '');
});

test('any method token is compiled to upper case', () => {
  const c = cfg({ allow: [{ method: 'report', url: 'x' }, { method: 'M-Search', url: 'x' }, { method: 'post', url: 'x' }] });
  assert.deepEqual(c.allow.map((s) => s.method), ['REPORT', 'M-SEARCH', 'POST']);
  assert.equal(cfg({ writes: [{ method: '*', url: 'x' }] }).writes[0].method, '*');
});

// --- compileConfig: malformed configs ----------------------------------------------

const bad = (raw, path) => assert.throws(
  () => cfg(raw),
  (e) => e instanceof Error && e.message.startsWith(`write-guard: ${path}: `),
  path,
);

test('a config that is not an object throws at path config', () => {
  for (const raw of ['writes', 3, true, [], [{}]]) bad(raw, 'config');
});

test('policy, websockets and method outside their values throw', () => {
  bad({ policy: 'readonly' }, 'policy');
  bad({ policy: 'unrestricted' }, 'policy');
  bad({ websockets: 'deny' }, 'websockets');
  bad({ writes: [{ url: 'x' }] }, 'writes[0].method');
});

test('malformed methods throw with the contract message', () => {
  for (const method of ['', '1POST', 'PO ST', 'PO_ST', '-X', 'POST ', '**', 5, null, ['POST']]) {
    assert.throws(
      () => cfg({ allow: [{ method, url: 'x' }] }),
      { message: 'write-guard: allow[0].method: must be "*" or a method name' },
      String(method),
    );
  }
  bad({ writes: [{ method: 'GET', url: 'x' }, { method: 'a b', url: 'x' }] }, 'writes[1].method');
});

test('malformed headers throw with their paths', () => {
  for (const headers of ['x', 5, true, ['a']]) {
    assert.throws(
      () => cfg({ allow: [{ method: 'GET', url: 'x', headers }] }),
      { message: 'write-guard: allow[0].headers: must be an object' },
    );
  }
  bad({ writes: [{ method: 'GET', url: 'x', headers: { 'Next-Action': '' } }] }, 'writes[0].headers.Next-Action');
  bad({ writes: [{ method: 'GET', url: 'x', headers: { 'Next-Action': 5 } }] }, 'writes[0].headers.Next-Action');
  bad({ writes: [{ method: 'GET', url: 'x', headers: { 'Next-Action': null } }] }, 'writes[0].headers.Next-Action');
  bad({ allow: [{ method: 'GET', url: 'x', headers: { ok: 'a', 'X-Bad': '(' } }] }, 'allow[0].headers.X-Bad');
});

test('logBodies that is not a boolean throws', () => {
  for (const logBodies of ['yes', 1, null, 0, []]) {
    assert.throws(() => cfg({ logBodies }), { message: 'write-guard: logBodies: must be a boolean' });
  }
});

test('lists that are not lists throw', () => {
  bad({ allow: 'POST /api' }, 'allow');
  bad({ writes: {} }, 'writes');
  bad({ controls: { text: 'wipe' } }, 'controls.text');
  bad({ controls: { icons: 'fa-bomb' } }, 'controls.icons');
});

test('allow null is malformed, not treated as absent', () => {
  assert.throws(() => compileConfig({ allow: null }), /^Error: write-guard: allow: /);
});

test('a Sig that is not an object throws', () => {
  bad({ allow: ['POST /x'] }, 'allow[0]');
  bad({ writes: [{ method: 'GET', url: 'x' }, null] }, 'writes[1]');
});

test('a url or body that is not a string or does not compile throws', () => {
  bad({ writes: [{ method: 'POST', url: '(' }] }, 'writes[0].url');
  bad({ writes: [{ method: 'POST', url: '' }] }, 'writes[0].url');
  bad({ writes: [{ method: 'POST' }] }, 'writes[0].url');
  bad({ allow: [{ method: 'GET', url: 'x', body: '(' }] }, 'allow[0].body');
  bad({ allow: [{ method: 'GET', url: 'x', body: 5 }] }, 'allow[0].body');
});

test('controls, controls.text, controls.icons entries and defaultControls and log throw when malformed', () => {
  bad({ controls: ['wipe'] }, 'controls');
  bad({ controls: { text: ['ok', 'ok', '['] } }, 'controls.text[2]');
  bad({ controls: { text: [''] } }, 'controls.text[0]');
  bad({ controls: { icons: ['fa-bomb', 3] } }, 'controls.icons[1]');
  bad({ controls: { icons: [''] } }, 'controls.icons[0]');
  bad({ defaultControls: 'yes' }, 'defaultControls');
  bad({ log: '' }, 'log');
  bad({ log: 7 }, 'log');
});

// --- decideRequest -----------------------------------------------------------------

test('method default: reads are allowed, other methods are writes', () => {
  const c = cfg();
  for (const m of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(decideRequest(req(m, 'https://a.test/x'), c).action, 'allow', m);
  }
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(decideRequest(req(m, 'https://a.test/x'), c).action, 'block', m);
  }
});

test('the request method is compared upper-cased', () => {
  const c = cfg(GRAPHQL);
  assert.equal(decideRequest(req('get', 'https://a.test/x'), c).action, 'allow');
  assert.equal(decideRequest(req('post', 'https://a.test/x'), c).action, 'block');
  assert.equal(decideRequest(req('delete', 'https://a.test/api/1'), c).action, 'block');
});

test('a writes signature makes a GET a write', () => {
  const c = cfg({ writes: [{ method: 'GET', url: '/export[?]' }] });
  assert.equal(decideRequest(req('GET', 'https://a.test/export?id=1'), c).action, 'block');
  assert.equal(decideRequest(req('GET', 'https://a.test/list'), c).action, 'allow');
  assert.equal(decideRequest(req('OPTIONS', 'https://a.test/export?id=1'), c).action, 'allow', 'method must match');
});

test('method * in a signature matches any method', () => {
  const c = cfg({ writes: [{ method: '*', url: '/upload' }] });
  assert.equal(decideRequest(req('GET', 'https://a.test/upload'), c).action, 'block');
  assert.equal(decideRequest(req('HEAD', 'https://a.test/upload'), c).action, 'block');
});

test('an extension method signature matches that method in any case', () => {
  const c = cfg({ allow: [{ method: 'report', url: '/x$' }] });
  assert.equal(decideRequest(req('REPORT', 'https://a.test/x'), c).action, 'allow');
  assert.equal(decideRequest(req('report', 'https://a.test/x'), c).action, 'allow');
  assert.equal(decideRequest(req('PROPFIND', 'https://a.test/x'), c).action, 'block');
});

test('header signatures match case-insensitive names and need every header', () => {
  const c = cfg({ allow: [{ method: 'POST', url: '/x$', headers: { 'Next-Action': '^abc$' } }] });
  const r = (headers) => decideRequest({ method: 'POST', url: 'https://a.test/x', headers }, c).action;
  assert.equal(r({ 'next-action': 'abc' }), 'allow');
  assert.equal(r({ 'NEXT-ACTION': 'abc' }), 'allow');
  assert.equal(r({ 'Next-Action': 'abcd' }), 'block', 'value must match');
  assert.equal(r({ 'x-other': 'abc' }), 'block', 'header must be present');
  assert.equal(r({}), 'block');
  assert.equal(r(undefined), 'block');
  assert.equal(r(null), 'block', 'headers null means none');
  const two = cfg({ allow: [{ method: 'POST', url: '/x$', headers: { a: '1', b: '2' } }] });
  const t = (headers) => decideRequest({ method: 'POST', url: 'https://a.test/x', headers }, two).action;
  assert.equal(t({ A: '1', B: '2' }), 'allow');
  assert.equal(t({ A: '1' }), 'block');
});

test('a header signature needs every named header', () => {
  const c = cfg({ allow: [{ method: 'POST', url: '/x$', headers: { 'x-a': '.' } }] });
  const r = (headers) => decideRequest({ method: 'POST', url: 'https://a.test/x', headers }, c).action;
  assert.equal(r(undefined), 'block', 'no headers');
  assert.equal(r({}), 'block', 'no headers');
  assert.equal(r({ 'x-b': 'anything' }), 'block', 'only an unrelated header');
  assert.equal(r({ 'x-a': 'anything' }), 'allow');
});

test('a header value regex is case-sensitive and unanchored', () => {
  const c = cfg({ writes: [{ method: 'GET', url: '/x$', headers: { 'x-t': 'drop' } }] });
  const r = (v) => decideRequest({ method: 'GET', url: 'https://a.test/x', headers: { 'X-T': v } }, c).action;
  assert.equal(r('a drop b'), 'block');
  assert.equal(r('DROP'), 'allow');
});

test('an OPTIONS signature compiles and matches an OPTIONS request', () => {
  const c = cfg({ allow: [{ method: 'OPTIONS', url: '/x$' }] });
  assert.equal(c.allow[0].method, 'OPTIONS');
  assert.equal(decideRequest(req('OPTIONS', 'https://a.test/x'), c).action, 'allow');
});

test('writes always wins over allow', () => {
  const c = cfg({
    allow: [{ method: 'POST', url: '^https://a[.]test/graphql' }],
    writes: [{ method: 'POST', url: '/graphql$', body: 'mutation' }],
  });
  const r = (url, body) => decideRequest(req('POST', url, body), c);
  // A writes match beats an allow match, and names the first writes signature.
  assert.deepEqual(r('https://a.test/graphql', 'mutation x'),
    { action: 'block', reason: 'POST matches writes[0]; policy read-only' });
  // An allow match still allows a request no writes signature matches.
  assert.deepEqual(r('https://a.test/graphql', 'query x'),
    { action: 'allow', reason: 'allow[0] marks it a read' });
  // The method default is untouched: no match at all is a write for a non-read method.
  assert.deepEqual(r('https://a.test/other'),
    { action: 'block', reason: 'POST is not a read method; policy read-only' });
  assert.deepEqual(r('https://b.test/graphql', 'query x'),
    { action: 'block', reason: 'POST is not a read method; policy read-only' });
  assert.deepEqual(decideRequest(req('GET', 'https://a.test/x'), c),
    { action: 'allow', reason: 'GET is a read method and matches no writes signature' });
  // Under observe the writes match is observed, not allowed.
  const o = cfg({ policy: 'observe', allow: [{ method: '*', url: '^https://a[.]test/' }], writes: [{ method: 'POST', url: '/x$' }] });
  assert.deepEqual(decideRequest(req('POST', 'https://a.test/x'), o),
    { action: 'observe', reason: 'POST matches writes[0]; policy observe' });
});

test('an allow URL that matches the empty string is refused', () => {
  for (const url of ['.*', '^', 'x?', '(?:)', 'a|']) {
    assert.throws(
      () => cfg({ allow: [{ method: 'POST', url: '^/ok' }, { method: '*', url }] }),
      { message: 'write-guard: allow[1].url: matches the empty string, so it can match any URL' },
      url,
    );
    assert.throws(
      () => cfg({ allow: [{ method: '*', url }] }),
      { message: 'write-guard: allow[0].url: matches the empty string, so it can match any URL' },
      url,
    );
  }
  // An anchored or non-empty URL still compiles.
  assert.equal(cfg({ allow: [{ method: 'GET', url: '^https://a[.]test/' }, { method: 'GET', url: 'x' }] }).allow.length, 2);
});

test('a writes URL that matches the empty string still compiles', () => {
  for (const url of ['.*', '^', 'x?', '(?:)', 'a|']) {
    assert.equal(cfg({ writes: [{ method: 'GET', url }] }).writes.length, 1, url);
  }
  assert.equal(decideRequest(req('GET', 'https://a.test/x'), cfg({ writes: [{ method: 'GET', url: '.*' }] })).action, 'block');
});

test('a body signature separates a query from a mutation on one URL', () => {
  const c = cfg({ allow: [{ method: 'POST', url: '/graphql$', body: '"query"\\s*:\\s*"\\s*query\\b' }] });
  assert.equal(decideRequest(req('POST', 'https://a.test/graphql', QUERY), c).action, 'allow');
  assert.equal(decideRequest(req('POST', 'https://a.test/graphql', MUTATION), c).action, 'block');
});

test('a Sig body regex is case-sensitive', () => {
  const c = cfg({ writes: [{ method: 'GET', url: '/x$', body: 'drop' }] });
  assert.equal(decideRequest(req('GET', 'https://a.test/x', 'drop'), c).action, 'block');
  assert.equal(decideRequest(req('GET', 'https://a.test/x', 'DROP'), c).action, 'allow');
});

test('a Sig with a body never matches a request without one', () => {
  const g = cfg({ writes: [{ method: 'GET', url: '/graphql$', body: '.*' }] });
  assert.equal(decideRequest(req('GET', 'https://a.test/graphql', null), g).action, 'allow');
  assert.equal(decideRequest(req('GET', 'https://a.test/graphql', undefined), g).action, 'allow');
  assert.equal(decideRequest({ method: 'GET', url: 'https://a.test/graphql' }, g).action, 'allow');
  assert.equal(decideRequest(req('GET', 'https://a.test/graphql', 'x'), g).action, 'block');
  // an allow Sig with a body does not rescue a body-less POST
  const a = cfg({ allow: [{ method: 'POST', url: '/q', body: '.*' }] });
  assert.equal(decideRequest(req('POST', 'https://a.test/q', null), a).action, 'block');
});

test('url matching is unanchored and case-sensitive', () => {
  const c = cfg({ writes: [{ method: 'GET', url: '/Save$' }] });
  assert.equal(decideRequest(req('GET', 'https://a.test/save'), c).action, 'allow');
  assert.equal(decideRequest(req('GET', 'https://a.test/Save'), c).action, 'block');
});

test('policy observe records writes and lets them through', () => {
  const c = cfg({ policy: 'observe', writes: [{ method: 'GET', url: '/export' }] });
  assert.equal(decideRequest(req('DELETE', 'https://a.test/x'), c).action, 'observe');
  assert.equal(decideRequest(req('GET', 'https://a.test/export'), c).action, 'observe');
  assert.equal(decideRequest(req('GET', 'https://a.test/x'), c).action, 'allow');
});

test('decisions carry a non-empty reason', () => {
  const c = cfg();
  for (const d of [decideRequest(req('GET', 'https://a.test/x'), c), decideRequest(req('POST', 'https://a.test/x'), c),
    decideControl(ctl('Open'), c), decideControl(ctl('Delete'), c)]) {
    assert.equal(typeof d.reason, 'string');
    assert.ok(d.reason.length > 0);
  }
});

// --- decideControl -----------------------------------------------------------------

test('a destructive label blocks under read-only and observes under observe', () => {
  assert.equal(decideControl(ctl('Delete item'), cfg()).action, 'block');
  assert.equal(decideControl(ctl('Save'), cfg()).action, 'block');
  assert.equal(decideControl(ctl('Delete item'), cfg({ policy: 'observe' })).action, 'observe');
});

test('a Refund button is refused by the built-in verbs', () => {
  for (const label of ['Refund', 'Refund order #1050', 'Refund $86.50']) {
    assert.equal(decideControl(ctl(label), cfg()).action, 'block', label);
  }
  for (const label of ['Refunded', 'Refunds']) {
    assert.equal(decideControl(ctl(label), cfg()).action, 'allow', label);
  }
});

test('a harmless label is allowed under every policy', () => {
  for (const policy of ['read-only', 'observe']) {
    assert.equal(decideControl(ctl('Open details'), cfg({ policy })).action, 'allow', policy);
    assert.equal(decideControl(ctl('Saved searches'), cfg({ policy })).action, 'allow', policy);
  }
});

test('a built-in verb inside a longer word is not destructive', () => {
  const c = cfg({});
  assert.equal(decideControl(ctl('Unarchive'), c).action, 'allow');
  assert.equal(decideControl(ctl('Resend'), c).action, 'allow');
  assert.equal(decideControl(ctl('Archive'), c).action, 'block');
  assert.equal(decideControl(ctl('Send'), c).action, 'block');
});

test('an empty label never matches the label pattern', () => {
  assert.equal(decideControl(ctl(''), cfg()).action, 'allow');
  assert.equal(decideControl(ctl('   '), cfg()).action, 'allow');
  const c = cfg({ controls: { text: ['^$'] } });
  assert.equal(decideControl(ctl(''), c).action, 'allow');
});

test('an icon with a configured prefix makes a control destructive', () => {
  const c = cfg({ controls: { icons: ['icon-trash'] } });
  assert.equal(decideControl(ctl('', ['btn', 'icon-trash-outline']), c).action, 'block');
  assert.equal(decideControl(ctl('Open', ['btn', 'my-icon-trash']), c).action, 'allow', 'prefix, not substring');
  assert.equal(decideControl(ctl('', ['icon-trash']), cfg()).action, 'allow', 'no built-in icons');
});

test('with defaultControls false and no text only icons can match', () => {
  const c = cfg({ defaultControls: false, controls: { icons: ['icon-x'] } });
  assert.equal(decideControl(ctl('Delete'), c).action, 'allow');
  assert.equal(decideControl(ctl('', ['icon-x']), c).action, 'block');
});

// --- built-in click exceptions -----------------------------------------------------

test('built-in exceptions allow view-only labels', () => {
  const c = cfg();
  for (const label of ['Remove filter', 'Clear filters', 'clear search', 'Remove columns', '  Remove   filters  ']) {
    const d = decideControl(ctl(label), c);
    assert.equal(d.action, 'allow', label);
    assert.equal(d.reason, `"${label.trim()}" is a built-in read-only exception`, label);
  }
  assert.equal(decideControl(ctl('Remove filter'), cfg({ policy: 'observe' })).action, 'allow');
});

test('an exception must match the whole label', () => {
  const c = cfg();
  for (const label of ['Remove filter rule permanently', 'Save search', 'Send feedback', 'Remove filter and save',
    'Clear search and delete', 'Remove column data']) {
    assert.equal(decideControl(ctl(label), c).action, 'block', label);
  }
});

test('an icon match still refuses an excepted label', () => {
  const c = cfg({ controls: { icons: ['icon-trash'] } });
  assert.equal(decideControl(ctl('Remove filter', ['icon-trash']), c).action, 'block');
  assert.equal(decideControl(ctl('Remove filter', ['btn']), c).action, 'allow');
});

test('defaultExceptions false turns the exceptions off', () => {
  const c = cfg({ defaultExceptions: false });
  assert.equal(c.exceptions, null);
  assert.equal(decideControl(ctl('Remove filter'), c).action, 'block');
  assert.equal(decideControl(ctl('Remove columns'), c).action, 'block');
  assert.equal(decideControl(ctl('Clear search'), c).reason, 'not a destructive control');
  assert.ok(cfg({ defaultExceptions: true }).exceptions instanceof RegExp);
  assert.equal(cfg().exceptions.source, '^(?:(?:remove|clear)\\s+filters?|clear\\s+search|remove\\s+columns?)$');
  assert.equal(cfg().exceptions.flags, 'i');
  bad({ defaultExceptions: 'yes' }, 'defaultExceptions');
  assert.throws(() => cfg({ defaultExceptions: 'yes' }), { message: 'write-guard: defaultExceptions: must be a boolean' });
});

// --- websocketWrites and decideFrame -------------------------------------------------

test('websocketWrites defaults to an empty list and compiles one RegExp per source with no flags', () => {
  for (const raw of [null, undefined, {}, { websocketWrites: [] }]) assert.deepEqual(cfg(raw).websocketWrites, []);
  const w = cfg({ websocketWrites: ['"event":"delete_item"', 'drop|wipe'] }).websocketWrites;
  assert.equal(w.length, 2);
  for (const re of w) {
    assert.ok(re instanceof RegExp);
    assert.equal(re.flags, '');
  }
  assert.equal(w[0].source, '"event":"delete_item"');
});

test('malformed websocketWrites and suspectGets throw with the contract messages', () => {
  for (const key of ['websocketWrites', 'suspectGets']) {
    for (const v of ['x', {}, 5, null, true]) {
      assert.throws(() => cfg({ [key]: v }), { message: `write-guard: ${key}: must be a list` }, `${key} ${String(v)}`);
    }
    for (const v of ['', 5, null, undefined, {}, ['x']]) {
      assert.throws(
        () => cfg({ [key]: ['ok', v] }),
        { message: `write-guard: ${key}[1]: must be a non-empty regex string` },
        `${key} ${String(v)}`,
      );
    }
    assert.throws(() => cfg({ [key]: ['('] }), (e) => e.message.startsWith(`write-guard: ${key}[0]: does not compile: `));
    assert.throws(() => cfg({ [key]: ['ok', 'ok', '['] }), (e) => e.message.startsWith(`write-guard: ${key}[2]: does not compile: `));
  }
  assert.throws(() => cfg({ websocketWrites: [5] }), { message: 'write-guard: websocketWrites[0]: must be a non-empty regex string' });
});

test('decideFrame blocks a matching string frame under read-only and observes under observe', () => {
  const raw = { websocketWrites: ['deleteItem', '"op":"save"'] };
  const ro = cfg(raw);
  const ob = cfg({ ...raw, policy: 'observe' });
  assert.equal(decideFrame('deleteItem 1', ro).action, 'block');
  assert.equal(decideFrame('{"op":"save","id":2}', ro).action, 'block', 'second pattern');
  assert.equal(decideFrame('xx deleteItem', ro).action, 'block', 'unanchored');
  assert.equal(decideFrame('deleteItem 1', ob).action, 'observe');
  assert.equal(decideFrame('listItems', ro).action, 'allow');
  assert.equal(decideFrame('listItems', ob).action, 'allow');
  assert.equal(decideFrame('DELETEITEM', ro).action, 'allow', 'case-sensitive');
  assert.equal(decideFrame('', ro).action, 'allow');
});

test('decideFrame allows every frame when websocketWrites is empty', () => {
  assert.equal(decideFrame('deleteItem 1', cfg()).action, 'allow');
  assert.equal(decideFrame('', cfg({ policy: 'observe' })).action, 'allow');
});

test('decideFrame allows a frame that is not a string, even when its text would match', () => {
  const c = cfg({ websocketWrites: ['.'] });
  const frames = [Buffer.from('deleteItem'), new Uint8Array([100, 101]), 5, null, undefined, { toString: () => 'deleteItem' }, ['deleteItem']];
  for (const f of frames) assert.equal(decideFrame(f, c).action, 'allow', String(f));
  assert.equal(decideFrame('x', c).action, 'block');
});

test('decideFrame carries a non-empty reason', () => {
  const c = cfg({ websocketWrites: ['a'] });
  for (const d of [decideFrame('a', c), decideFrame('b', c), decideFrame(Buffer.from('a'), c)]) {
    assert.equal(typeof d.reason, 'string');
    assert.ok(d.reason.length > 0);
  }
});

// --- suspectGets, defaultSuspectGets and decideSuspect ---------------------------------

const BUILTIN = '(?:^|[/._-])(?:(?:log|sign)[-_]?out|unsubscribe|confirm|delete|remove)(?:$|[/._?&#-])|[?&]action=';
const sus = (method, url, c = cfg()) => decideSuspect({ method, url }, c).suspect;

test('defaultSuspectGets and suspectGets: defaults, the compiled pattern, and null when empty', () => {
  const d = cfg().suspect;
  assert.ok(d instanceof RegExp);
  assert.equal(d.flags, 'i');
  assert.equal(d.source, `(?:${BUILTIN})`);
  assert.equal(cfg({ suspectGets: [] }).suspect.source, d.source);
  assert.equal(cfg({ defaultSuspectGets: true }).suspect.source, d.source);
  assert.equal(cfg({ defaultSuspectGets: false }).suspect, null);
  assert.equal(cfg({ defaultSuspectGets: false, suspectGets: [] }).suspect, null);
  const j = cfg({ defaultSuspectGets: false, suspectGets: ['x', 'a|b'] }).suspect;
  assert.equal(j.source, '(?:x)|(?:a|b)');
  assert.equal(j.flags, 'i');
  assert.equal(cfg({ suspectGets: ['x', 'y'] }).suspect.source, `(?:${BUILTIN})|(?:x)|(?:y)`);
});

test('defaultSuspectGets that is not a boolean throws', () => {
  for (const v of ['yes', 1, null, 0, []]) {
    assert.throws(() => cfg({ defaultSuspectGets: v }), { message: 'write-guard: defaultSuspectGets: must be a boolean' });
  }
});

test('the built-in suspect pattern: hits', () => {
  for (const url of ['https://a.test/logout', 'https://a.test/users/sign_out', 'https://a.test/sign-out',
    'https://a.test/unsubscribe?t=1', 'https://a.test/items?action=delete', 'https://a.test/items?x=1&action=save',
    'https://a.test/api/delete/7', 'https://a.test/confirm', 'https://a.test/x/remove.json', 'https://a.test/signout',
    'https://a.test/LOGOUT', 'https://a.test/log_out', 'https://a.test/log-out?next=/']) {
    assert.equal(sus('GET', url), true, url);
  }
});

test('the built-in suspect pattern: misses', () => {
  for (const url of ['https://a.test/catalog', 'https://a.test/deleted-items', 'https://a.test/', 'https://a.test/logs',
    'https://a.test/confirmation', 'https://a.test/removed', 'https://a.test/items?reaction=1', 'https://a.test/preconfirm']) {
    assert.equal(sus('GET', url), false, url);
  }
});

test('an absolute URL is tested by its path plus query, never its origin or hash', () => {
  assert.equal(sus('GET', 'https://logout.test/catalog'), false, 'origin');
  assert.equal(sus('GET', 'https://delete.example.com:8080/catalog'), false, 'origin');
  assert.equal(sus('GET', 'https://a.test/catalog#logout'), false, 'hash');
  assert.equal(sus('GET', 'https://a.test/catalog#?action=x'), false, 'hash');
  assert.equal(sus('GET', 'https://user:delete@a.test/catalog'), false, 'userinfo');
  assert.equal(sus('GET', 'https://a.test/catalog?next=/logout'), true, 'query');
  const c = cfg({ defaultSuspectGets: false, suspectGets: ['^/only$'] });
  assert.equal(sus('GET', 'https://a.test/only', c), true, 'anchored on the path');
  assert.equal(sus('GET', 'https://a.test/only?x=1', c), false, 'the query is part of the tested string');
  assert.equal(sus('GET', 'https://a.test/x/only', c), false);
});

test('a relative or unparsable URL is tested as given', () => {
  assert.equal(sus('GET', '/logout'), true);
  assert.equal(sus('GET', 'logout'), true, 'tested as given, so the start of the string counts');
  assert.equal(sus('GET', 'catalog'), false);
  assert.equal(sus('GET', '/x/sign-out?t=1'), true);
  assert.equal(sus('GET', '/catalog'), false);
  assert.equal(sus('GET', '/deleted-items'), false);
  assert.equal(sus('GET', '?action=delete'), true);
  assert.equal(sus('GET', 'http://[bad/logout'), true, 'unparsable absolute');
  const c = cfg({ defaultSuspectGets: false, suspectGets: ['^/only$'] });
  assert.equal(sus('GET', '/only', c), true);
  assert.equal(sus('GET', '/only#frag', c), false, 'a relative URL keeps its hash');
});

test('only GET and HEAD can be suspect, in any case', () => {
  for (const m of ['GET', 'HEAD', 'get', 'head', 'Get']) assert.equal(sus(m, 'https://a.test/logout'), true, m);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'REPORT', '', 'post']) {
    assert.equal(sus(m, 'https://a.test/logout'), false, m);
  }
});

test('suspectGets are case-insensitive, unanchored and added to the built-in', () => {
  const c = cfg({ suspectGets: ['/export-all', 'WIPE'] });
  assert.equal(sus('GET', 'https://a.test/Export-ALL/1', c), true);
  assert.equal(sus('GET', 'https://a.test/x?q=wipe', c), true);
  assert.equal(sus('GET', 'https://a.test/logout', c), true, 'built-in stays');
  assert.equal(sus('GET', 'https://a.test/catalog', c), false);
});

test('defaultSuspectGets false drops the built-in; with nothing left nothing is suspect', () => {
  assert.equal(sus('GET', 'https://a.test/logout', cfg({ defaultSuspectGets: false })), false);
  const c = cfg({ defaultSuspectGets: false, suspectGets: ['/export-all'] });
  assert.equal(sus('GET', 'https://a.test/logout', c), false);
  assert.equal(sus('GET', 'https://a.test/export-all', c), true);
});

test('decideSuspect does not depend on the policy and carries a non-empty reason', () => {
  for (const policy of ['read-only', 'observe']) {
    const c = cfg({ policy });
    for (const [m, u] of [['GET', 'https://a.test/logout'], ['GET', 'https://a.test/catalog'], ['POST', 'https://a.test/logout']]) {
      const d = decideSuspect({ method: m, url: u }, c);
      assert.equal(typeof d.suspect, 'boolean');
      assert.equal(typeof d.reason, 'string');
      assert.ok(d.reason.length > 0);
    }
    assert.equal(sus('GET', 'https://a.test/logout', c), true, policy);
  }
});

test('a writes signature still makes a suspect GET a write, and decideRequest ignores suspicion', () => {
  const c = cfg({ writes: [{ method: 'GET', url: '/logout' }] });
  assert.equal(decideRequest(req('GET', 'https://a.test/logout'), c).action, 'block');
  assert.equal(decideRequest(req('GET', 'https://a.test/logout'), cfg()).action, 'allow');
});

// --- graphql ---------------------------------------------------------------------------

const GQL = 'https://a.test/graphql';
const GQL_RAW = { graphql: ['^https://a[.]test/graphql$'] };
const gql = (extra = {}) => cfg({ ...GQL_RAW, ...extra });
const gq = (body, c = gql(), headers = undefined) => decideRequest({ method: 'POST', url: GQL, body, headers }, c);
const ask = (query, operationName) => JSON.stringify(operationName === undefined ? { query } : { query, operationName });
const READ = (what, i = 0) => ({ action: 'allow', reason: `graphql[${i}] ${what}` });
const WRITE = (what, i = 0) => ({ action: 'block', reason: `POST graphql[${i}] ${what}; policy read-only` });
// What a body the rule cannot read gets with no allow entry: the method rule.
const UNKNOWN = { action: 'block', reason: 'POST is not a read method; policy read-only' };
const TWO = 'query List { items { id } } mutation Rename { rename(id: 1) { id } }';

test('graphql defaults to an empty list and compiles one RegExp per source with no flags', () => {
  for (const raw of [null, undefined, {}, { graphql: [] }]) assert.deepEqual(cfg(raw).graphql, []);
  const g = cfg({ graphql: ['^https://a[.]test/graphql$', '/api/gql'] }).graphql;
  assert.equal(g.length, 2);
  for (const re of g) {
    assert.ok(re instanceof RegExp);
    assert.equal(re.flags, '');
  }
  assert.equal(g[1].source, '\\/api\\/gql');
});

test('malformed graphql throws with the contract messages', () => {
  for (const v of ['x', {}, 5, null, true]) {
    assert.throws(() => cfg({ graphql: v }), { message: 'write-guard: graphql: must be a list' }, String(v));
  }
  for (const v of ['', 5, null, undefined, {}, ['x']]) {
    assert.throws(() => cfg({ graphql: ['^ok', v] }), { message: 'write-guard: graphql[1]: must be a non-empty regex string' }, String(v));
  }
  assert.throws(() => cfg({ graphql: ['('] }), (e) => e.message.startsWith('write-guard: graphql[0]: does not compile: '));
  assert.throws(() => cfg({ graphql: ['^ok', '^ok', '['] }), (e) => e.message.startsWith('write-guard: graphql[2]: does not compile: '));
  for (const url of ['.*', '^', 'x?', '(?:)', 'a|']) {
    assert.throws(
      () => cfg({ graphql: ['^ok', url] }),
      { message: 'write-guard: graphql[1]: matches the empty string, so it can match any URL' },
      url,
    );
  }
});

test('a graphql URL is tested unanchored and case-sensitive against the full URL, the first match named', () => {
  const c = cfg({ graphql: ['/graphql$', 'a[.]test'] });
  const q = ask('query List { items { id } }');
  const at = (url) => decideRequest({ method: 'POST', url, body: q }, c);
  assert.deepEqual(at('https://a.test/graphql'), READ('query List', 0), 'both match, the first is named');
  assert.deepEqual(at('https://b.test/v1/graphql'), READ('query List', 0), 'unanchored');
  assert.deepEqual(at('https://a.test/other'), READ('query List', 1));
  assert.deepEqual(at('https://b.test/GRAPHQL'), UNKNOWN, 'case-sensitive');
  assert.deepEqual(at('https://b.test/graphql/v1'), UNKNOWN);
  assert.deepEqual(decideRequest({ method: 'POST', url: 'https://b.test/x?to=/graphql', body: q }, cfg({ graphql: ['/graphql'] })),
    READ('query List'), 'the query string is tested too');
});

test('graphql: a named query is a read and a named mutation a write', () => {
  assert.deepEqual(gq(ask('query List { items { id } }')), READ('query List'));
  assert.deepEqual(gq(ask('mutation Rename { rename(id: 1) { id } }')), WRITE('mutation Rename'));
  assert.deepEqual(gq(ask('query List($first: Int = 2) @cached { items(first: $first) { id } }')), READ('query List'));
});

test('graphql: an anonymous operation is named (anonymous)', () => {
  assert.deepEqual(gq(ask('{ items { id } }')), READ('query (anonymous)'));
  assert.deepEqual(gq(ask('query { items { id } }')), READ('query (anonymous)'));
  assert.deepEqual(gq(ask('query ($first: Int) { items(first: $first) { id } }')), READ('query (anonymous)'));
  assert.deepEqual(gq(ask('query 2 { items { id } }')), READ('query (anonymous)'), 'a number is not a name');
  assert.deepEqual(gq(ask('mutation { rename(id: 1) { id } }')), WRITE('mutation (anonymous)'));
  assert.deepEqual(gq(ask('mutation ($id: ID!, $in: Input = {name: "x"}) { rename(id: $id) { id } }')), WRITE('mutation (anonymous)'));
});

test('graphql: the name is only the token right after the keyword, so a directive is never a name', () => {
  assert.deepEqual(gq(ask('query @cached { a }')), READ('query (anonymous)'));
  assert.deepEqual(gq(ask('mutation @x { a }')), WRITE('mutation (anonymous)'));
  assert.deepEqual(gq(ask('query Name @x { a }')), READ('query Name'));
  assert.deepEqual(gq(ask('query ($a: Int) @x { a }')), READ('query (anonymous)'));
  assert.deepEqual(gq(ask('mutation @x { a }', 'x')), UNKNOWN, 'a directive name cannot select an operation');
});

test('graphql: a subscription is a write', () => {
  assert.deepEqual(gq(ask('subscription Feed { items { id } }')), WRITE('subscription Feed'));
  assert.deepEqual(gq(ask('subscription { items { id } }')), WRITE('subscription (anonymous)'));
});

test('graphql: operationName chooses the query or the mutation of a two-operation document', () => {
  assert.deepEqual(gq(ask(TWO, 'List')), READ('query List'));
  assert.deepEqual(gq(ask(TWO, 'Rename')), WRITE('mutation Rename'));
});

test('graphql: a missing, unknown or duplicated operation name is unknown', () => {
  for (const name of [undefined, null, '']) assert.deepEqual(gq(ask(TWO, name)), UNKNOWN, `two operations, operationName ${name}`);
  assert.deepEqual(gq(ask(TWO, 'Other')), UNKNOWN, 'no operation of that name');
  assert.deepEqual(gq(ask('query List { items { id } }', 'Other')), UNKNOWN, 'the only operation has another name');
  assert.deepEqual(gq(ask('{ items { id } }', 'List')), UNKNOWN, 'an anonymous operation has no name');
  assert.deepEqual(gq(ask('query A { a } mutation A { b }', 'A')), UNKNOWN, 'two operations of that name');
  assert.deepEqual(gq(ask('fragment F on Item { id }')), UNKNOWN, 'no operation at all');
  // With no name to choose by, a document's only operation is selected.
  for (const name of [undefined, null, '']) assert.deepEqual(gq(ask('query List { items { id } }', name)), READ('query List'));
});

test('graphql: a batch of queries is a read', () => {
  const batch = JSON.stringify([{ query: 'query A { a }' }, { query: '{ b }', operationName: null }, { query: TWO, operationName: 'List' }]);
  assert.deepEqual(gq(batch), READ('batch of 3 queries'));
  assert.deepEqual(gq(JSON.stringify([{ query: 'query A { a }' }])), READ('batch of 1 queries'));
});

test('graphql: a batch with one mutation is a write named by its first write', () => {
  const batch = JSON.stringify([{ query: 'query A { a }' }, { query: TWO, operationName: 'Rename' }, { query: 'subscription S { s }' }]);
  assert.deepEqual(gq(batch), WRITE('mutation Rename'));
  // Even next to an item that cannot be read.
  assert.deepEqual(gq(JSON.stringify([{ query: 'nonsense' }, { query: 'subscription S { s }' }])), WRITE('subscription S'));
});

test('graphql: a batch with one unknown item is unknown', () => {
  assert.deepEqual(gq(JSON.stringify([{ query: 'query A { a }' }, { query: TWO }])), UNKNOWN);
  assert.deepEqual(gq(JSON.stringify([{ query: 'query A { a }' }, { query: 'query B { b' }])), UNKNOWN);
});

test('graphql: a body of any other shape is unknown, whatever else it holds', () => {
  const m = { query: 'mutation Rename { rename { id } }' };
  for (const body of ['[]', '[1]', JSON.stringify([m, 2]), JSON.stringify([m, null]), JSON.stringify([m, [m]]), 'null', '5',
    JSON.stringify('mutation Rename { rename { id } }'), JSON.stringify([m, { variables: {} }])]) {
    assert.deepEqual(gq(body), UNKNOWN, body);
  }
  // query must be a non-empty string, operationName absent, null or a string.
  for (const item of [{}, { query: '' }, { query: 5 }, { query: null }, { query: ['{ a }'] }, { query: { 0: '{', 1: '}', length: 2 } },
    { query: '{ a }', operationName: 5 }, { query: '{ a }', operationName: {} }, { query: '{ a }', operationName: ['x'] },
    { query: '{ a }', operationName: false }]) {
    assert.deepEqual(gq(JSON.stringify(item)), UNKNOWN, JSON.stringify(item));
    assert.deepEqual(gq(JSON.stringify([{ query: '{ a }' }, item])), UNKNOWN, `in a batch ${JSON.stringify(item)}`);
  }
  assert.deepEqual(gq(JSON.stringify([{ query: '{ a }', operationName: 5 }, m])), UNKNOWN, 'a malformed item makes even a mutation batch unknown');
});

test('graphql: a body that is not a string is unknown', () => {
  for (const body of [null, undefined, 5, { toString: () => ask('mutation Rename { rename { id } }') },
    Buffer.from(ask('query List { items { id } }'))]) {
    assert.deepEqual(gq(body), UNKNOWN, String(body));
    assert.deepEqual(gq(body, gql(), { 'content-type': 'application/graphql' }), UNKNOWN, String(body));
  }
});

test('graphql: an application/graphql body is one document with no operation name', () => {
  const ct = (v) => ({ 'Content-Type': v });
  assert.deepEqual(gq('mutation Rename { rename { id } }', gql(), ct('application/graphql')), WRITE('mutation Rename'));
  assert.deepEqual(gq('query List { items { id } }', gql(), ct('Application/GraphQL; charset=utf-8')), READ('query List'));
  assert.deepEqual(gq('{ items { id } }', gql(), ct('  application/graphql  ;charset=utf-8')), READ('query (anonymous)'));
  assert.deepEqual(gq('{ items { id } }', gql(), { 'content-type': ' APPLICATION/GRAPHQL ' }), READ('query (anonymous)'));
  assert.deepEqual(gq(TWO, gql(), ct('application/graphql')), UNKNOWN, 'two operations and no name');
  // A body that parses as JSON is read as JSON whatever its content type.
  assert.deepEqual(gq(ask('query List { items { id } }'), gql(), ct('application/graphql')), READ('query List'));
  assert.deepEqual(gq('"mutation Rename { rename { id } }"', gql(), ct('application/graphql')), UNKNOWN);
});

test('graphql: a body that is neither JSON nor application/graphql is unknown', () => {
  for (const headers of [undefined, {}, { 'content-type': 'text/plain' }, { 'content-type': 'application/json' },
    { 'content-type': 'application/graphql-response+json' }, { 'content-type': 'application/graphqlx' },
    { 'content-type': 'text/plain; application/graphql' }, { 'content-type': 5 }, { 'x-type': 'application/graphql' }]) {
    assert.deepEqual(gq('query List { items { id } }', gql(), headers), UNKNOWN, JSON.stringify(headers));
    assert.deepEqual(gq('mutation Rename { rename { id } }', gql(), headers), UNKNOWN, JSON.stringify(headers));
  }
});

test('graphql: braces and the word mutation inside a string, a block string or a comment are skipped', () => {
  const read = (q) => assert.deepEqual(gq(ask(q)), READ('query List'), q);
  read('query List { items(filter: "} mutation X { x } {") { id } }');
  read('query List { items(filter: "a \\" } mutation X { x } \\\\") { id } }');
  read('query List { items(filter: """ } mutation X { x } \\""" { """) { id } }');
  read('query List { items(filter: """ " } """) { id } }');
  read('# mutation X { x }\nquery List { items { id } } # }');
  read('query List { items { id } } # {\r');
  read('# mutation X { x }\rquery List { items { id } }');
  read(`${String.fromCharCode(0xfeff)}query List, { items, { id } },,`);
  read('query List { items(filter: "") { id } }');
  read('query List { items(filter: """""") { id } }');
  // And the real operation after such a string is still seen.
  assert.deepEqual(gq(ask('query A { a(s: "}") } mutation B { b(s: """{""") }', 'B')), WRITE('mutation B'));
  assert.deepEqual(gq(ask('query A { a(s: "\\"}") } mutation B { b }', 'B')), WRITE('mutation B'));
  assert.deepEqual(gq(ask('# }\nmutation B { b }')), WRITE('mutation B'));
});

test('graphql: a fragment is ignored', () => {
  assert.deepEqual(gq(ask('fragment F on Item { id } query List { items { ...F } }')), READ('query List'));
  assert.deepEqual(gq(ask('fragment F on Item { id } mutation Rename { rename { ...F } }')), WRITE('mutation Rename'));
  assert.deepEqual(gq(ask('query List { items { ...F } } fragment F on Item { id }')), READ('query List'));
  assert.deepEqual(gq(ask('fragment List on Item { id } mutation Rename { rename { ...List } }', 'List')), UNKNOWN, 'a fragment is not an operation');
});

test('graphql: unbalanced brackets, an unterminated string or a definition that never opens is unknown', () => {
  for (const q of ['query List { items { id }', 'query List { items { id } } }', 'query List { items ) }', 'query List { items(id: 1 }',
    'query List { items [ }', 'query List { a ( } )', '} query List { a }', 'mutation Rename { rename(id: "1) { id } }', 'query List { a(s: """x) { id } }',
    'query List { a(s: "\\") }', 'query List', 'query List($a: Int)', 'mutation', 'fragment F on Item']) {
    assert.deepEqual(gq(ask(q)), UNKNOWN, q);
  }
});

test('graphql: anything but a definition at the top level is unknown', () => {
  for (const q of ['items { id }', 'Query List { a }', 'MUTATION Rename { a }', '"x" query List { a }', 'query List { a } extra',
    '1 query List { a }', 'query List { a } !', '( query List { a } )', '[ { a } ]', '$x query List { a }']) {
    assert.deepEqual(gq(ask(q)), UNKNOWN, q);
  }
});

test('graphql: only a POST to a listed URL is judged', () => {
  const m = ask('mutation Rename { rename { id } }');
  assert.deepEqual(decideRequest({ method: 'GET', url: GQL, body: m }, gql()),
    { action: 'allow', reason: 'GET is a read method and matches no writes signature' });
  assert.deepEqual(decideRequest({ method: 'PUT', url: GQL, body: ask('query List { a }') }, gql()),
    { action: 'block', reason: 'PUT is not a read method; policy read-only' });
  assert.deepEqual(decideRequest({ method: 'post', url: GQL, body: m }, gql()), WRITE('mutation Rename'), 'the method in any case');
  assert.deepEqual(decideRequest({ method: 'POST', url: 'https://a.test/other', body: ask('query List { a }') }, gql()), UNKNOWN);
  assert.deepEqual(decideRequest({ method: 'POST', url: `${GQL}/x`, body: ask('query List { a }') }, gql()), UNKNOWN);
});

test('graphql precedence: writes, then a GraphQL write, then a GraphQL read, then allow and the method rule', () => {
  const allow = [{ method: 'POST', url: '^https://a[.]test/graphql$' }];
  // A mutation is a write even when allow matches it.
  assert.deepEqual(gq(ask('mutation Rename { rename { id } }'), gql({ allow })), WRITE('mutation Rename'));
  // A GraphQL read is named as one, not by allow.
  assert.deepEqual(gq(ask('query List { a }'), gql({ allow })), READ('query List'));
  // A writes match wins over a GraphQL read.
  assert.deepEqual(gq(ask('query List { a }'), gql({ allow, writes: [{ method: 'POST', url: '/graphql$', body: 'List' }] })),
    { action: 'block', reason: 'POST matches writes[0]; policy read-only' });
  // Unknown falls through to allow, then to the method rule.
  assert.deepEqual(gq(ask(TWO), gql({ allow })), { action: 'allow', reason: 'allow[0] marks it a read' });
  assert.deepEqual(gq('not json', gql({ allow })), { action: 'allow', reason: 'allow[0] marks it a read' });
  assert.deepEqual(gq(ask(TWO)), UNKNOWN);
  // Under observe a GraphQL write is observed and a read allowed.
  const o = gql({ policy: 'observe', allow });
  assert.deepEqual(gq(ask('mutation Rename { rename { id } }'), o),
    { action: 'observe', reason: 'POST graphql[0] mutation Rename; policy observe' });
  assert.deepEqual(gq(ask('subscription { s }'), o), { action: 'observe', reason: 'POST graphql[0] subscription (anonymous); policy observe' });
  assert.deepEqual(gq(ask('query List { a }'), o), READ('query List'));
  assert.deepEqual(gq(ask('query List { a }'), gql({ policy: 'observe' })), READ('query List'));
  assert.deepEqual(gq(ask(TWO), gql({ policy: 'observe' })), { action: 'observe', reason: 'POST is not a read method; policy observe' });
});

test('with graphql absent or empty, every result is the one 0.6.1 gave', () => {
  assert.deepEqual(cfg({ graphql: [] }), cfg({}));
  const allow = [{ method: 'POST', url: '/graphql$' }];
  const m = ask('mutation Rename { rename { id } }');
  const q = ask('query List { a }');
  for (const extra of [{}, { graphql: [] }]) {
    assert.deepEqual(gq(m, cfg(extra)), UNKNOWN);
    assert.deepEqual(gq(q, cfg(extra)), UNKNOWN);
    assert.deepEqual(gq('mutation Rename { a }', cfg(extra), { 'content-type': 'application/graphql' }), UNKNOWN);
    assert.deepEqual(gq(m, cfg({ ...extra, allow })), { action: 'allow', reason: 'allow[0] marks it a read' });
    assert.deepEqual(gq(m, cfg({ ...extra, policy: 'observe' })), { action: 'observe', reason: 'POST is not a read method; policy observe' });
    assert.deepEqual(decideRequest(req('GET', GQL), cfg(extra)), { action: 'allow', reason: 'GET is a read method and matches no writes signature' });
  }
});

// --- injection: every function works when rebuilt from its own source --------------

test('each function behaves identically when rebuilt from its own source text', () => {
  const rebuild = (fn) => new Function(`return ${fn.toString()}`)();
  const [compile2, control2, request2, suspect2, frame2] = [compileConfig, decideControl, decideRequest, decideSuspect, decideFrame].map(rebuild);
  const HDR = { allow: [{ method: 'report', url: '/h$', headers: { 'X-A': '^1$' } }], logBodies: true };
  const WS = { websocketWrites: ['deleteItem'], suspectGets: ['/export-all'], defaultSuspectGets: true };
  for (const raw of [undefined, { policy: 'observe' }, HDR, WS, { defaultSuspectGets: false },
    { ...GRAPHQL, controls: { icons: ['icon-trash'], text: ['nuke'] } },
    { ...GQL_RAW, allow: [{ method: 'POST', url: '^https://a[.]test/graphql$' }] }]) {
    const c1 = cfg(raw);
    const c2 = compile2(raw);
    assert.deepEqual(c2, c1);
    for (const s of [{ method: 'GET', url: 'https://a.test/logout' }, { method: 'HEAD', url: '/export-all' },
      { method: 'POST', url: 'https://a.test/logout' }, { method: 'GET', url: 'https://a.test/catalog#logout' }]) {
      assert.deepEqual(suspect2(s, c2), decideSuspect(s, c1));
    }
    for (const f of ['deleteItem 1', 'listItems', Buffer.from('deleteItem')]) assert.deepEqual(frame2(f, c2), decideFrame(f, c1));
    for (const k of [ctl('Delete'), ctl('Open'), ctl('', ['icon-trash']), ctl('nuke it'), ctl('Remove filter'), ctl('Remove filter', ['icon-trash'])]) {
      assert.deepEqual(control2(k, c2), decideControl(k, c1));
    }
    for (const r of [req('POST', 'https://a.test/graphql', MUTATION), req('POST', 'https://a.test/graphql', QUERY),
      req('DELETE', 'https://a.test/api/1'), req('GET', 'https://a.test/x'), req('post', 'https://a.test/api/search'),
      { method: 'report', url: 'https://a.test/h', headers: { 'x-a': '1' } }, { method: 'REPORT', url: 'https://a.test/h' },
      req('POST', GQL, ask(TWO)), req('POST', GQL, ask(TWO, 'Rename')), req('POST', GQL, ask('# }\n{ a(s: """}""", t: "\\"") }')),
      req('POST', GQL, JSON.stringify([{ query: '{ a }' }, { query: 'query B { b }' }])),
      { method: 'POST', url: GQL, body: 'subscription S { s }', headers: { 'Content-Type': 'application/graphql; charset=utf-8' } }]) {
      assert.deepEqual(request2(r, c2), decideRequest(r, c1));
    }
  }
});
