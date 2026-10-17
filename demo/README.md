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

## Re-recording the GIF

`docs/demo.gif` (the README's demo) is made by one script, from the repository root:

```
node demo/record.mjs
```

It installs `@playwright/mcp@0.0.83` into a temporary directory (so it needs the npm registry), writes the storage state above to a file, and starts the demo server and the launcher with `startGuardedBrowser({ storageState, headless: true })`. Playwright MCP attaches with `--endpoint` and acts as the agent: it navigates to the dashboard, takes a snapshot and clicks Delete. A second client on the same endpoint takes a screenshot about every 150 ms and draws a caption bar (the agent's step, then the guard's console warning); the app does not draw it. The script exits 1, and writes no GIF, if the guard printed no refusal or the server received a write.

The frames are turned into the GIF with Python 3 and Pillow: `python3` must be on `PATH` with Pillow installed (`python3 -m pip install --user pillow`), or point `PYTHON` at an interpreter that has it, for example `PYTHON=/usr/bin/python3 node demo/record.mjs`. The temporary directory and every process are removed at the end.

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
