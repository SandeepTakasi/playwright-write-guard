// playwright-write-guard: the decision core. Pure functions, no I/O, no imports.
//
// Every exported function is self-contained: it references nothing outside its own
// arguments and body, because the installer injects `fn.toString()` into pages, where a
// capture-phase click listener must decide synchronously. Keep it that way: no module-level
// helpers or constants, and inline whatever a function needs.

/**
 * Validate a raw config and apply its defaults. `null` and `undefined` mean `{}`.
 * Throws `write-guard: <path>: <message>` on anything malformed.
 */
export function compileConfig(raw) {
  const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', '*'];
  const VERBS = ['save', 'delete', 'remove', 'publish', 'share', 'submit', 'send', 'archive', 'upload',
    'import', 'rename', 'duplicate', 'update', 'confirm', 'pay', 'purchase', 'invite', 'reset',
    'restore', 'approve', 'reject', 'log out', 'sign out'];
  const fail = (path, message) => { throw new Error(`write-guard: ${path}: ${message}`); };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const list = (v, path) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) fail(path, 'must be a list');
    return v;
  };
  const oneOf = (v, allowed, dflt, path) => {
    if (v === undefined) return dflt;
    if (!allowed.includes(v)) fail(path, `must be one of ${allowed.join(' | ')}`);
    return v;
  };
  const regex = (src, path, flags) => {
    if (typeof src !== 'string' || src === '') fail(path, 'must be a non-empty regex string');
    try { return new RegExp(src, flags); } catch (e) { return fail(path, `does not compile: ${e.message}`); }
  };
  const sigs = (v, key) => list(v, key).map((s, i) => {
    const at = `${key}[${i}]`;
    if (!isObj(s)) fail(at, 'must be an object');
    if (!METHODS.includes(s.method)) fail(`${at}.method`, `must be one of ${METHODS.join(' | ')}`);
    return {
      method: s.method,
      url: regex(s.url, `${at}.url`, ''),
      body: s.body === undefined || s.body === null ? null : regex(s.body, `${at}.body`, ''),
    };
  });

  const cfg = raw ?? {};
  if (!isObj(cfg)) fail('config', 'must be an object');
  const controls = cfg.controls === undefined ? {} : cfg.controls;
  if (!isObj(controls)) fail('controls', 'must be an object');
  if (cfg.defaultControls !== undefined && typeof cfg.defaultControls !== 'boolean') {
    fail('defaultControls', 'must be a boolean');
  }
  if (cfg.log !== undefined && cfg.log !== null && (typeof cfg.log !== 'string' || cfg.log === '')) {
    fail('log', 'must be a non-empty string or null');
  }

  const policy = oneOf(cfg.policy, ['read-only', 'observe'], 'read-only', 'policy');
  const websockets = oneOf(cfg.websockets, ['allow', 'block'], 'allow', 'websockets');
  const allow = sigs(cfg.allow, 'allow');
  const writes = sigs(cfg.writes, 'writes');
  const extra = list(controls.text, 'controls.text');
  extra.forEach((s, i) => regex(s, `controls.text[${i}]`, 'i'));
  const icons = list(controls.icons, 'controls.icons');
  icons.forEach((s, i) => { if (typeof s !== 'string' || s === '') fail(`controls.icons[${i}]`, 'must be a non-empty string'); });

  // The built-in verbs match as whole words ("save", not "saved"); user sources are regexes.
  const parts = [...(cfg.defaultControls === false ? [] : [`\\b(?:${VERBS.join('|')})\\b`]),
    ...extra.map((s) => `(?:${s})`)];

  return {
    policy,
    allow,
    writes,
    text: parts.length ? new RegExp(parts.join('|'), 'i') : null,
    icons: [...icons],
    websockets,
    log: cfg.log === undefined ? 'write-guard.jsonl' : cfg.log,
  };
}

/** `block` (read-only) or `observe` (observe) for a write, else `allow`. */
export function decideRequest(request, config) {
  const method = String(request.method ?? '').toUpperCase();
  const url = String(request.url ?? '');
  const body = request.body;
  const matches = (s) => (s.method === '*' || s.method === method) && s.url.test(url)
    && (s.body === null || (typeof body === 'string' && s.body.test(body)));

  const allowed = config.allow.findIndex(matches);
  if (allowed !== -1) return { action: 'allow', reason: `allow[${allowed}] marks it a read` };
  const hit = config.writes.findIndex(matches);
  let what;
  if (hit !== -1) what = `${method} matches writes[${hit}]`;
  else if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) what = `${method} is not a read method`;
  else return { action: 'allow', reason: `${method} is a read method and matches no writes signature` };
  return config.policy === 'observe'
    ? { action: 'observe', reason: `${what}; policy observe` }
    : { action: 'block', reason: `${what}; policy read-only` };
}

/** `block` (read-only) or `observe` (observe) for a destructive control, else `allow`. */
export function decideControl(control, config) {
  const label = String(control.label ?? '').trim();
  const icon = (control.icons ?? []).find((c) => config.icons.some((p) => String(c).startsWith(p)));
  const textHit = label !== '' && config.text !== null && config.text.test(label);
  if (!textHit && icon === undefined) return { action: 'allow', reason: 'not a destructive control' };
  const what = textHit ? `"${label.slice(0, 80)}" matches a destructive label` : `icon ${icon} matches a destructive icon`;
  return config.policy === 'observe'
    ? { action: 'observe', reason: `${what}; policy observe` }
    : { action: 'block', reason: `${what}; policy read-only` };
}
