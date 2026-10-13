// playwright-write-guard/install: guard one Playwright BrowserContext.
//
// The network side judges each request at egress, where it would leave the browser: a
// catch-all context route registered first (so it runs last), and the continue and fetch of
// every route a caller registers later. A caller's handler sees every request and may fulfill
// or abort it, which is recorded as a mock. Sends through the context's request client, and
// through clients and fetch functions wrapped with the handle, are judged before they are
// made. The page side is an init script built from the decision core's own source, with
// capture-phase listeners that refuse destructive controls before the app sees them, and, under
// read-only, judges the writes of a frame being left and removes SharedWorker and fetchLater.
// No playwright import: everything goes through the context it is handed.

import { existsSync, promises as fsp, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileConfig, decideControl, decideFrame, decideRequest, decideSuspect } from './core.mjs';

const BINDING = '__writeGuardReport';
const ALREADY = 'write-guard: this context is already guarded by another process; use one mode, not both';
const SENDS = new Set(['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head']);
const guarded = new WeakMap();

/** Guard a browser context; a second call on the same context returns the first call's handle. */
export async function install(context, config = {}) {
  // Synchronous up to here, so concurrent calls (one per new tab) share one install. A
  // malformed config throws before anything is stored or installed.
  if (!guarded.has(context)) guarded.set(context, setup(context, config, compileConfig(config)));
  return guarded.get(context);
}

