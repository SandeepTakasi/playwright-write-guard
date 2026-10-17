// A dependency-free store admin for the recorded demo: orders and customers behind a staff
// session, with Refund, Delete and Delete selected. The server never sets the cookie itself:
// send `session=staff` (the returned storageState does it). Every request it receives is
// appended to `requestLog` as one JSON line `{ at, method, path }`.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const files = {
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
const PAGES = /^\/(?:orders(?:\/\d+)?|customers)?$/;

const SIGN_IN = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in | Tidewell Admin</title>
<link rel="icon" href="data:,"><link rel="stylesheet" href="/app.css"></head>
<body class="signin"><main class="signin-card"><div class="brand"><span class="logo">T</span>Tidewell Admin</div>
<h1>Sign in</h1><p>Staff accounts sign in through single sign-on. This staging copy has no sign-in form:
send the cookie <code>session=staff</code>, for example from a Playwright storage-state file.</p></main></body></html>`;

const customers = [
  { id: 1, name: 'Riley Chen', email: 'riley.chen@example.test', joined: '2026-03-02', city: 'Portland' },
  { id: 2, name: 'Morgan Patel', email: 'morgan.patel@example.test', joined: '2026-04-19', city: 'Austin' },
  { id: 3, name: 'Casey Novak', email: 'casey.novak@example.test', joined: '2026-05-07', city: 'Denver' },
  { id: 4, name: 'Jamie Ortiz', email: 'jamie.ortiz@example.test', joined: '2026-06-23', city: 'Raleigh' },
  { id: 5, name: 'Taylor Quinn', email: 'taylor.quinn@example.test', joined: '2026-08-11', city: 'Madison' },
  { id: 6, name: 'QA Automation', email: 'qa-bot@example.test', joined: '2026-09-30', city: 'Staging' },
];

const products = {
  mug: ['Stoneware mug, set of 4', 3600],
  pillow: ['Linen throw pillow', 4800],
  board: ['Oak serving board', 6200],
  blanket: ['Merino wool blanket', 12900],
  lamp: ['Brass desk lamp', 8900],
  tote: ['Canvas market tote', 2450],
  candle: ['Cedar soy candle', 1800],
};

// [id, customer, date, payment, test, [[product, qty], ...]]
const seed = [
  [1041, 1, '2026-10-06T09:14', 'Paid', false, [['blanket', 1], ['candle', 2]]],
  [1042, 2, '2026-10-07T13:40', 'Paid', false, [['lamp', 1]]],
  [1043, 3, '2026-10-08T16:05', 'Refunded', false, [['pillow', 2]]],
  [1044, 4, '2026-10-09T10:22', 'Paid', false, [['board', 1], ['mug', 1]]],
  [1045, 6, '2026-10-10T11:02', 'Paid', true, [['blanket', 1]]],
  [1046, 5, '2026-10-11T08:47', 'Pending', false, [['tote', 2]]],
  [1047, 6, '2026-10-11T11:30', 'Pending', true, [['mug', 1]]],
  [1048, 1, '2026-10-12T19:15', 'Paid', false, [['candle', 3]]],
  [1049, 3, '2026-10-13T14:51', 'Paid', false, [['lamp', 1], ['tote', 1]]],
  [1050, 6, '2026-10-14T11:12', 'Paid', true, [['board', 1], ['tote', 1]]],
  [1051, 2, '2026-10-15T09:33', 'Pending', false, [['pillow', 1]]],
  [1052, 6, '2026-10-15T11:48', 'Pending', true, [['candle', 1]]],
];

export function startShop({ port = 0 } = {}) {
  const orders = seed.map(([id, customerId, placed, payment, isTest, lines]) => {
    const items = lines.map(([p, qty]) => ({ name: products[p][0], qty, price: products[p][1] }));
    return { id, number: `#${id}`, customerId, placed, payment, test: isTest, items, total: items.reduce((s, i) => s + i.qty * i.price, 0) };
  });
  const customerOf = (o) => customers.find((c) => c.id === o.customerId);
  const summary = (o) => ({ id: o.id, number: o.number, customer: customerOf(o).name, placed: o.placed, total: o.total, payment: o.payment, test: o.test, items: o.items.reduce((s, i) => s + i.qty, 0) });
  let requestLog;

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const readJson = async (req) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try { return JSON.parse(raw); } catch { return {}; }
  };

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      appendFileSync(requestLog, `${JSON.stringify({ at: new Date().toISOString(), method: req.method, path })}\n`);
      const signedIn = /(?:^|;\s*)session=staff(?:;|$)/.test(req.headers.cookie ?? '');

      if (req.method === 'GET' && files[path]) {
        const [name, type] = files[path];
        return send(res, 200, await readFile(new URL(name, import.meta.url), 'utf8'), type);
      }
      if (req.method === 'GET' && PAGES.test(path)) {
        const html = signedIn ? await readFile(new URL('index.html', import.meta.url), 'utf8') : SIGN_IN;
        return send(res, 200, html, 'text/html; charset=utf-8');
      }
      if (!path.startsWith('/api/')) return send(res, 404, 'Not found', 'text/plain');
      if (!signedIn) return send(res, 401, { error: 'sign in first' });

      if (req.method === 'GET' && path === '/api/orders') return send(res, 200, orders.map(summary).reverse()); // newest first
      if (req.method === 'GET' && path === '/api/customers') {
        return send(res, 200, customers.map((c) => {
          const own = orders.filter((o) => o.customerId === c.id);
          return { ...c, orders: own.length, spent: own.filter((o) => o.payment === 'Paid').reduce((s, o) => s + o.total, 0) };
        }));
      }
      if (req.method === 'POST' && path === '/api/orders/bulk-delete') {
        const ids = new Set((await readJson(req)).ids ?? []);
        const before = orders.length;
        for (let i = orders.length - 1; i >= 0; i--) if (ids.has(orders[i].id)) orders.splice(i, 1);
        return send(res, 200, { deleted: before - orders.length });
      }
      const m = path.match(/^\/api\/orders\/(\d+)(\/refund)?$/);
      const i = m ? orders.findIndex((o) => o.id === Number(m[1])) : -1;
      if (m && i < 0) return send(res, 404, { error: 'order not found' });
      if (m && !m[2] && req.method === 'GET') {
        const o = orders[i];
        return send(res, 200, { ...summary(o), items: o.items, customer: customerOf(o) });
      }
      if (m && !m[2] && req.method === 'DELETE') {
        orders.splice(i, 1);
        return send(res, 204, '');
      }
      if (m && m[2] && req.method === 'POST') {
        if (orders[i].payment !== 'Paid') return send(res, 409, { error: 'only a paid order can be refunded' });
        orders[i].payment = 'Refunded';
        return send(res, 200, summary(orders[i]));
      }
      send(res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'server error' });
      else res.destroy();
    }
  });
  // Aborted requests (e.g. blocked by a guard) must not crash the process.
  server.on('clientError', (_err, socket) => socket.destroy());

  return mkdtemp(join(tmpdir(), 'shop-')).then((dir) => new Promise((resolve, reject) => {
    requestLog = join(dir, 'requests.jsonl');
    writeFileSync(requestLog, '');
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        // A Playwright storage state that signs in to the store on 127.0.0.1.
        storageState: {
          cookies: [{ name: 'session', value: 'staff', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
          origins: [],
        },
        requestLog,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }).then(() => rm(dir, { recursive: true, force: true })),
      });
    });
  }));
}
