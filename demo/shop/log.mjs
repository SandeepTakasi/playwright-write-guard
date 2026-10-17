#!/usr/bin/env node
// The demo's log pane: tails the store's request log and the guard's log from their current
// end and prints what reached the server and what the guard refused, with a running count of
// the writes the server received. Usage: node demo/shop/log.mjs <requestLog> <guardLog>
import { openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs';

const [requestLog, guardLog] = process.argv.slice(2);
if (!requestLog || !guardLog) {
  console.error('usage: node demo/shop/log.mjs <requestLog> <guardLog>');
  process.exit(1);
}

const tty = process.stdout.isTTY === true;
const color = tty && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const isWrite = (method) => typeof method === 'string' && method !== 'GET' && method !== 'HEAD';

const size = (file) => { try { return statSync(file).size; } catch { return 0; } };
const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

// Writes already in the request log count, but only what arrives from now on is printed.
let writes = 0;
try {
  for (const line of readFileSync(requestLog, 'utf8').split('\n')) if (isWrite(parse(line)?.method)) writes++;
} catch { /* not there yet */ }

const footer = () => paint(writes ? '1;31' : '1;32', `writes received by the server: ${writes}`);
// On a terminal the footer is redrawn in place under the feed; otherwise it is printed when it changes.
const print = (line) => process.stdout.write(tty ? `\r\x1b[2K${line}\n${footer()}` : `${line}\n`);

function serverLine(r) {
  if (!r?.method) return;
  const text = `server  ${r.method} ${r.path}`;
  if (!isWrite(r.method)) return print(paint('2', text));
  writes++;
  print(paint('1;31', text));
  if (!tty) print(footer());
}

function guardLine(e) {
  if (e?.action !== 'block') return;
  if (e.kind === 'control') return print(paint('1;33', `guard   refused "${e.label}"`));
  print(paint('1;33', `guard   refused ${e.method ?? 'WEBSOCKET'} ${e.url}: ${e.reason}`));
}

function tail(file, onLine) {
  let offset = size(file);
  let rest = '';
  return () => {
    const end = size(file);
    if (end < offset) { offset = 0; rest = ''; } // truncated or replaced
    if (end === offset) return;
    const buf = Buffer.alloc(end - offset);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
    offset = end;
    const lines = (rest + buf.toString('utf8')).split('\n');
    rest = lines.pop();
    for (const line of lines) if (line.trim()) onLine(parse(line));
  };
}

const polls = [tail(requestLog, serverLine), tail(guardLog, guardLine)];
process.stdout.write(tty ? footer() : `${footer()}\n`);
setInterval(() => polls.forEach((poll) => poll()), 150);
process.on('SIGINT', () => {
  process.stdout.write('\n');
  process.exit(0);
});
