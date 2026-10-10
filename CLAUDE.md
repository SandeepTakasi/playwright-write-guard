# CLAUDE.md

Guide for contributors and coding agents working in this repository.

## Project shape

- `playwright-write-guard` is a zero-dependency ESM package (`"type": "module"`) with no build step. Source lives in `src/`, type declarations in `types/`, and the browser CLI in `bin/`.
- Do not add a bundler, a transpiler, or a runtime dependency. Prefer the Node standard library and the Playwright APIs already in use.
- `README.md` lists the limits twice, under `## What it cannot see` and the API's `### What it cannot see`. Change both together, and add a limit there whenever a test or experiment shows the guard does not cover something.
- Source comments must not claim more than the README's limits do (no "cannot bypass", "everything else is refused").
- Keep changes small and in the files the task owns.

## Workflow

- Run `npm test` before every commit. Do not commit while it fails.
- Write and edit files with the Write and Edit tools, never through Bash (no `cat >`, `sed -i`, heredocs, or `echo >` into tracked files).
- Commit messages use a sentence-case imperative subject (for example "Add read-only route guard") followed by a body that explains why the change was made.

## Tests

- Every guard rule needs a test that fails when the rule is reverted or weakened. Check a new rule by breaking it on purpose in a scratch copy and watching a test fail; a green suite alone proves nothing.
- Tests never reach the network: serve every page and API with routes on `https://app.test`. `context.request` and `page.request` do not pass through context routes (Playwright 1.64), so never send to `app.test` through an unlocked request client.
- In-page control tests attach the app's handlers with `addEventListener`. An `onclick` attribute makes the element match `[onclick]` in the control selector and hides whether the other selector members work.
- A test that spawns the command gives it a timeout, so a regression that keeps the command running fails the test instead of hanging the run.
- The launcher's title test reads Playwright's internal `PWTEST_SERVER_REGISTRY` directory. After a Playwright upgrade, check it still exists before trusting that test.

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
