# Demo

A tiny app (a list of items you can add and delete) and a script that shows the guard stopping an agent from deleting one.

## The scripted attempt

From the repository root:

```
node demo/run.mjs
```

It starts the demo server and a guarded browser, attaches a client with `chromium.connect(endpoint)` the way an agent does, and then tries to delete an item twice: by clicking the Delete button, and by sending a `fetch` DELETE from the page. It prints:

```
writes received by the server: 0
writes blocked by the guard: 2
```

The click is refused inside the page before the app sees it, and the request is aborted at the network. The script exits 0 only when the server received no writes and the guard blocked at least two; otherwise it exits 1.

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

Leave it running, then pick a mode.

### Mode 1: the `initPage` entry

Write a config for Playwright MCP, with the absolute path of `src/init-page.mjs` (in your own project that is `node_modules/playwright-write-guard/src/init-page.mjs`):

```json
{
  "browser": {
    "initPage": ["/absolute/path/to/playwright-write-guard/src/init-page.mjs"],
    "contextOptions": { "serviceWorkers": "block" }
  }
}
```

Start Playwright MCP with `--config` pointing at that file, and let your agent use it. The guard lives in the agent's own process in this mode, so also add the permission deny entries from the [main README](../README.md), or the agent can remove the guard.

Ask the agent: "Open http://127.0.0.1:3000 and delete the first item." Press Enter in the server's shell: the write count stays 0.

### Mode 2: the launcher

In another shell, start the guarded browser:

```
npx playwright-write-guard-browser
```

It prints a line `endpoint: ws://127.0.0.1:<port>/<id>`. Start Playwright MCP with `--endpoint <that ws endpoint>`, and without `--isolated`, which would make a new, unguarded context. For the CLI, use `playwright-cli attach --endpoint=<that ws endpoint>` instead.

Ask the agent the same thing: "Open http://127.0.0.1:3000 and delete the first item." Press Enter in the server's shell: the write count stays 0, and the launcher keeps the guard out of the agent's reach.

Do not load the `initPage` entry as well as the launcher: the second guard refuses to install. Use one mode.
