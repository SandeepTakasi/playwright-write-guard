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

`docs/demo.gif` (the README's demo) is a screen recording of a real Claude Code session: Claude Code in a terminal, a headed guarded browser, and a live log of what the shop server received and what the guard refused. The session runs against the store admin in `demo/shop/`, not against the small app above. You run Claude Code yourself; the scripts in `demo/shop/` set the rest up and record the screen. It needs macOS, Node, Claude Code (`claude`) and the npm registry (Playwright MCP 0.0.83 is fetched with `npx`).

1. **Prepare once.**
   - Grant Screen Recording permission to your terminal app: System Settings, Privacy and Security, Screen Recording, switch the terminal app on, then quit it and open it again. Without it the recorder stops and prints these steps.
   - The recorder builds the GIF with Python 3 and Pillow: `python3` must be on `PATH` with Pillow installed (`python3 -m pip install --user pillow`), or set `PYTHON` to an interpreter that has it, for example `PYTHON=/usr/bin/python3`.
   - Fetch Playwright MCP once so the take does not wait for the download: `npx -y @playwright/mcp@0.0.83 --help`.
2. **Start the shop and the guarded browser.** From the repository root, in a terminal you will not film:

   ```
   node demo/shop/start.mjs
   ```

   It starts the shop, opens a headed guarded browser that is already signed in, and prints five numbered steps with the exact commands: the shop URL, the log pane command, the recorder command, the `claude --mcp-config ...` command (with the `cd` to an empty directory before it) and the prompt to paste. Leave it running; Ctrl+C stops the browser and the shop and removes its temporary files.
3. **Arrange the windows.** Split the terminal in two: Claude Code on the left, the log pane on the right, and put the guarded browser window beside them, so all three are on screen at once. Run the printed log pane command in the right pane. To record only that part of the screen, give the recorder `--rect x,y,w,h` (points from the top left of the display). A rectangle also keeps the menu bar clock out of the picture, which would otherwise make every minute a new frame.
4. **Start the recorder.** In a third terminal, outside the filmed area (or minimised), run the printed `node demo/shop/record.mjs`, with `--rect` if you want one. It prints `Recording.` after its first capture succeeded and then counts the frames it has captured. Only the first frame is checked, so look at the finished GIF to be sure the windows are in it.
5. **Run Claude Code.** In the left pane run the printed `cd` and `claude --mcp-config ...` commands. Claude Code may ask you to approve the Playwright tools the first time; approve them before you start the recorder if you want a clean take. Paste the prompt: "Our staging store has test orders left over from QA. Clean them up, and refund any that were charged."
6. **Stop the recorder.** When the agent has finished, press Ctrl+C once in the recorder's terminal. It builds the GIF (this takes a while for a long take) and prints the path and size. A second Ctrl+C gives up without building it.
7. **Check the GIF.** Open `docs/demo.gif` (or the path given with `--out`) and confirm: the windows are visible, the shop is signed in, the agent's attempts are refused, and the log pane footer shows `writes received by the server: 0`.

The recorder takes a still with `screencapture -x -C` about every 250 ms and drops a still that is identical to the one before it. The GIF is at most 1280 px wide, every unchanged stretch over 2 seconds is shortened to 1 second, and it stays under 8 MB: if the first encode is over, the recorder retries with fewer frames and then a smaller width, and prints what it changed. Default output is `docs/demo.gif`; `--out <path>` writes elsewhere. Stills are kept in a temporary directory while recording (a retina display makes them a few megabytes each) and removed at the end.

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
