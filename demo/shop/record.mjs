// Records the screen as a GIF: macOS `screencapture` stills every 250 ms until Ctrl+C, then
// Python 3 and Pillow build the GIF.
//
//   node demo/shop/record.mjs [--rect x,y,w,h] [--out docs/demo.gif]
//
// --rect captures only that part of the screen (points, from the top left); without it the whole
// main display is captured. `python3` must be on PATH with Pillow installed, or set PYTHON.

import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const USAGE = 'usage: node demo/shop/record.mjs [--rect x,y,w,h] [--out docs/demo.gif]';
const INTERVAL_MS = 250;
const MAX_WIDTH = 1280;
const LIMIT_BYTES = 8_000_000;
const PYTHON = process.env.PYTHON || 'python3';

let args;
try {
  ({ values: args } = parseArgs({ options: { rect: { type: 'string' }, out: { type: 'string' } } }));
} catch {
  args = null;
}
if (!args || (args.rect !== undefined && !/^-?\d+,-?\d+,\d+,\d+$/.test(args.rect))) {
  console.error(USAGE);
  process.exit(1);
}
const out = args.out ? resolve(args.out) : fileURLToPath(new URL('../../docs/demo.gif', import.meta.url));

const PERMISSION_HELP = `Screen capture did not work. Grant Screen Recording permission to the app that runs this command:
  1. Open System Settings, then Privacy and Security, then Screen Recording.
  2. Switch on the terminal app you are using (Terminal, iTerm2, or the app that hosts your shell).
  3. Quit that app completely and open it again, then run this command again.`;

// Exit 0: Pillow imports and the image has some light in it. Exit 3: the image is all black.
const CHECK = String.raw`import sys
from PIL import Image
sys.exit(3 if Image.open(sys.argv[1]).convert('L').getextrema()[1] == 0 else 0)`;

// Frames last until the next one (an unchanged stretch over 2 s counts as 1 s, the last frame is
// held 2 s). Over the size limit it retries with every 2nd, 3rd or 4th frame and a smaller width.
const ENCODE = String.raw`import sys, json, os
from PIL import Image
out, spec_file, max_w, limit = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
spec = json.load(open(spec_file))
n = len(spec)
gap = lambda i: spec[i + 1]['t'] - spec[i]['t']
dur = [2000 if i + 1 == n else (1000 if gap(i) > 2000 else max(20, gap(i))) for i in range(n)]
base = min(max_w, Image.open(spec[0]['file']).width)

def encode(stride, scale):
    keep = list(range(0, n, stride))
    ms = [sum(dur[k:(keep[j + 1] if j + 1 < len(keep) else n)]) for j, k in enumerate(keep)]
    w = round(base * scale)
    def load(k):
        im = Image.open(spec[k]['file']).convert('RGB')
        return im.resize((w, round(im.height * w / im.width)), Image.LANCZOS) if im.width != w else im
    load(keep[0]).save(out, save_all=True, append_images=(load(k) for k in keep[1:]), duration=ms, loop=0, optimize=True)
    return w, len(keep)

for stride, scale in [(1, 1), (2, 1), (2, .75), (3, .75), (3, .5), (4, .5), (6, .4)]:
    w, kept = encode(stride, scale)
    size = os.path.getsize(out)
    print(f'{kept} frames at {w} px wide: {size} bytes')
    if size < limit:
        sys.exit(0)
    print(f'over {limit} bytes, trying fewer frames or a smaller width')
sys.exit('still over the size limit: record a shorter run or a smaller --rect')`;

const run = promisify(execFile);
const tmp = mkdtempSync(join(tmpdir(), 'wg-record-'));
const frames = [];
let taken = 0;
let previous = null;
let stopping = false;

// A second Ctrl+C gives up without building the GIF.
const stop = () => {
  if (stopping) {
    rmSync(tmp, { recursive: true, force: true });
    process.exit(130);
  }
  stopping = true;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const fail = (message) => {
  rmSync(tmp, { recursive: true, force: true });
  console.error(message);
  process.exit(1);
};

while (!stopping) {
  const t = Date.now();
  const file = join(tmp, `f${String(taken).padStart(5, '0')}.png`);
  try {
    await run('screencapture', ['-x', '-C', ...(args.rect ? ['-R', args.rect] : []), file]);
    if (statSync(file).size === 0) throw new Error('screencapture wrote an empty file');
  } catch (err) {
    if (taken === 0) fail(`${err.message.trim()}\n${PERMISSION_HELP}`);
    console.error(`\nscreencapture failed (${err.message.trim()}); building the GIF from what was captured`);
    break;
  }
  if (taken === 0) {
    const check = spawnSync(PYTHON, ['-c', CHECK, file], { encoding: 'utf8' });
    if (check.status === 3) fail(`The first frame is black.\n${PERMISSION_HELP}`);
    if (check.status !== 0) fail(`Python 3 with Pillow is needed (python3 -m pip install --user pillow, or set PYTHON to an interpreter that has it).\n${check.error?.message ?? check.stderr}`);
    console.log('Recording. Press Ctrl+C when the agent has finished.');
  }
  taken++;
  // A frame identical to the one before it is dropped: its time is covered by the earlier frame.
  const bytes = readFileSync(file);
  if (previous?.equals(bytes)) unlinkSync(file);
  else {
    frames.push({ file, t });
    previous = bytes;
  }
  process.stdout.write(`\rframes captured: ${taken}, distinct: ${frames.length}   `);
  await sleep(Math.max(0, INTERVAL_MS - (Date.now() - t)));
}
console.log(`\nStopped. Building the GIF from ${frames.length} distinct frames...`);

// Ctrl+C reaches Python as well when it comes from the terminal, so the build ignores it.
process.removeAllListeners('SIGINT');
process.on('SIGINT', () => {});
mkdirSync(dirname(out), { recursive: true });
const spec = join(tmp, 'spec.json');
writeFileSync(spec, JSON.stringify(frames));
const built = spawnSync(PYTHON, ['-c', ENCODE, out, spec, String(MAX_WIDTH), String(LIMIT_BYTES)], { stdio: 'inherit' });
rmSync(tmp, { recursive: true, force: true });
if (built.status !== 0) {
  console.error('The GIF was not built within the size limit; see the message above.');
  process.exit(1);
}
console.log(`wrote ${out} (${statSync(out).size} bytes)`);