async function setup(context, raw, cfg) {
  const events = [];
  // By event action; a websocket `open` counts in none of them.
  const counts = { block: 0, observe: 0, mocked: 0, suspect: 0 };
  let routed = 0;
  const logPath = cfg.log === null ? null : resolve(cfg.log);
  let pending = Promise.resolve();

  const record = () => ({
    installed: true,
    policy: cfg.policy,
    routed_requests: routed,
    blocked: counts.block,
    observed: counts.observe,
    mocked: counts.mocked,
    suspect: counts.suspect,
    events: structuredClone(events),
  });
  const emit = (event) => {
    const e = { ...event, at: new Date().toISOString() };
    events.push(e);
    if (Object.hasOwn(counts, e.action)) counts[e.action]++;
    if (logPath) {
      const line = `${JSON.stringify(e)}\n`;
      pending = pending.then(() => fsp.appendFile(logPath, line))
        .catch((err) => process.emitWarning(`write-guard: cannot append to ${logPath}: ${err.message}`));
    }
  };

  // First, before anything else: a refused install must leave nothing behind.
  try {
    await context.exposeBinding(BINDING, (_source, e) => {
      if (!e || e.kind !== 'control' || (e.action !== 'block' && e.action !== 'observe')) return;
      emit({ kind: 'control', action: e.action, reason: String(e.reason), label: String(e.label ?? '').trim().slice(0, 120) });
    });
  } catch (err) {
    if (/already registered/.test(String(err?.message))) throw new Error(ALREADY);
    throw err;
  }

  const baseURL = context._options?.baseURL;
  // Requests that reached egress through a caller's route.fetch: judged there, so a later
  // fulfill or abort of them is not a mock.
  const fetched = new WeakSet();
  const counted = new WeakSet();
  // Judges the request as it would leave through `kind` ('catch-all', 'continue' or 'fetch'),
  // then blocks it or lets it proceed. route.fetch sends what Playwright merges for its
  // request client; the others send the request as it reached this point with `options`
  // applied.
  const egress = async (route, options, kind) => {
    const req = route.request();
    let r;
    if (kind === 'fetch') {
      fetched.add(req);
      r = clientRequest({ request: req, data: options?.postData, ...options }, baseURL);
    } else {
      r = browserRequest(req, options);
    }
    if (!counted.has(req)) { counted.add(req); routed++; }

    if (judge(r, cfg, emit) === 'block') {
      if (kind === 'fetch') throw new Error(`write-guard: route.fetch of ${r.method} ${r.url} is refused under read-only`);
      if (req.resourceType() === 'document') {
        return route.fulfill({ status: 403, contentType: 'text/html; charset=utf-8', body: blockedPage(r.method, r.url) });
      }
      return route.abort('blockedbyclient');
    }
    // fallback, never continue, so handlers registered behind the catch-all still run.
    return kind === 'catch-all' ? route.fallback() : route[kind](options);
  };
  // A caller's fulfill or abort: recorded when the request, as that handler received it, is a write.
  const mock = (route) => {
    const req = route.request();
    if (fetched.has(req)) return;
    const r = browserRequest(req);
    const v = decideRequest(r, cfg);
    if (v.action !== 'allow') emit(requestEvent('mocked', v.reason, r, cfg));
  };

  // A predicate, not a glob, so no caller's unroute(url) can name it.
  await context.route(() => true, (route) => egress(route, undefined, 'catch-all'));

  await context.routeWebSocket(() => true, async (ws) => {
    if (cfg.websockets === 'block') {
      emit({ kind: 'request', action: 'block', reason: 'websockets is "block": every WebSocket is refused', url: ws.url() });
      await ws.close({ code: 1008, reason: 'write-guard' }).catch(() => {});
      return;
    }
    emit({ kind: 'websocket', action: 'open', url: ws.url() });
    const server = ws.connectToServer();
    if (!cfg.websocketWrites.length) return;
    // Only frames the page sends; the server's messages still reach the page untouched.
    ws.onMessage((message) => {
      const v = decideFrame(message, cfg);
      if (v.action !== 'allow') {
        emit({ kind: 'websocket', action: v.action, reason: v.reason, url: ws.url(), ...(cfg.logBodies ? { frame: message.slice(0, 500) } : {}) });
      }
      if (v.action !== 'block') server.send(message);
    });
  });

  await context.addInitScript({ content: pageScript(raw) });

  // One wrapper for the context's client; a page's `request` is the same object.
  const client = judgeClient(context.request, cfg, { baseURL, emit });
  const pinRequest = (target) => Object.defineProperty(target, 'request', { get: () => client, configurable: true });
  pinRequest(context);
  patchRoutes(context, egress, mock);
  if (cfg.policy === 'read-only') {
    // The context's dialog event is emitted before any page's, so this runs ahead of every
    // listener a caller adds later; their accept() then finds the dialog already handled.
    context.on('dialog', (d) => d.dismiss().catch(() => {}));
  }
  const onPage = (page) => {
    patchRoutes(page, egress, mock);
    pinRequest(page);
  };
  for (const p of context.pages()) onPage(p);
  context.on('page', onPage);

  return {
    record,
    async close() {
      // Appends chain onto `pending`; wait until no new one arrived while waiting.
      let last;
      do { last = pending; await last; } while (last !== pending);
      return record();
    },
    guardRequestClient: (target, { baseURL: base } = {}) => judgeClient(target, cfg, { baseURL: base, emit }),
    guardFetch: (fetchFn) => async (...args) => {
      const r = fetchRequest(args[0], args[1]);
      if (judge(r, cfg, emit, 'node-fetch') === 'block') throw new Error(refused(r, 'fetch'));
      return fetchFn(...args);
    },
  };
}

// Judges one effective request: emits a write's `block` or `observe` event, or a `suspect`
// event for an allowed GET or HEAD that looks side effecting. Returns the decideRequest action.
function judge(r, cfg, emit, via) {
  const v = decideRequest(r, cfg);
  if (v.action !== 'allow') {
    emit(requestEvent(v.action, v.reason, r, cfg, via));
  } else {
    const s = decideSuspect(r, cfg);
    if (s.suspect) emit(requestEvent('suspect', s.reason, r, cfg, via));
  }
  return v.action;
}

// `r.headers` has lower-case names, each once, so its keys are the header names.
const requestEvent = (action, reason, r, cfg, via) => ({
  kind: 'request', action, reason, method: r.method, url: r.url,
  ...(via ? { via } : {}),
  ...(r.headers['content-type'] === undefined ? {} : { contentType: r.headers['content-type'] }),
  headerNames: Object.keys(r.headers).sort(),
  ...(cfg.logBodies && r.body != null ? { body: r.body.slice(0, 500) } : {}),
});

const refused = (r, via) => `write-guard: ${r.method} ${r.url} through ${via} is refused under read-only`;

