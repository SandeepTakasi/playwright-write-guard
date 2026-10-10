// playwright-write-guard/install: guard one Playwright BrowserContext.
//
// The network side judges each request at egress, where it would leave the browser: a
// catch-all context route registered first (so it runs last), and the continue and fetch of
// every route a caller registers later. A caller's handler sees every request and may fulfill
// or abort it. The page side is an init script built from the decision core's own source,
// with capture-phase listeners that refuse destructive controls before the app sees them.
// No playwright import: everything goes through the context it is handed.

import { existsSync, promises as fsp, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileConfig, decideControl, decideRequest } from './core.mjs';

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
  const counts = { routed: 0, blocked: 0, observed: 0 };
  const logPath = cfg.log === null ? null : resolve(cfg.log);
  let pending = Promise.resolve();

  const record = () => ({
    installed: true,
    policy: cfg.policy,
    routed_requests: counts.routed,
    blocked: counts.blocked,
    observed: counts.observed,
    events: events.map((e) => ({ ...e })),
  });
  const emit = (event) => {
    const e = { ...event, at: new Date().toISOString() };
    events.push(e);
    if (e.action === 'block') counts.blocked++;
    else if (e.action === 'observe') counts.observed++;
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

  // Judges the request as it would leave through `kind` ('catch-all', 'continue' or 'fetch'):
  // each of method, URL and body from `options` when given, else as the request reached this
  // point (route.request() reflects earlier fallback overrides). Headers are a whole set,
  // never merged, as Playwright replaces them. Then blocks it or lets it proceed.
  const counted = new WeakSet();
  const egress = async (route, options, kind) => {
    const req = route.request();
    const o = options ?? {};
    const method = String(o.method || req.method()).toUpperCase();
    const url = o.url || req.url();
    const p = o.postData;
    let body = null;
    if (p != null) body = typeof p === 'string' ? p : Buffer.isBuffer(p) ? p.toString('utf8') : JSON.stringify(p);
    else try { body = req.postData(); } catch { /* an undecodable body is judged as none */ }
    const headers = {};
    for (const [k, val] of Object.entries(o.headers || req.headers())) headers[k.toLowerCase()] = String(val);
    if (!counted.has(req)) { counted.add(req); counts.routed++; }

    const v = decideRequest({ method, url, body, headers }, cfg);
    if (v.action !== 'allow') {
      emit({
        kind: 'request', action: v.action, reason: v.reason, method, url,
        ...(headers['content-type'] === undefined ? {} : { contentType: headers['content-type'] }),
        ...(cfg.logBodies && body != null ? { body: body.slice(0, 500) } : {}),
      });
    }
    if (v.action === 'block') {
      if (kind === 'fetch') throw new Error(`write-guard: route.fetch of ${method} ${url} is refused under read-only`);
      if (req.resourceType() === 'document') {
        return route.fulfill({ status: 403, contentType: 'text/html; charset=utf-8', body: blockedPage(method, url) });
      }
      return route.abort('blockedbyclient');
    }
    // fallback, never continue, so handlers registered behind the catch-all still run.
    return kind === 'catch-all' ? route.fallback() : route[kind](options);
  };

  // A predicate, not a glob, so no caller's unroute(url) can name it.
  await context.route(() => true, (route) => egress(route, undefined, 'catch-all'));

  await context.routeWebSocket(() => true, async (ws) => {
    if (cfg.websockets === 'block') {
      emit({ kind: 'request', action: 'block', reason: 'websockets is "block": every WebSocket is refused', url: ws.url() });
      await ws.close({ code: 1008, reason: 'write-guard' }).catch(() => {});
    } else {
      emit({ kind: 'websocket', action: 'open', url: ws.url() });
      ws.connectToServer();
    }
  });

  await context.addInitScript({ content: pageScript(raw) });

  patchRoutes(context, egress);
  if (cfg.policy === 'read-only') {
    lockRequest(context);
    // The context's dialog event is emitted before any page's, so this runs ahead of every
    // listener a caller adds later; their accept() then finds the dialog already handled.
    context.on('dialog', (d) => d.dismiss().catch(() => {}));
  }
  const onPage = (page) => {
    patchRoutes(page, egress);
    if (cfg.policy === 'read-only') lockRequest(page);
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
  };
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const blockedPage = (method, url) => `<!doctype html><html><head><meta charset="utf-8"><title>write-guard</title></head>`
  + `<body><p>write-guard blocked ${escapeHtml(method)} ${escapeHtml(url)}</p></body></html>`;

// The route a caller's handler gets: continue and fetch are egress points, judged first, and
// everything else (fulfill, abort, fallback) is the original Route's.
function judgedRoute(r, egress) {
  return new Proxy(r, {
    get(obj, prop) {
      if (prop === 'continue' || prop === 'fetch') return async (options) => egress(obj, options, prop);
      const v = Reflect.get(obj, prop, obj);
      return typeof v === 'function' ? v.bind(obj) : v;
    },
  });
}

// Every handler a caller registers gets a judged route; unroute and unrouteAll remove only
// the caller's own handlers.
function patchRoutes(target, egress) {
  const route = target.route.bind(target);
  const unroute = target.unroute.bind(target);
  const tracked = [];
  const sameUrl = (a, b) => a === b
    || (a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags);
  target.route = (url, handler, options) => {
    const wrapped = (r, request) => handler(judgedRoute(r, egress), request);
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

// The request object stays readable (Playwright's own teardown reads it); only sends throw.
function lockRequest(target) {
  const original = target.request;
  const locked = new Proxy(original, {
    get(obj, prop) {
      if (typeof prop === 'string' && SENDS.has(prop)) {
        return async () => { throw new Error(`write-guard: ${prop} through APIRequestContext is refused under read-only`); };
      }
      const v = Reflect.get(obj, prop, obj);
      return typeof v === 'function' ? v.bind(obj) : v;
    },
  });
  Object.defineProperty(target, 'request', { get: () => locked, configurable: true });
}

// The page side. A capture-phase listener must decide synchronously, so the decision core
// runs in the page, compiled from the same raw config.
function pageScript(raw) {
  return `(() => {
  const compileConfig = ${compileConfig.toString()};
  const decideControl = ${decideControl.toString()};
  const cfg = compileConfig(${JSON.stringify(raw ?? {})});
  // Captured before any page script runs, so the page cannot swap them out.
  const bind = window.${BINDING};
  const preventDefault = Function.prototype.call.bind(Event.prototype.preventDefault);
  const stopImmediatePropagation = Function.prototype.call.bind(Event.prototype.stopImmediatePropagation);
  const warn = console.warn.bind(console);
  const report = (e) => { try { Promise.resolve(bind(e)).catch(() => {}); } catch (_) {} };
  const CONTROL = 'button, a[href], [role=button], [role=menuitem], [role=link], [role=tab], input[type=submit], input[type=button], input[type=image]';
  const SUBMIT = 'button:not([type]), button[type=submit], input[type=submit], input[type=image]';
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
  const judge = (el, e) => {
    if (!(el instanceof Element)) return;
    const label = labelOf(el);
    const v = decideControl({ label, icons: iconsOf(el) }, cfg);
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
