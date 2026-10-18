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
  const VERBS = ['save', 'delete', 'remove', 'publish', 'send', 'archive', 'pay', 'purchase', 'refund',
    'log out', 'sign out', 'logout'];
  const SUSPECT = '(?:^|[/._-])(?:(?:log|sign)[-_]?out|unsubscribe|confirm|delete|remove)(?:$|[/._?&#-])|[?&]action=';
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
    if (s.method !== '*' && !(typeof s.method === 'string' && /^[A-Za-z][A-Za-z0-9-]*$/.test(s.method))) {
      fail(`${at}.method`, 'must be "*" or a method name');
    }
    const hs = s.headers === undefined || s.headers === null ? {} : s.headers;
    if (!isObj(hs)) fail(`${at}.headers`, 'must be an object');
    const url = regex(s.url, `${at}.url`, '');
    // An allow URL that matches '' matches every URL, so it would turn the guard off for its method.
    if (key === 'allow' && url.test('')) fail(`${at}.url`, 'matches the empty string, so it can match any URL');
    return {
      method: s.method.toUpperCase(),
      url,
      body: s.body === undefined || s.body === null ? null : regex(s.body, `${at}.body`, ''),
      headers: Object.keys(hs).map((k) => ({ name: k.toLowerCase(), value: regex(hs[k], `${at}.headers.${k}`, '') })),
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
  if (cfg.logBodies !== undefined && typeof cfg.logBodies !== 'boolean') fail('logBodies', 'must be a boolean');
  if (cfg.defaultExceptions !== undefined && typeof cfg.defaultExceptions !== 'boolean') {
    fail('defaultExceptions', 'must be a boolean');
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

  if (cfg.defaultSuspectGets !== undefined && typeof cfg.defaultSuspectGets !== 'boolean') {
    fail('defaultSuspectGets', 'must be a boolean');
  }
  const websocketWrites = list(cfg.websocketWrites, 'websocketWrites').map((s, i) => regex(s, `websocketWrites[${i}]`, ''));
  const graphql = list(cfg.graphql, 'graphql').map((s, i) => {
    const re = regex(s, `graphql[${i}]`, '');
    // As for allow URLs: one that matches '' matches every URL.
    if (re.test('')) fail(`graphql[${i}]`, 'matches the empty string, so it can match any URL');
    return re;
  });
  const suspectGets = list(cfg.suspectGets, 'suspectGets');
  suspectGets.forEach((s, i) => regex(s, `suspectGets[${i}]`, 'i'));
  const suspectParts = [...(cfg.defaultSuspectGets === false ? [] : [SUSPECT]), ...suspectGets].map((s) => `(?:${s})`);

  return {
    policy,
    allow,
    writes,
    text: parts.length ? new RegExp(parts.join('|'), 'i') : null,
    icons: [...icons],
    // Whole labels only, so "Remove filter rule permanently" still matches the verbs; no save or send phrase belongs here.
    exceptions: cfg.defaultExceptions === false ? null
      : new RegExp('^(?:(?:remove|clear)\\s+filters?|clear\\s+search|remove\\s+columns?)$', 'i'),
    websockets,
    websocketWrites,
    suspect: suspectParts.length ? new RegExp(suspectParts.join('|'), 'i') : null,
    log: cfg.log === undefined ? 'write-guard.jsonl' : cfg.log,
    logBodies: cfg.logBodies === true,
    graphql,
  };
}

/**
 * `block` (read-only) or `observe` (observe) for a write, else `allow`. Order: a `writes` match,
 * then a GraphQL mutation or subscription, then a GraphQL query, then `allow`, then the method.
 */
export function decideRequest(request, config) {
  const method = String(request.method ?? '').toUpperCase();
  const url = String(request.url ?? '');
  const body = request.body;
  const headers = {};
  for (const k of Object.keys(request.headers ?? {})) headers[k.toLowerCase()] = request.headers[k];
  const matches = (s) => (s.method === '*' || s.method === method) && s.url.test(url)
    && (s.body === null || (typeof body === 'string' && s.body.test(body)))
    && s.headers.every((h) => typeof headers[h.name] === 'string' && h.value.test(headers[h.name]));

  // GraphQL: the operations ({ type, name }) of one document, fragments left out, or null when
  // it cannot be read. Only top-level definitions matter, so strings, comments and nesting are skipped.
  const operations = (q) => {
    const found = [];
    const stack = [];
    let def = null;
    let fresh = false;
    const word = (ch) => ch === '_' || (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
    for (let i = 0; i < q.length;) {
      const c = q[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c.charCodeAt(0) === 0xfeff) { i++; continue; }
      if (c === '#') {
        while (i < q.length && q[i] !== '\n' && q[i] !== '\r') i++;
        continue;
      }
      let token = c;
      if (c === '"') {
        const block = q.startsWith('"""', i);
        let j = i + (block ? 3 : 1);
        for (;;) {
          if (j >= q.length) return null;
          if (block ? q.startsWith('\\"""', j) : q[j] === '\\') j += block ? 4 : 2;
          else if (block ? q.startsWith('"""', j) : q[j] === '"') break;
          else j++;
        }
        i = j + (block ? 3 : 1);
      } else if (word(c)) {
        let j = i + 1;
        while (j < q.length && word(q[j])) j++;
        token = q.slice(i, j);
        i = j;
      } else i++;
      // A definition's name is the token right after its keyword, when that token is a name.
      const afterKeyword = fresh;
      fresh = false;
      if (def === null) {
        if (token === '{') { def = { type: 'query', name: null, open: true }; stack.push('{'); }
        else if (['query', 'mutation', 'subscription', 'fragment'].includes(token)) {
          def = { type: token, name: null, open: false };
          fresh = true;
        } else return null;
        found.push(def);
      } else if (afterKeyword && word(c) && !(c >= '0' && c <= '9')) {
        def.name = token;
      } else if (token === '{' || token === '(' || token === '[') {
        if (token === '{' && stack.length === 0) def.open = true;
        stack.push(token);
      } else if (token === '}' || token === ')' || token === ']') {
        if (stack.pop() !== { '}': '{', ')': '(', ']': '[' }[token]) return null;
        if (stack.length === 0 && def.open) def = null;
      }
    }
    return def === null ? found.filter((d) => d.type !== 'fragment') : null;
  };
  // The body sent to a graphql URL: { kind: 'write', type, name }, { kind: 'read', what } or null (unknown).
  const graphqlBody = () => {
    if (typeof body !== 'string') return null;
    const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    let items;
    let batch = false;
    try {
      const v = JSON.parse(body);
      batch = Array.isArray(v);
      items = plain(v) ? [v] : batch && v.length > 0 && v.every(plain) ? v : null;
    } catch {
      const type = typeof headers['content-type'] === 'string' ? headers['content-type'].toLowerCase().split(';')[0].trim() : '';
      items = type === 'application/graphql' ? [{ query: body, operationName: null }] : null;
    }
    if (items === null || !items.every((it) => typeof it.query === 'string' && it.query !== ''
      && (it.operationName === undefined || it.operationName === null || typeof it.operationName === 'string'))) return null;
    const picked = items.map((it) => {
      const ops = operations(it.query);
      if (ops === null) return null;
      const chosen = typeof it.operationName === 'string' && it.operationName !== ''
        ? ops.filter((o) => o.name === it.operationName) : ops;
      return chosen.length === 1 ? chosen[0] : null;
    });
    const w = picked.find((o) => o !== null && o.type !== 'query');
    if (w !== undefined) return { kind: 'write', type: w.type, name: w.name };
    if (!picked.every((o) => o !== null)) return null;
    return { kind: 'read', what: batch ? `batch of ${items.length} queries` : `query ${picked[0].name ?? '(anonymous)'}` };
  };

  const hit = config.writes.findIndex(matches);
  const gi = hit === -1 && method === 'POST' ? config.graphql.findIndex((re) => re.test(url)) : -1;
  const g = gi === -1 ? null : graphqlBody();
  let what;
  if (hit !== -1) what = `${method} matches writes[${hit}]`;
  else if (g?.kind === 'write') what = `${method} graphql[${gi}] ${g.type} ${g.name ?? '(anonymous)'}`;
  else if (g?.kind === 'read') return { action: 'allow', reason: `graphql[${gi}] ${g.what}` };
  else {
    const allowed = config.allow.findIndex(matches);
    if (allowed !== -1) return { action: 'allow', reason: `allow[${allowed}] marks it a read` };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) what = `${method} is not a read method`;
    else return { action: 'allow', reason: `${method} is a read method and matches no writes signature` };
  }
  return config.policy === 'observe'
    ? { action: 'observe', reason: `${what}; policy observe` }
    : { action: 'block', reason: `${what}; policy read-only` };
}

/**
 * `block` (read-only) or `observe` (observe) for a string frame matching any `websocketWrites`
 * pattern, else `allow`. A frame that is not a string is always `allow`. Runs only in Node.
 */
export function decideFrame(text, config) {
  const hit = typeof text === 'string' ? config.websocketWrites.findIndex((re) => re.test(text)) : -1;
  if (hit === -1) return { action: 'allow', reason: 'not a frame matching websocketWrites' };
  const what = `frame matches websocketWrites[${hit}]`;
  return config.policy === 'observe'
    ? { action: 'observe', reason: `${what}; policy observe` }
    : { action: 'block', reason: `${what}; policy read-only` };
}

/**
 * `suspect: true` only for a GET or HEAD whose URL matches the compiled `suspect` pattern, tested
 * by pathname plus search for an absolute URL and as given otherwise. Self-contained (injected into pages).
 */
export function decideSuspect(request, config) {
  const method = String(request.method ?? '').toUpperCase();
  const url = String(request.url ?? '');
  if (method !== 'GET' && method !== 'HEAD') return { suspect: false, reason: `${method} is not a GET or HEAD` };
  if (config.suspect === null) return { suspect: false, reason: 'no suspect pattern is configured' };
  let tested = url;
  try { const u = new URL(url); tested = u.pathname + u.search; } catch { /* relative or unparsable: tested as given */ }
  return config.suspect.test(tested)
    ? { suspect: true, reason: `${method} ${tested.slice(0, 80)} matches the suspect pattern` }
    : { suspect: false, reason: `${method} ${tested.slice(0, 80)} matches no suspect pattern` };
}

/** `block` (read-only) or `observe` (observe) for a destructive control, else `allow`. */
export function decideControl(control, config) {
  const label = String(control.label ?? '').trim();
  const icon = (control.icons ?? []).find((c) => config.icons.some((p) => String(c).startsWith(p)));
  const excepted = config.exceptions !== null && config.exceptions.test(label);
  const textHit = label !== '' && config.text !== null && !excepted && config.text.test(label);
  if (!textHit && icon === undefined) {
    return { action: 'allow', reason: excepted ? `"${label}" is a built-in read-only exception` : 'not a destructive control' };
  }
  const what = textHit ? `"${label.slice(0, 80)}" matches a destructive label` : `icon ${icon} matches a destructive icon`;
  return config.policy === 'observe'
    ? { action: 'observe', reason: `${what}; policy observe` }
    : { action: 'block', reason: `${what}; policy read-only` };
}