// A browser request at a route: each of method, URL and body from `options` when given, else
// as the request reached this point (route.request() reflects earlier fallback overrides).
// Headers are a whole set, never merged, as Playwright replaces them.
function browserRequest(req, options) {
  const o = options ?? {};
  const method = String(o.method || req.method()).toUpperCase();
  const url = o.url || req.url();
  const p = o.postData;
  let body = null;
  if (p != null) body = typeof p === 'string' ? p : Buffer.isBuffer(p) ? p.toString('utf8') : JSON.stringify(p);
  else try { body = req.postData(); } catch { /* an undecodable body is judged as none */ }
  const headers = {};
  for (const [k, val] of Object.entries(o.headers || req.headers())) headers[k.toLowerCase()] = String(val);
  return { method, url, body, headers };
}

// Playwright's isString.
const isString = (v) => typeof v === 'string' || v instanceof String;
const parses = (s) => { try { JSON.parse(s); return true; } catch { return false; } };
const parseURL = (...args) => { try { return new URL(...args); } catch { return null; } };

// The effective request of an APIRequestContext send, read from the options `m` that
// Playwright 1.64 merges before it sends, the way it reads them.
function clientRequest(m, baseURL) {
  const req = m.request;
  const method = String(m.method || req?.method() || 'GET').toUpperCase();

  const raw = m.url !== undefined ? m.url : req.url();
  const u = (baseURL ? parseURL(raw, baseURL) : null) ?? parseURL(raw);
  let url = String(raw);
  if (u) {
    const p = m.params;
    if (typeof p === 'string' || p instanceof URLSearchParams) {
      if (String(p)) u.search = String(p);
    } else if (p !== null && typeof p === 'object') {
      for (const [k, v] of Object.entries(p)) if (v !== undefined) u.searchParams.append(k, String(v));
    }
    u.hash = '';
    url = u.href;
  }

  // As for...in enumerates them; the last of names equal after lower-casing is what is sent.
  const h = m.headers || req?.headers();
  const headers = {};
  let jsonType = null;
  for (const name in h ?? {}) {
    const value = h[name];
    if (value === undefined) continue;
    const k = name.toLowerCase();
    if (k === 'content-type' && jsonType === null) jsonType = value === 'application/json';
    headers[k] = String(value);
  }

  let body = null;
  const d = m.data;
  if (d !== undefined) {
    // Read as Playwright reads it: Buffer.from takes a String object's valueOf().
    if (isString(d)) body = jsonType && !(typeof d === 'string' && parses(d)) ? JSON.stringify(d) : Buffer.from(d, 'utf8').toString('utf8');
    else if (Buffer.isBuffer(d)) body = d.toString('utf8');
    else body = JSON.stringify(d) ?? null;
  } else if (!m.form && !m.multipart && req) {
    body = req.postDataBuffer()?.toString('utf8') ?? null;
  }
  return { method, url, body, headers };
}

// The effective request of a Node fetch(input, init) call.
function fetchRequest(input, init) {
  const isRequest = input instanceof globalThis.Request;
  const method = String(init?.method || (isRequest ? input.method : '') || 'GET').toUpperCase();
  const raw = typeof input === 'string' ? input : isRequest ? input.url : String(input);
  const u = parseURL(raw);
  if (u) u.hash = '';
  const h = init?.headers !== undefined ? init.headers : isRequest ? input.headers : undefined;
  const headers = {};
  if (h !== undefined) for (const [k, v] of new Headers(h)) headers[k] = v;
  return { method, url: u ? u.href : raw, body: typeof init?.body === 'string' ? init.body : null, headers };
}

