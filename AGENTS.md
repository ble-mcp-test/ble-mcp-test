# AGENTS.md

How we work in this repo. What the project *is* lives in `CLAUDE.md`.

## Git

- Never push to `main`. All changes via PR.
- Never squash or rebase merge — `gh pr merge --merge`.
- Never merge without explicit confirmation.
- Branch `<type>/<slug>` — e.g. `fix/gattserverdisconnected-on-explicit-disconnect`. Conventional commits: `feat:` `fix:` `docs:` `chore:` `refactor:` `test:`.
- Prefer incremental commits over amending.
- Fold a small in-scope discovery into the open PR as its own commit.

## Worktrees

`.claude/worktrees/<name>/`, created with the native `EnterWorktree` tool. Never manual `git worktree add`, never a root-level `.worktrees/` or a symlink to one. `git worktree list` is authoritative for cleanup.

## Tooling

**pnpm exclusively** — never `npm`, `npx`, or `yarn`. `npx` → `pnpm dlx` or `pnpm exec`. Python: `uv`, in `bridge/`. `just` is the cross-language front door.

## Verification

- Run the command before claiming completion; report actual output. No false optimism.
- A masking or renaming pass is verified by execution, not by grep.
- Ask of every negative assertion: what edit to the code under test would turn this red? No answer means it asserts a coincidence — `docs/design/2026-08-29-tests-that-assert-a-coincidence.md`.
- If tests fail, say so with the output. If a step was skipped, say that.

## Documentation

- No build-, ticket- or spec-specific documentation. Plans and investigations go to `docs/superpowers/` or `docs/notes/` — both gitignored, never committed.
- Durable findings are rewritten deliberately into `docs/design/`, the README, or `CLAUDE.md`, as a claim asserted now rather than a transcript of how it was found.
- Discount any dated or investigative document; verify against the code before acting on it.

## Style

- DELETE, don't deprecate. No `.old` files, no commented-out code.
- Keep files under 500 lines.
- Ask when requirements are unclear. Never delete code without explicit instruction.
