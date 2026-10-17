"""Composes the README demo GIF from what demo/shop/film.mjs recorded.

    python3 demo/shop/compose.py <timeline.json> <out.gif>

Every line in a frame comes from the timeline: the prompt, the agent's stream-json messages and
tool calls, the browser screenshots, the shop's request log and the guard's log. The canvas is
1280x720: a title strip, the agent on the left, the browser and the log pane on the right.
An em or en dash in shown text is drawn as a comma. Some lines are left out, never changed: Claude Code's own tool loading (ToolSearch), the
browser_tabs listing and stale snapshot references ("Error: Ref ..."); the pane then says
"setup calls hidden".
"""
import json
import os
import re
import sys
import tempfile
import textwrap

from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
TITLE_H = 34
LEFT_W = 548
PAD = 14
GAP = 8
BAR_H = 26
LIMIT_BYTES = 8_000_000
GROUP_MS = 120  # events this close together share a frame

BG = (13, 17, 23)
TITLE_BG = (22, 27, 34)
TERM_BG = (13, 17, 23)
PROMPT_BG = (33, 39, 48)
RIGHT_BG = (28, 33, 40)
LOG_BG = (10, 12, 16)
FG = (230, 237, 243)
DIM = (125, 133, 144)
ORANGE = (217, 119, 87)
TEAL = (86, 182, 194)
YELLOW = (236, 196, 84)
RED = (244, 102, 102)
GREEN = (87, 200, 122)
BAND = (78, 66, 26)  # behind a guard refusal on the frame that is held
UI_COLORS = [BG, TITLE_BG, PROMPT_BG, RIGHT_BG, LOG_BG, FG, DIM, ORANGE, TEAL, YELLOW, RED, GREEN, BAND]
HOLD_MS = 3000  # the first frame after each new guard refusal
LAST_MS = 8000  # the final frame, with the agent's last message


def font(size, bold=False):
    try:
        return ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', size, index=1 if bold else 0)
    except OSError:
        return ImageFont.load_default(size)


