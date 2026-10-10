import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileConfig, decideControl, decideRequest } from '../src/core.mjs';

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

test('all 23 built-in verbs are present', () => {
  const { text } = cfg();
  const verbs = ['save', 'delete', 'remove', 'publish', 'share', 'submit', 'send', 'archive', 'upload',
    'import', 'rename', 'duplicate', 'update', 'confirm', 'pay', 'purchase', 'invite', 'reset',
    'restore', 'approve', 'reject', 'log out', 'sign out'];
  assert.equal(verbs.length, 23);
  for (const v of verbs) assert.ok(text.test(v), v);
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
  bad({ allow: [{ method: 'post', url: 'x' }] }, 'allow[0].method');
  bad({ writes: [{ method: 'FETCH', url: 'x' }] }, 'writes[0].method');
  bad({ writes: [{ url: 'x' }] }, 'writes[0].method');
});

test('lists that are not lists throw', () => {
  bad({ allow: 'POST /api' }, 'allow');
  bad({ writes: {} }, 'writes');
  bad({ controls: { text: 'wipe' } }, 'controls.text');
  bad({ controls: { icons: 'fa-bomb' } }, 'controls.icons');
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

test('allow always wins over the method default and over writes', () => {
  const c = cfg({
    allow: [{ method: 'POST', url: '^https://a[.]test/graphql' }],
    writes: [{ method: 'POST', url: '/graphql' }],
  });
  assert.equal(decideRequest(req('POST', 'https://a.test/graphql'), c).action, 'allow');
  assert.equal(decideRequest(req('POST', 'https://a.test/other'), c).action, 'block');
  assert.equal(decideRequest(req('POST', 'https://b.test/graphql'), c).action, 'block');
});

test('a body signature separates a query from a mutation on one URL', () => {
  const c = cfg({ allow: [{ method: 'POST', url: '/graphql$', body: '"query"\\s*:\\s*"\\s*query\\b' }] });
  assert.equal(decideRequest(req('POST', 'https://a.test/graphql', QUERY), c).action, 'allow');
  assert.equal(decideRequest(req('POST', 'https://a.test/graphql', MUTATION), c).action, 'block');
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

// --- injection: every function works when rebuilt from its own source --------------

test('each function behaves identically when rebuilt from its own source text', () => {
  const rebuild = (fn) => new Function(`return ${fn.toString()}`)();
  const [compile2, control2, request2] = [compileConfig, decideControl, decideRequest].map(rebuild);
  for (const raw of [undefined, { policy: 'observe' }, { ...GRAPHQL, controls: { icons: ['icon-trash'], text: ['nuke'] } }]) {
    const c1 = cfg(raw);
    const c2 = compile2(raw);
    assert.deepEqual(c2, c1);
    for (const k of [ctl('Delete'), ctl('Open'), ctl('', ['icon-trash']), ctl('nuke it')]) {
      assert.deepEqual(control2(k, c2), decideControl(k, c1));
    }
    for (const r of [req('POST', 'https://a.test/graphql', MUTATION), req('POST', 'https://a.test/graphql', QUERY),
      req('DELETE', 'https://a.test/api/1'), req('GET', 'https://a.test/x'), req('post', 'https://a.test/api/search')]) {
      assert.deepEqual(request2(r, c2), decideRequest(r, c1));
    }
  }
});
