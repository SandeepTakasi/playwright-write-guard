# CLAUDE.md

Guide for contributors and coding agents working in this repository.

## Project shape

- `playwright-write-guard` is a zero-dependency ESM package (`"type": "module"`) with no build step. Source lives in `src/`, type declarations in `types/`, and the browser CLI in `bin/`.
- Do not add a bundler, a transpiler, or a runtime dependency. Prefer the Node standard library and the Playwright APIs already in use.
- The limits are listed twice, in `docs/limits.md` and under `## What it cannot see` in `docs/api.md` (the README shows only a five-row table that links to `docs/limits.md`). Change both together, and add a limit there whenever a test or experiment shows the guard does not cover something.
- Source comments must not claim more than the README's limits do (no "cannot bypass", "everything else is refused").
- Keep changes small and in the files the task owns.

## Workflow

- Run `npm test` before every commit. Do not commit while it fails.
- Write and edit files with the Write and Edit tools, never through Bash (no `cat >`, `sed -i`, heredocs, or `echo >` into tracked files).
- Commit messages use a sentence-case imperative subject (for example "Add read-only route guard") followed by a body that explains why the change was made.

## Tests

- Every guard rule needs a test that fails when the rule is reverted or weakened. Check a new rule by breaking it on purpose in a scratch copy and watching a test fail; a green suite alone proves nothing.
- Each mutation check runs in its own scratch folder: parallel runs that share one overwrite each other's copies and report false kills.
- A scratch copy may symlink the repo's `node_modules`, but never runs `npm install` in it: the install rewrites the repo's own dependencies. Restore them with `npm ci` if that happens.
- A long mutation run needs AC power and `caffeinate -i`: a sleeping machine turns kills into timeouts and leaves orphaned browsers. Re-run any mutant killed only by a timeout, or killed unusually slowly, before counting it.
- Tests never reach the network: serve every page and API with routes on `https://app.test`. `context.request`, `page.request` and `route.fetch()` do not pass through context routes (Playwright 1.64), so never send to `app.test` through them; use a real 127.0.0.1 server instead. A route registered after the guard that fulfills requests is a mock, not the server: count writes on a real 127.0.0.1 server or a route registered before `install`.
- In-page control tests attach the app's handlers with `addEventListener`. A plain element with only an `onclick` attribute is no longer a control, so a test written with `onclick` attributes on non-control elements tests nothing.
- A test that spawns the command gives it a timeout, so a regression that keeps the command running fails the test instead of hanging the run.
- CI runs Node 20, 22 and 24. Compare URLs in parsed form (`new URL(x).href`): Node 24 and Chromium percent-encode `^` in a path, and Chromium also `|`, so a raw string can differ from what the guard logs.
- Playwright 1.64 refuses the `context` fixture in `beforeAll` and `afterAll`: those hooks set up only worker fixtures and fixtures marked `auto: 'all-hooks-included'`. A fixture a `beforeAll` may use, such as `request`, must not depend on `context`.
- A console message sent to a frame that is navigating away never reaches `page.on('console')`, so a test that something does not warn during a navigation checks the call into the frame (for example by wrapping its `evaluate`), not the console.
- A WebSocket test serves its page from the echo server's own `http://127.0.0.1` origin: a page on `https://app.test` cannot open `ws://127.0.0.1` (mixed content).
- Playwright 1.64 does not route every request a page makes: requests from a frame it no longer tracks (a page being closed or left, from `pagehide`, `visibilitychange` or `unload`), HTTP from a SharedWorker, and `fetchLater` go straight out. A test for these counts writes on a real 127.0.0.1 server, never through a route, and asserts on beacons and `keepalive` fetches, which reliably arrive, not on ordinary fetches that may be cancelled with the page.
- After a Playwright upgrade, re-check the internals the guard and its tests rely on before trusting a green run: the `PWTEST_SERVER_REGISTRY` directory (the launcher's title test), `context._options.baseURL` and `testInfo._timeoutManager._running.runnable` (the fixture), and the `fetch` and `_innerFetch` option merge in `coreBundle.js`, which request-client judging copies (a mismatch there is a bypass).
- The peer dependency floor is the oldest Playwright the whole suite passes on reliably (1.64: on 1.59 the launcher cannot connect, and on 1.60 to 1.63 the browser often drops an allowed write from a closing page). Before lowering it, run `npm test` on that version in a fresh scratch copy, one version at a time, since parallel runs overload the machine and fail everywhere. CI runs the pinned version on Node 20, 22 and 24, and each version in the `playwright` list of `.github/workflows/test.yml`; add new Playwright minors there.
- Start Playwright MCP from a temporary directory, never the repo: it writes a `.playwright-mcp/` folder into its working directory.

## Writing style

- No em dashes or en dashes in anything written: code, comments, docs, examples, commit messages, or CLI output. Use commas, colons, or parentheses instead.

## Personal and host data

- Nothing about any client or host project may enter tracked files, examples, fixtures, commit messages, or history.
- Nothing personal may enter those places either, beyond the author credit in `LICENSE` and `package.json`.
- Use neutral nouns in examples and tests. Use `.test` or `example.com` for hosts.
- The untracked term list is kept outside the repository. It must never be committed, copied, or quoted in any tracked file or commit message.

## Commit identity

- Every commit's author and committer email must be the repo-local address. Check it with `git config --local user.email`.
- Never commit with a global or work address.
- Pushes go through `gh` (this repo's credential helper is `gh auth git-credential`). Before pushing, check `gh auth status` shows the account that owns the repository as active.

## Before every commit and push

Run the history-wide check over commit messages and the author and committer fields. The untracked term list supplies the pattern:

```bash
git log --all -p --format='%H %an %ae %cn %ce%n%B' | grep -iE "<pattern from the untracked term list>"
```

It must print nothing. If it prints anything, stop and fix the match before committing or pushing.

## Publishing

- The maintainer runs `npm publish` in an interactive terminal: the npm account uses security-key 2FA, which an agent cannot complete. Before it, run the history-wide check, confirm HEAD is pushed, and read `npm pack --dry-run` (only `src`, `bin`, `types`, `README.md`, `LICENSE`, `package.json`).
- If `npm whoami` fails, log in again with `npm login --auth-type=web` (it opens the browser; no one-time code to type).
- Release notes list every breaking change, including changes to the type declarations, and the version bump follows them (a minor version while below 1.0).