# The terminal text is at least 16 px so it stays readable when GitHub shows the GIF at about 65 %.
F = font(17)
FB = font(17, True)
FS = font(14)
FSB = font(14, True)
LINE = 23
LOG_LINE = 19
TERM_COLS = int((LEFT_W - 2 * PAD) // F.getlength('M'))
LOG_COLS = int((W - LEFT_W - 2 * GAP - 2 * 10) // FS.getlength('M'))


def commas(text):
    """Shows an em or en dash as a comma (punctuation only, the words are unchanged)."""
    text = re.sub(r'[ \t]*[\N{EN DASH}\N{EM DASH}][ \t]*', ', ', text)
    return re.sub(r'(?m)^, ', '', text)  # a dash that opened a line


def clean(text):
    # Markdown markers and dashes only; the words are the agent's own.
    return commas(re.sub(r'\*\*|`', '', text))


def table(rows, cols):
    """A markdown table as aligned columns, without its separator row."""
    cells = [[c.strip() for c in r.strip().strip('|').split('|')] for r in rows]
    cells = [r for r in cells if not all(re.fullmatch(r':?-+:?', c) for c in r)]
    widths = [max(len(r[i]) for r in cells if i < len(r)) for i in range(max(map(len, cells), default=0))]
    return ['  '.join(c.ljust(w) for c, w in zip(r, widths)).rstrip()[:cols] for r in cells]


def wrap(text, cols, first, rest, max_lines=None):
    lines = []
    paras = clean(text).strip().split('\n')
    i = 0
    while i < len(paras):
        para = paras[i]
        i += 1
        prefix = first if not lines else rest
        if para.lstrip().startswith('|'):
            j = i
            while j < len(paras) and paras[j].lstrip().startswith('|'):
                j += 1
            for row in table(paras[i - 1:j], cols - len(rest)):
                lines.append((first if not lines else rest) + row)
            i = j
            continue
        if not para.strip():
            if lines and lines[-1].strip():
                lines.append('')
            continue
        lines += textwrap.wrap(para, cols, initial_indent=prefix, subsequent_indent=rest + ' ' * (len(para) - len(para.lstrip())),
                               drop_whitespace=True, break_on_hyphens=False) or [prefix]
    if max_lines and len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = lines[-1][:cols - 3] + '...'
    return lines


def short_name(name):
    return re.sub(r'^mcp__playwright__', '', name)


def summary(name, args):
    """A short, literal summary of a tool call's arguments."""
    if not isinstance(args, dict):
        return ''
    parts = []
    for key in ('query', 'command', 'element', 'url', 'text', 'key', 'values', 'accept', 'promptText', 'time', 'textGone', 'action', 'index', 'filename'):
        if key in args and args[key] not in (None, ''):
            value = args[key]
            parts.append(json.dumps(value) if key in ('text', 'values', 'promptText') or not isinstance(value, str) else value)
    for key in ('function', 'code'):
        if key in args:
            parts.append(' '.join(str(args[key]).split()))
    if 'fields' in args and isinstance(args['fields'], list):
        parts.append(', '.join(f"{f.get('name')}={json.dumps(f.get('value'))}" for f in args['fields'] if isinstance(f, dict)))
    return '  '.join(parts).replace('mcp__playwright__', '')


def highlight(ev):
    """The first line of a tool result worth showing: a guard refusal, an error, a failed request."""
    # Drops list markers, Read's line numbers and console timestamps; the message is kept as is.
    lines = [re.sub(r'^(?:[-*]\s+|\d+\t\s*|\[\s*\d+ms\]\s*)+', '', l.strip()) for l in ev.get('text', '').splitlines() if l.strip()]
    for l in lines:
        if 'write-guard' in l:
            return l, YELLOW
    if ev.get('error'):
        for l in lines:
            if not l.startswith('#') and not l.startswith('```'):
                return l, RED
    counts = re.compile(r'Console: [1-9]\d* errors?(, \d+ warnings?)?')
    for l in lines:
        if re.search(r'Failed to fetch|net::ERR|\[FAILED\]|\bError\b', l) and not counts.fullmatch(l):
            return l, RED
    for l in lines:
        if counts.fullmatch(l):
            return l, DIM  # only a count of console messages, not an error itself
    return None


def hidden_call(ev):
    """Claude Code's own tool loading and the browser_tabs listing: setup, not the task."""
    return ev['name'] == 'ToolSearch' or (short_name(ev['name']) == 'browser_tabs' and (ev.get('input') or {}).get('action') == 'list')


class Film:
    def __init__(self, prompt):
        self.prompt_text = prompt
        self.prompt = wrap(prompt, TERM_COLS, '> ', '  ')
        self.header = '$ claude -p'
        self.term = []  # wrapped lines: list of segments (text, color, font)
        self.logs = []  # (text, color, font)
        self.fresh = set()  # indexes in logs of the refusals new in this frame
        self.hidden = False
        self.hidden_ids = set()
        self.writes = 0
        self.shot = None
        self.shot_file = None
        self.url = ''
        self.t = 0
        self.anchor = 0
        self.result = None

    def block(self, rows, anchor=True):
        if self.term:
            self.term.append([])
        if anchor:
            self.anchor = len(self.term)  # the newest message is shown from its first line
        self.term += rows

    def apply(self, ev):
        k = ev['kind']
        if k == 'init':
            servers = ', '.join(f"{s.get('name')} {s.get('status')}" for s in ev.get('mcp') or [])
            self.header = f"$ claude -p   {ev.get('model')}   MCP: {servers}"
        elif k == 'text':
            lines = wrap(ev['text'], TERM_COLS, '  ', '  ')
            self.block([[('● ', ORANGE, F), (lines[0][2:], FG, F)]] + [[(l, FG, F)] for l in lines[1:]])
        elif k == 'tool':
            if hidden_call(ev):
                self.hidden = True
                if ev.get('id'):
                    self.hidden_ids.add(ev['id'])
                return
            name = short_name(ev['name'])
            lines = wrap(name + '  ' + summary(ev['name'], ev.get('input')), TERM_COLS, '  ', '    ', max_lines=2)
            first = lines[0][2:]
            self.block([[('● ', TEAL, F), (first[:len(name)], FG, FB), (first[len(name):], DIM, F)]] + [[(l, DIM, F)] for l in lines[1:]])
        elif k == 'tool_result':
            hit = highlight(ev)
            if hit and (ev.get('id') in self.hidden_ids or hit[0].startswith('Error: Ref')):
                self.hidden = True  # a hidden call's result, or a stale snapshot reference
                return
            if hit:
                for i, l in enumerate(wrap(hit[0], TERM_COLS, '  └ ', '    ', max_lines=2)):
                    self.term.append([(l, hit[1], F)])
        elif k == 'result':
            secs = round((ev.get('ms') or 0) / 1000)
            done = f"{'stopped with an error' if ev.get('error') else 'done'}: {ev.get('turns')} turns, {secs // 60}m {secs % 60:02d}s"
            self.block([[(done, RED if ev.get('error') else DIM, F)]], anchor=False)
            self.result = (ev.get('text') or '', done, RED if ev.get('error') else DIM)
        elif k == 'shot':
            self.shot_file, self.url = ev['file'], ev.get('url', '')
            self.shot = None
        elif k == 'server':
            write = ev['method'] not in ('GET', 'HEAD')
            self.writes += write
            self.logs.append((f"server  {ev['method']} {ev['path']}"[:LOG_COLS], RED if write else DIM, FSB if write else FS))
        elif k == 'guard':
            if ev.get('type') == 'control':
                text = f'guard   refused "{ev.get("label", "")}"'
            else:
                text = f"guard   refused {ev.get('method') or 'WEBSOCKET'} {ev.get('url')}: {ev.get('reason')}"
            for l in textwrap.wrap(commas(text), LOG_COLS, subsequent_indent=' ' * 8)[:2]:
                self.fresh.add(len(self.logs))
                self.logs.append((l, YELLOW, FS))

    def render(self):
        im = Image.new('RGB', (W, H), BG)
        d = ImageDraw.Draw(im)
        # Title strip.
        d.rectangle([0, 0, W, TITLE_H], fill=TITLE_BG)
        d.text((PAD, 8), 'Claude Code + Playwright MCP, in a browser guarded by ', font=F, fill=FG)
        d.text((PAD + F.getlength('Claude Code + Playwright MCP, in a browser guarded by '), 8), 'playwright-write-guard', font=FB, fill=ORANGE)
        secs = max(0, self.t) // 1000
        clock = f'real time {secs // 60}:{secs % 60:02d}'
        d.text((W - PAD - F.getlength(clock), 8), clock, font=F, fill=DIM)
        if self.result:
            return self.render_result(im, d)

        # Agent pane: header, the pinned prompt, then the newest lines.
        y = TITLE_H + 10
        d.text((PAD, y), self.header[:int((LEFT_W - 2 * PAD) // FS.getlength('M'))], font=FS, fill=DIM)
        y += LOG_LINE
        if self.hidden:
            d.text((PAD, y), 'setup calls hidden', font=FS, fill=DIM)
        y += LOG_LINE + 8
        box_h = len(self.prompt) * LINE + 12
        d.rounded_rectangle([PAD - 6, y - 4, LEFT_W - PAD + 6, y + box_h - 4], radius=6, fill=PROMPT_BG)
        for l in self.prompt:
            d.text((PAD, y + 2), l, font=FB, fill=FG)
            y += LINE
        y += 18
        rows = (H - y - PAD) // LINE
        first = min(max(0, len(self.term) - rows), self.anchor)
        for line in self.term[first:first + rows] if rows > 0 else []:
            x = PAD
            for text, color, f in line:
                d.text((x, y), text, font=f, fill=color)
                x += f.getlength(text)
            y += LINE

        # Browser: address bar and screenshot.
        x0 = LEFT_W
        d.rectangle([x0, TITLE_H, W, H], fill=RIGHT_BG)
        d.rounded_rectangle([x0 + GAP, TITLE_H + 6, W - GAP, TITLE_H + 6 + BAR_H], radius=6, fill=LOG_BG)
        d.text((x0 + GAP + 10, TITLE_H + 11), self.url[:LOG_COLS], font=FS, fill=DIM)
        shot_w = W - x0 - 2 * GAP
        top = TITLE_H + 6 + BAR_H + 4
        if self.shot_file and self.shot is None:
            src = Image.open(self.shot_file).convert('RGB')
            self.shot = src.resize((shot_w, round(src.height * shot_w / src.width)), Image.LANCZOS)
        shot_h = round(800 * shot_w / 1280)
        if self.shot:
            im.paste(self.shot.crop((0, 0, shot_w, shot_h)), (x0 + GAP, top))

        # Log pane: what the shop received and what the guard refused.
        ly = top + shot_h + 6
        d.rectangle([x0 + GAP, ly, W - GAP, H - GAP], fill=LOG_BG)
        footer = f'writes received by the server: {self.writes}'
        fy = H - GAP - LOG_LINE - 6
        rows = (fy - ly - 8) // LOG_LINE
        shown = min(rows, len(self.logs)) if rows > 0 else 0
        yy = fy - 4 - shown * LOG_LINE
        for j in range(len(self.logs) - shown, len(self.logs)):
            text, color, f = self.logs[j]
            if j in self.fresh:
                d.rectangle([x0 + GAP + 4, yy - 1, W - GAP - 4, yy + LOG_LINE - 2], fill=BAND)
            d.text((x0 + GAP + 10, yy), text, font=f, fill=color)
            yy += LOG_LINE
        d.line([x0 + GAP + 10, fy - 2, W - GAP - 10, fy - 2], fill=PROMPT_BG)
        d.text((x0 + GAP + 10, fy + 2), footer, font=FSB, fill=RED if self.writes else GREEN)
        return im

    def render_result(self, im, d):
        """The last frame: the agent's final message across the whole width, so it fits."""
        cols = int((W - 2 * PAD) // F.getlength('M'))
        y = TITLE_H + 10
        d.text((PAD, y), self.header + ('   setup calls hidden' if self.hidden else ''), font=FS, fill=DIM)
        prompt = wrap(self.prompt_text, cols, '> ', '  ')
        y += LOG_LINE + 12
        d.rounded_rectangle([PAD - 6, y - 4, W - PAD + 6, y + len(prompt) * LINE + 8], radius=6, fill=PROMPT_BG)
        for l in prompt:
            d.text((PAD, y + 2), l, font=FB, fill=FG)
            y += LINE
        y += 18
        text, done, color = self.result
        lines = wrap(text, cols, '  ', '  ', max_lines=(H - y - PAD - LINE - 6) // LINE)
        d.text((PAD, y), '● ', font=F, fill=ORANGE)
        for l in lines:
            d.text((PAD, y), l, font=F, fill=FG)
            y += LINE
        fy = H - PAD - LINE
        d.text((PAD, fy), done, font=F, fill=color)
        footer = f'writes received by the server: {self.writes}'
        d.text((W - PAD - FB.getlength(footer), fy), footer, font=FB, fill=RED if self.writes else GREEN)
        return im


def frames(timeline, tmp):
    film = Film(timeline['prompt'])
    events = sorted(timeline['events'], key=lambda e: e['t'])
    out, prev, i = [], None, 0
    while i < len(events):
        t = events[i]['t']
        if film.shot_file:
            film.fresh = set()  # a refusal is highlighted on its first frame only
        while i < len(events) and events[i]['t'] <= t + GROUP_MS:
            film.apply(events[i])
            i += 1
        if not film.shot_file:
            continue  # the film starts with the first screenshot
        film.t = t
        im = film.render()
        raw = im.tobytes()
        if raw == prev:
            continue  # unchanged: the earlier frame lasts until the next change
        prev = raw
        path = os.path.join(tmp, f'f{len(out):05d}.png')
        im.save(path, compress_level=1)
        out.append({'t': t, 'file': path, 'hold': bool(film.fresh)})
    return out


def encode(spec, out):
    n = len(spec)
    gap = lambda i: spec[i + 1]['t'] - spec[i]['t']
    # Real time, except an unchanged stretch over 2 s plays as 1 s, the first frame after each
    # guard refusal is held 3 s and the last frame 8 s.
    dur = [LAST_MS if i + 1 == n else HOLD_MS if spec[i]['hold'] else (1000 if gap(i) > 2000 else max(20, gap(i))) for i in range(n)]

    def attempt(stride, scale):
        # Always keeps the held refusals and ends on the agent's last message.
        keep = sorted(set(range(0, n, stride)) | {i for i in range(n) if spec[i]['hold']} | {n - 1})
        ms = [sum(dur[k:keep[j + 1]]) if j + 1 < len(keep) else dur[k] for j, k in enumerate(keep)]
        w, h = round(W * scale), round(H * scale)

        def load(k):
            im = Image.open(spec[k]['file']).convert('RGB')
            return im if scale == 1 else im.resize((w, h), Image.LANCZOS)

        # One palette for every frame, so an unchanged pixel keeps its color and each frame
        # stores only the region that changed. It is built from a sample of frames plus the
        # pane colors, so small text colors get their own entries.
        sample = keep[:: max(1, len(keep) // 12)][:12] + [keep[-1]]
        sw = 64
        montage = Image.new('RGB', (w, h * len(sample) + sw))
        for j, k in enumerate(sample):
            montage.paste(load(k), (0, h * j))
        for j, c in enumerate(UI_COLORS):
            montage.paste(c, (j * sw, h * len(sample), (j + 1) * sw, h * len(sample) + sw))
        palette = montage.quantize(256, method=Image.Quantize.MEDIANCUT)
        frames_p = (load(k).quantize(palette=palette, dither=Image.Dither.NONE) for k in keep)
        next(frames_p).save(out, save_all=True, append_images=frames_p, duration=ms, loop=0)
        return w, len(keep)

    for stride, scale in [(1, 1), (2, 1), (2, .75), (3, .75), (3, .5), (4, .5)]:
        w, kept = attempt(stride, scale)
        size = os.path.getsize(out)
        print(f'{kept} frames at {w} px wide: {size} bytes, {sum(dur) / 1000:.1f} s')
        if size < LIMIT_BYTES:
            return
        print(f'over {LIMIT_BYTES} bytes, trying fewer frames or a smaller width')
    sys.exit('still over the size limit')


def main():
    if len(sys.argv) != 3:
        sys.exit('usage: python3 demo/shop/compose.py <timeline.json> <out.gif>')
    with open(sys.argv[1]) as fh:
        timeline = json.load(fh)
    with tempfile.TemporaryDirectory(prefix='wg-compose-') as tmp:
        spec = frames(timeline, tmp)
        if not spec:
            sys.exit('the timeline has no events')
        encode(spec, sys.argv[2])


if __name__ == '__main__':
    main()
