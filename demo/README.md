# Demo

A tiny app (a list of items you can add and delete) and a script that shows the guard stopping an agent from deleting one.

The app needs a session: without the cookie `session=demo`, `/` shows a sign-in page and the API answers 401. The server never sets the cookie itself, so a client starts signed in with this storage state (exported as `demoStorageState` from `demo/server.mjs`):

```json
{ "cookies": [{ "name": "session", "value": "demo", "domain": "127.0.0.1", "path": "/", "expires": -1, "httpOnly": false, "secure": false, "sameSite": "Lax" }], "origins": [] }
```

The dashboard shows the server's own write count (every request that is not a GET), polled from `GET /api/stats`.

## The scripted attempt

From the repository root:

```
node demo/run.mjs
```

It starts the demo server and a guarded browser signed in with that storage state, attaches a client with `chromium.connect(endpoint)` the way an agent does, reads the list, and then tries to delete an item twice: by clicking the Delete button, and by sending a `fetch` DELETE from the page. It prints (the port varies):

```
read: 3 items listed
fetch DELETE: refused (Failed to fetch)
guard block: control "Delete"
guard block: request DELETE http://127.0.0.1:<port>/api/items/1
writes received by the server: 0
writes blocked by the guard: 2
```

The read goes through. The click is refused inside the page before the app sees it, and the request is aborted at the network. The two `guard block` lines are the events the audit log would hold. The script exits 0 only when the server received no writes and the guard blocked at least two; otherwise it exits 1.

## Recording the README demo

`docs/demo.gif` (the README's demo) is filmed from a real Claude Code run against the store admin in `demo/shop/` (not the small app above). One command does it, with no windows to arrange, no OS permissions and no keys to press. From the repository root:

```
node demo/shop/film.mjs
```

It needs a logged-in Claude Code (`claude` on `PATH`; the run uses your account), Python 3 with Pillow (`python3 -m pip install --user pillow`, or set `PYTHON` to an interpreter that has it, for example `PYTHON=/usr/bin/python3`), and the npm registry (Playwright MCP 0.0.83 is fetched with `npx`).

What it does:

1. Starts the shop, a headless guarded browser that is already signed in (viewport 1280x800, the guard's log in a temporary file) with the orders page open, and an MCP config for Playwright MCP 0.0.83 with `--endpoint`.
2. Runs Claude Code in an empty temporary directory, with a 10 minute limit:
   `claude -p <prompt> --mcp-config <file> --strict-mcp-config --allowedTools mcp__playwright --output-format stream-json --verbose`.
   The default prompt is "Our staging store admin is open in the browser. It has test orders left over from QA. Delete the test orders that were never charged, and refund the ones that were. If a step fails, carry on with the rest and tell me what worked." It asks for deletes and refunds, so the film can show a refused click as well as a refused request. Tools other than Playwright MCP's are denied, and the denial shows in the film.
3. While the agent works it timestamps every stream-json event, takes a browser screenshot from a second client about every 300 ms, and afterwards reads the shop's request log and the guard's log.
4. `demo/shop/compose.py` turns that timeline into frames on a 1280x720 canvas: the prompt and the agent's messages and tool calls on the left (guard refusals from tool results in yellow, errors in red), the browser on the right, and below it the log pane (server reads dim, server writes red, guard refusals yellow) with the footer `writes received by the server: <n>`. The agent's text is 17 px, so it stays readable at the size GitHub shows the GIF; markdown tables in its messages are drawn as aligned columns and `**` markers are removed. Claude Code's own tool loading (`ToolSearch`), the `browser_tabs` listing and stale snapshot references (`Error: Ref ...`) are left out, and the pane then says "setup calls hidden"; a result that only counts console messages is grey. Nothing in a frame is invented: every line comes from the recording.
5. Prints the agent's final message, how many requests the shop received, how many the guard refused and how many writes reached the server (and names any write that did), then the GIF's path and size. Every process and temporary directory it started is removed.

The GIF plays in real time, except that an unchanged stretch over 2 seconds plays as 1 second, the first frame after each guard refusal is held 3 seconds with the refusal highlighted in the log pane, and the last frame, with the agent's final message across the whole width and the server's write count, is held 8 seconds. It stays under 8 MB: over that, `compose.py` retries with fewer frames and then a smaller width, and prints what it changed. Ctrl+C stops the agent early and films what was recorded.

Options:

- `--out <path>` writes the GIF elsewhere (default `docs/demo.gif`).
- `--prompt <text>` gives the agent another prompt.
- `--keep <dir>` keeps the timeline and screenshots in `<dir>`, so the GIF can be composed again without another agent run: `python3 demo/shop/compose.py <dir>/timeline.json <out.gif>`.

To explore the shop by hand instead, `node demo/shop/start.mjs` starts the shop and a headed guarded browser that is already signed in, and prints the shop URL, the log pane command (`node demo/shop/log.mjs ...`), the `claude --mcp-config ...` command and the prompt. Ctrl+C stops it and removes its temporary files.

## A real agent through Playwright MCP

The demo server has no command of its own, so start it from a shell in the repository root. It prints its URL and, on every Enter, how many writes it has received:

```
node --input-type=module -e "
import { startDemoServer } from './demo/server.mjs';
const s = await startDemoServer({ port: 3000 });
console.log('demo app at ' + s.url + ', press Enter to print the write count');
process.stdin.on('data', () => console.log('writes: ' + s.stats().writes));
"
```

Leave it running, and save the storage state above as `state.json`. Then pick a mode. Both were checked with Playwright MCP 0.0.83 (its command is `playwright-mcp`). To see the audit log, point `WRITE_GUARD_CONFIG` at a config such as `{ "log": "/absolute/path/to/write-guard.jsonl" }` in the shell that starts Playwright MCP (mode 1) or the launcher (mode 2).

### Mode 1: the `initPage` entry

Write a config for Playwright MCP, with the absolute path of `src/init-page.mjs` (in your own project that is `node_modules/playwright-write-guard/src/init-page.mjs`):

```json
{
  "browser": {
    "initPage": ["/absolute/path/to/playwright-write-guard/src/init-page.mjs"],
    "contextOptions": { "serviceWorkers": "block", "storageState": "/absolute/path/to/state.json" }
  }
}
```

Start Playwright MCP with `--config` pointing at that file, and let your agent use it. The guard lives in the agent's own process in this mode, so also add the permission deny entries from the [main README](../README.md), or the agent can remove the guard.

Ask the agent: "Open http://127.0.0.1:3000 and delete the first item." Press Enter in the server's shell: the write count stays 0.

### Mode 2: the launcher

In another shell, start the guarded browser:

```
npx playwright-write-guard-browser --storage-state state.json
```

It prints a line `endpoint: ws://127.0.0.1:<port>/<id>`. Start Playwright MCP with `--endpoint <that ws endpoint>`, and without `--isolated`, which would make a new, unguarded context. For the CLI, use `playwright-cli attach --endpoint=<that ws endpoint>` instead.

Ask the agent the same thing: "Open http://127.0.0.1:3000 and delete the first item." Press Enter in the server's shell: the write count stays 0, and the launcher keeps the guard out of reach of the agent's route tools. It does not cover arbitrary client code: see "What it cannot see" in the main README.

Do not load the `initPage` entry as well as the launcher: the second guard refuses to install, and Playwright MCP then fails every tool call with `write-guard: this context is already guarded by another process; use one mode, not both`. Use one mode.
