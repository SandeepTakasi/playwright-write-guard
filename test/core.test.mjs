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

test('the 11 built-in verbs are present and every dropped one is absent', () => {
  const { text } = cfg();
  const verbs = ['save', 'delete', 'remove', 'publish', 'send', 'archive', 'pay', 'purchase',
    'log out', 'sign out', 'logout'];
  assert.equal(verbs.length, 11);
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

// --- injection: every function works when rebuilt from its own source --------------

test('each function behaves identically when rebuilt from its own source text', () => {
  const rebuild = (fn) => new Function(`return ${fn.toString()}`)();
  const [compile2, control2, request2, suspect2, frame2] = [compileConfig, decideControl, decideRequest, decideSuspect, decideFrame].map(rebuild);
  const HDR = { allow: [{ method: 'report', url: '/h$', headers: { 'X-A': '^1$' } }], logBodies: true };
  const WS = { websocketWrites: ['deleteItem'], suspectGets: ['/export-all'], defaultSuspectGets: true };
  for (const raw of [undefined, { policy: 'observe' }, HDR, WS, { defaultSuspectGets: false },
    { ...GRAPHQL, controls: { icons: ['icon-trash'], text: ['nuke'] } }]) {
    const c1 = cfg(raw);
    const c2 = compile2(raw);
    assert.deepEqual(c2, c1);
    for (const s of [{ method: 'GET', url: 'https://a.test/logout' }, { method: 'HEAD', url: '/export-all' },
      { method: 'POST', url: 'https://a.test/logout' }, { method: 'GET', url: 'https://a.test/catalog#logout' }]) {
      assert.deepEqual(suspect2(s, c2), decideSuspect(s, c1));
    }
    for (const f of ['deleteItem 1', 'listItems', Buffer.from('deleteItem')]) assert.deepEqual(frame2(f, c2), decideFrame(f, c1));
    for (const k of [ctl('Delete'), ctl('Open'), ctl('', ['icon-trash']), ctl('nuke it')]) {
      assert.deepEqual(control2(k, c2), decideControl(k, c1));
    }
    for (const r of [req('POST', 'https://a.test/graphql', MUTATION), req('POST', 'https://a.test/graphql', QUERY),
      req('DELETE', 'https://a.test/api/1'), req('GET', 'https://a.test/x'), req('post', 'https://a.test/api/search'),
      { method: 'report', url: 'https://a.test/h', headers: { 'x-a': '1' } }, { method: 'REPORT', url: 'https://a.test/h' }]) {
      assert.deepEqual(request2(r, c2), decideRequest(r, c1));
    }
  }
});