// `client` with each send judged with the compiled `cfg`, its events passed to `emit`.
// Everything that is not a send reads through to the raw client, with methods bound to it,
// so Playwright's own calls (route.fetch reaches _innerFetch) are not judged again here.
function judgeClient(client, cfg, { baseURL, emit }) {
  return new Proxy(client, {
    get(obj, prop) {
      if (typeof prop === 'string' && SENDS.has(prop)) {
        return async (...args) => {
          const [a, options] = args;
          const m = { url: isString(a) ? a : undefined, request: isString(a) ? undefined : a, ...options };
          if (prop !== 'fetch') m.method = prop.toUpperCase();
          const r = clientRequest(m, baseURL);
          if (judge(r, cfg, emit, 'request-client') === 'block') throw new Error(refused(r, 'APIRequestContext'));
          // The raw client's own method: its named methods call its own fetch, not this wrapper's.
          return obj[prop](...args);
        };
      }
      const v = Reflect.get(obj, prop, obj);
      return typeof v === 'function' ? v.bind(obj) : v;
    },
  });
}

/**
 * Internal, not part of the API: `client` with each send judged with the compiled config `cfg`
 * and recorded nowhere, for a request client no guard records.
 */
export function _judgeRequestClient(client, cfg, { baseURL } = {}) {
  return judgeClient(client, cfg, { baseURL, emit: () => {} });
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const blockedPage = (method, url) => `<!doctype html><html><head><meta charset="utf-8"><title>write-guard</title></head>`
  + `<body><p>write-guard blocked ${escapeHtml(method)} ${escapeHtml(url)}</p></body></html>`;

// The route a caller's handler gets: continue and fetch are egress points, judged first;
// fulfill and abort are mock points, recorded first and then called unchanged; everything
// else (fallback) is the original Route's.
function judgedRoute(r, egress, mock) {
  return new Proxy(r, {
    get(obj, prop) {
      if (prop === 'continue' || prop === 'fetch') return async (options) => egress(obj, options, prop);
      if (prop === 'fulfill' || prop === 'abort') return async (...args) => { mock(obj); return obj[prop](...args); };
      const v = Reflect.get(obj, prop, obj);
      return typeof v === 'function' ? v.bind(obj) : v;
    },
  });
}

// Every handler a caller registers gets a judged route; unroute and unrouteAll remove only
// the caller's own handlers.
function patchRoutes(target, egress, mock) {
  const route = target.route.bind(target);
  const unroute = target.unroute.bind(target);
  const tracked = [];
  const sameUrl = (a, b) => a === b
    || (a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags);
  target.route = (url, handler, options) => {
    const wrapped = (r, request) => handler(judgedRoute(r, egress, mock), request);
    tracked.push({ url, handler, wrapped });
    // The returned disposable calls target.unroute(url, wrapped), which lands below.
    return route(url, wrapped, options);
  };
  target.unroute = async (url, handler) => {
    for (const t of tracked.filter((x) => sameUrl(x.url, url) && (!handler || x.handler === handler || x.wrapped === handler))) {
      tracked.splice(tracked.indexOf(t), 1);
      await unroute(t.url, t.wrapped);
    }
  };
  // unrouteAll's `behavior` option is ignored; the guard never waits on a caller's handlers.
  target.unrouteAll = async () => {
    for (const t of tracked.splice(0)) await unroute(t.url, t.wrapped);
  };
}

// The page side. A capture-phase listener must decide synchronously, so the decision core
// runs in the page, compiled from the same raw config.
function pageScript(raw) {
  return `(() => {
  // Captured before any page script runs, so the page cannot swap them out.
  const URL = window.URL;
  const compileConfig = ${compileConfig.toString()};
  const decideControl = ${decideControl.toString()};
  const decideSuspect = ${decideSuspect.toString()};
  const decideRequest = ${decideRequest.toString()};
  const cfg = compileConfig(${JSON.stringify(raw ?? {})});
  const bind = window.${BINDING};
  const preventDefault = Function.prototype.call.bind(Event.prototype.preventDefault);
  const stopImmediatePropagation = Function.prototype.call.bind(Event.prototype.stopImmediatePropagation);
  const warn = console.warn.bind(console);
  const report = (e) => { try { Promise.resolve(bind(e)).catch(() => {}); } catch (_) {} };
  const CONTROL = 'button, a[href], [role=button], [role=menuitem], [role=link], [role=tab], input[type=submit], input[type=button], input[type=image]';
  const SUBMIT = 'button:not([type]), button[type=submit], input[type=submit]';
  const ownLabel = (el) => {
    for (const v of [el.getAttribute('aria-label'), el.innerText, el.getAttribute('title'), el.value]) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  // One level up: a control in a shadow root whose own label is empty takes its host's.
  const labelOf = (el) => {
    const own = ownLabel(el);
    const root = el.getRootNode();
    return own || !(root instanceof ShadowRoot) ? own : ownLabel(root.host);
  };
  const iconsOf = (el) => {
    const out = [];
    for (const n of [el, ...el.querySelectorAll('[class]')]) {
      for (const c of (n.getAttribute('class') || '').split(/\\s+/)) if (c) out.push(c);
    }
    return out;
  };
  // The URL an a[href] navigates to, or null for a control judged by its label: anything that
  // is not an a[href], and an a[href] whose trimmed href is empty or starts with '#', or that
  // resolves to a javascript: URL.
  const linkTarget = (el) => {
    if (el.localName !== 'a' || !el.hasAttribute('href')) return null;
    const href = el.getAttribute('href').trim();
    if (href === '' || href.startsWith('#')) return null;
    try {
      const u = new URL(href, document.baseURI);
      return u.protocol === 'javascript:' ? null : u.href;
    } catch (_) {
      return href;
    }
  };
  const judge = (el, e) => {
    if (!(el instanceof Element)) return;
    const label = labelOf(el);
    const url = linkTarget(el);
    let v;
    if (url === null) {
      v = decideControl({ label, icons: iconsOf(el) }, cfg);
    } else {
      // A link that navigates is judged by its URL only: a suspect one is destructive.
      const s = decideSuspect({ method: 'GET', url }, cfg);
      v = s.suspect ? { action: cfg.policy === 'observe' ? 'observe' : 'block', reason: s.reason } : { action: 'allow' };
    }
    if (v.action === 'allow') return;
    if (v.action === 'block') {
      preventDefault(e);
      stopImmediatePropagation(e);
      warn('write-guard refused "' + label.slice(0, 120) + '": ' + v.reason);
    }
    report({ kind: 'control', action: v.action, reason: v.reason, label: label.slice(0, 120) });
  };
  const isControl = (n) => n instanceof Element && n.matches(CONTROL);
  // The path crosses open shadow roots and stops at a closed one's host.
  window.addEventListener('click', (e) => judge(e.composedPath().find(isControl), e), true);
  window.addEventListener('submit', (e) => {
    const form = e.target;
    const fallback = form instanceof HTMLFormElement ? Array.prototype.find.call(form.elements, (n) => n.matches(SUBMIT)) : null;
    judge(e.submitter || fallback, e);
  }, true);
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && isControl(document.activeElement)) judge(document.activeElement, e);
  }, true);
  if (cfg.policy !== 'read-only') return;

  // Under read-only, a write that a leaving frame sends is judged here, because Playwright 1.64
  // does not route it; nothing is recorded. A frame that is not leaving is untouched.
  const Req = window.Request, origFetch = window.fetch, reject = Promise.reject.bind(Promise);
  const USP = window.URLSearchParams, AB = window.ArrayBuffer, isView = AB.isView, TD = window.TextDecoder;
  const TE = TypeError;
  const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get;
  const KEY = Symbol.for('playwright-write-guard.pagehide');
  let hidden = false;
  window.addEventListener('pagehide', () => { hidden = true; }, true);
  // For a page restored from the back/forward cache. Playwright launches Chromium with
  // --disable-back-forward-cache, so this branch is not reached under Playwright.
  window.addEventListener('pageshow', () => { hidden = false; }, true);
  Object.defineProperty(window, KEY, { get: () => hidden });
  // This frame or a same-origin ancestor is hidden or has fired pagehide: when a parent's handler
  // calls into a child frame, the child has seen neither yet. A cross-origin ancestor cannot be
  // read, so the walk goes on past it to the same-origin ones above.
  const leaving = () => {
    for (let w = window; ; w = w.parent) {
      try {
        if (w[KEY] === true || visibility.call(w.document) === 'hidden') return true;
      } catch (_) { /* cross-origin */ }
      if (w === w.parent) return false;
    }
  };
  const isRead = (m) => m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
  const resolveURL = (u) => {
    try { const x = new URL(u, document.baseURI); x.hash = ''; return x.href; } catch (_) { return String(u); }
  };
  // A body the page can read synchronously as a string, else none.
  const bodyText = (b) => typeof b === 'string' ? b
    : b instanceof USP ? String(b)
    : b instanceof AB || isView(b) ? new TD().decode(b)
    : null;
  // True when the send may proceed; false, after the warning, when it is refused.
  const refusal = (m, u) => 'write-guard: ' + m + ' ' + u + ' from a hidden or unloading page is refused under read-only';
  const allowed = (method, url, body, headers) => {
    if (decideRequest({ method, url, body, headers }, cfg).action === 'allow') return true;
    warn(refusal(method, url));
    return false;
  };

  window.fetch = function fetch(input, init) {
    if (!leaving()) return origFetch.apply(this, arguments);
    let r;
    try { r = new Req(input, init); } catch (e) { return reject(e); }
    const method = r.method.toUpperCase();
    if (isRead(method)) return origFetch(r);
    const url = resolveURL(r.url);
    const headers = { __proto__: null };
    r.headers.forEach((v, k) => { headers[k] = v; });
    const body = init != null && init.body !== undefined ? bodyText(init.body) : null;
    return allowed(method, url, body, headers) ? origFetch(r) : reject(new TE(refusal(method, url)));
  };

  const Nav = Navigator.prototype, origBeacon = Nav.sendBeacon;
  Nav.sendBeacon = function sendBeacon(url, data) {
    if (leaving() && !allowed('POST', resolveURL(url), bodyText(data), {})) return false;
    return origBeacon.apply(this, arguments);
  };

  const XHR = XMLHttpRequest.prototype, origOpen = XHR.open, origSet = XHR.setRequestHeader, origSend = XHR.send;
  const opened = new WeakMap(), getOpened = WeakMap.prototype.get.bind(opened), setOpened = WeakMap.prototype.set.bind(opened);
  XHR.open = function open(method, url) {
    const out = origOpen.apply(this, arguments);
    setOpened(this, { method: String(method).toUpperCase(), url: resolveURL(url), headers: { __proto__: null } });
    return out;
  };
  XHR.setRequestHeader = function setRequestHeader(name, value) {
    const out = origSet.apply(this, arguments);
    const s = getOpened(this);
    if (s) {
      const k = String(name).toLowerCase();
      s.headers[k] = k in s.headers ? s.headers[k] + ', ' + String(value) : String(value);
    }
    return out;
  };
  XHR.send = function send(body) {
    const s = getOpened(this);
    if (s && !isRead(s.method) && leaving() && !allowed(s.method, s.url, bodyText(body), s.headers)) {
      throw new TE(refusal(s.method, s.url));
    }
    return origSend.apply(this, arguments);
  };

  // Neither a shared worker's HTTP nor a fetchLater request is routed, so both are removed (each is
  // an own, configurable property of the window); an app that detects them falls back to a
  // dedicated Worker, fetch or sendBeacon, which are judged.
  delete window.SharedWorker;
  delete window.fetchLater;
})();`;
}

/**
 * Read a raw config: `path`, else WRITE_GUARD_CONFIG, else write-guard.config.json when it
 * exists, else {}. WRITE_GUARD_POLICY, when non-empty, overrides `policy`. Validated, returned raw.
 */
export function loadConfig(path) {
  const named = path || process.env.WRITE_GUARD_CONFIG;
  const file = named ? resolve(named) : existsSync(resolve('write-guard.config.json')) ? resolve('write-guard.config.json') : null;
  let raw = {};
  if (file) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (err) { throw new Error(`write-guard: ${file}: cannot be read: ${err.message}`); }
    try { raw = JSON.parse(text) ?? {}; } catch (err) { throw new Error(`write-guard: ${file}: is not valid JSON: ${err.message}`); }
  }
  const policy = process.env.WRITE_GUARD_POLICY;
  if (policy && raw !== null && typeof raw === 'object' && !Array.isArray(raw)) raw = { ...raw, policy };
  compileConfig(raw);
  return raw;
}
