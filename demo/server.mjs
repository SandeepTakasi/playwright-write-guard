// Tiny dependency-free demo app: a list of items you can add and delete.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const indexUrl = new URL('./index.html', import.meta.url);

export function startDemoServer({ port = 0 } = {}) {
  const items = [
    { id: 1, name: 'First item' },
    { id: 2, name: 'Second item' },
    { id: 3, name: 'Third item' },
  ];
  let nextId = 4;
  let writes = 0;

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method !== 'GET') writes++;

      if (req.method === 'GET' && path === '/') {
        return send(res, 200, await readFile(indexUrl, 'utf8'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && path === '/api/items') return send(res, 200, items);

      if (req.method === 'POST' && path === '/api/items') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        let name;
        try { name = String(JSON.parse(raw).name ?? '').trim(); } catch { name = ''; }
        if (!name) return send(res, 400, { error: 'name required' });
        const item = { id: nextId++, name };
        items.push(item);
        return send(res, 201, item);
      }

      const m = path.match(/^\/api\/items\/(\d+)$/);
      if (req.method === 'DELETE' && m) {
        const i = items.findIndex((it) => it.id === Number(m[1]));
        if (i < 0) return send(res, 404, { error: 'not found' });
        items.splice(i, 1);
        return send(res, 204, '');
      }
      send(res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'server error' });
      else res.destroy();
    }
  });
  // Aborted requests (e.g. blocked by a guard) must not crash the process.
  server.on('clientError', (_err, socket) => socket.destroy());

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        stats: () => ({ writes }),
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
