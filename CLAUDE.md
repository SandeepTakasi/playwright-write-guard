# CLAUDE.md

Guide for contributors and coding agents working in this repository.

## Project shape

- `playwright-write-guard` is a zero-dependency ESM package (`"type": "module"`) with no build step. Source lives in `src/`, type declarations in `types/`, and the browser CLI in `bin/`.
- Do not add a bundler, a transpiler, or a runtime dependency. Prefer the Node standard library and the Playwright APIs already in use.
- Keep changes small and in the files the task owns.

## Workflow

- Run `npm test` before every commit. Do not commit while it fails.
- Write and edit files with the Write and Edit tools, never through Bash (no `cat >`, `sed -i`, heredocs, or `echo >` into tracked files).
- Commit messages use a sentence-case imperative subject (for example "Add read-only route guard") followed by a body that explains why the change was made.

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

## Before every commit and push

Run the history-wide check over commit messages and the author and committer fields. The untracked term list supplies the pattern:

```bash
git log --all -p --format='%H %an %ae %cn %ce%n%B' | grep -iE "<pattern from the untracked term list>"
```

It must print nothing. If it prints anything, stop and fix the match before committing or pushing.
