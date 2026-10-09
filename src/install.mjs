// playwright-write-guard/install: guard one Playwright BrowserContext.
//
// The network side judges every request in a catch-all context route registered first, and
// wraps every route a caller registers later so the guard judges before the caller's handler
// can continue a request. The page side is an init script built from the decision core's own
// source, with capture-phase listeners that refuse destructive controls before the app sees
// them. No playwright import: everything goes through the context it is handed.

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
    counts[e.action === 'block' ? 'blocked' : 'observed']++;
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

  // Each request is judged once, however many handlers see it. True means pass it on.
  const decided = new WeakSet();
  const judge = async (route) => {
    const req = route.request();
    if (decided.has(req)) return true;
    decided.add(req);
    counts.routed++;
    const method = req.method();
    const url = req.url();
    let body = null;
    try { body = req.postData(); } catch { /* an undecodable body is judged as none */ }
    const v = decideRequest({ method, url, body }, cfg);
    if (v.action === 'allow') return true;
    emit({ kind: 'request', action: v.action, reason: v.reason, method, url });
    if (v.action === 'observe') return true;
    if (req.resourceType() === 'document') {
      await route.fulfill({ status: 403, contentType: 'text/html; charset=utf-8', body: blockedPage(method, url) });
    } else {
      await route.abort('blockedbyclient');
    }
    return false;
  };

  // A caller handler's continue, fallback or fetch overrides are judged as the request they
  // make; one the original already matches was judged above. True means let it proceed.
  const judgeOverride = (route, options = {}) => {
    const req = route.request();
    let original = null;
    try { original = req.postData(); } catch { /* an undecodable body is judged as none */ }
    const p = options.postData;
    const body = p == null ? original : typeof p === 'string' ? p : Buffer.isBuffer(p) ? p.toString('utf8') : JSON.stringify(p);
    const method = String(options.method || req.method()).toUpperCase();
    const url = options.url || req.url();
    if (method === req.method() && url === req.url() && body === original) return { pass: true };
    const v = decideRequest({ method, url, body }, cfg);
    if (v.action !== 'allow') emit({ kind: 'request', action: v.action, reason: v.reason, method, url });
    return { pass: v.action !== 'block', method, url };
  };

  // A predicate, not a glob, so no caller's unroute(url) can name it.
  await context.route(() => true, async (route) => { if (await judge(route)) await route.fallback(); });

  if (cfg.websockets === 'block') {
    await context.routeWebSocket(() => true, async (ws) => {
      emit({ kind: 'request', action: 'block', reason: 'websockets is "block": every WebSocket is refused', url: ws.url() });
      await ws.close({ code: 1008, reason: 'write-guard' }).catch(() => {});
    });
  }

  await context.addInitScript({ content: pageScript(raw) });

  patchRoutes(context, judge, judgeOverride);
  if (cfg.policy === 'read-only') lockRequest(context);
  const onPage = (page) => {
    patchRoutes(page, judge, judgeOverride);
    if (cfg.policy !== 'read-only') return;
    lockRequest(page);
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
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

// The route a caller's handler gets: continue, fallback and fetch judge their overrides first,
// and everything else is the original Route.
function judgedRoute(r, judgeOverride) {
  return new Proxy(r, {
    get(obj, prop) {
      if (prop === 'continue' || prop === 'fallback') {
        return async (options) => (judgeOverride(obj, options).pass ? obj[prop](options) : obj.abort('blockedbyclient'));
      }
      if (prop === 'fetch') {
        return async (options) => {
          const v = judgeOverride(obj, options);
          if (!v.pass) throw new Error(`write-guard: route.fetch of ${v.method} ${v.url} is refused under read-only`);
          return obj.fetch(options);
        };
      }
      const v = Reflect.get(obj, prop, obj);
      return typeof v === 'function' ? v.bind(obj) : v;
    },
  });
}

// Every handler a caller registers asks the guard first; unroute and unrouteAll remove only
// the caller's own handlers.
function patchRoutes(target, judge, judgeOverride) {
  const route = target.route.bind(target);
  const unroute = target.unroute.bind(target);
  const tracked = [];
  const sameUrl = (a, b) => a === b
    || (a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags);
  target.route = (url, handler, options) => {
    const wrapped = async (r, request) => { if (await judge(r)) return handler(judgedRoute(r, judgeOverride), request); };
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
  // Captured before any page script runs, so the page cannot swap it out.
  const bind = window.${BINDING};
  const report = (e) => { try { Promise.resolve(bind(e)).catch(() => {}); } catch (_) {} };
  const CONTROL = 'button, a, [role=button], [role=menuitem], [role=link], [role=tab], input[type=submit], input[type=button], input[type=image], summary, [onclick], [tabindex]';
  const labelOf = (el) => {
    for (const v of [el.getAttribute('aria-label'), el.innerText, el.getAttribute('title'), el.value]) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
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
    if (v.action === 'block') { e.preventDefault(); e.stopImmediatePropagation(); }
    report({ kind: 'control', action: v.action, reason: v.reason, label: label.slice(0, 120) });
  };
  window.addEventListener('click', (e) => {
    if (e.target instanceof Element) judge(e.target.closest(CONTROL) || e.target, e);
  }, true);
  window.addEventListener('submit', (e) => judge(e.submitter || e.target, e), true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') judge(document.activeElement, e);
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
