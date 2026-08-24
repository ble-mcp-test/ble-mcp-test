import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A worktree under .claude/worktrees/ is gitignored, so it is invisible to git —
 * but vitest globs the filesystem and does not consult gitignore. Without an
 * explicit exclude, `vitest run tests/unit` collects every sibling worktree's
 * tests as if they were this tree's.
 *
 * Observed 2026-08-24 on main with one worktree present: 7 files from the main
 * tree, 7 from the worktree, reported as one run of 14. The symptom is a PASSING
 * run with the wrong denominator — a dispatch in worktree A validating against
 * worktree B's code — which is why it went unnoticed through three separate
 * measurements (170, 85, 73), each honestly taken.
 */
describe('vitest worktree isolation', () => {
  const config = readFileSync(resolve(__dirname, '../../vitest.config.ts'), 'utf8');

  it('excludes sibling worktrees from collection', () => {
    const exclude = config.match(/exclude:\s*\[([^\]]*)\]/)?.[1];
    expect(exclude, 'no exclude array found in vitest.config.ts').toBeDefined();
    expect(
      exclude!.includes('.claude/worktrees'),
      'vitest.config.ts must exclude **/.claude/worktrees/** — without it, a run ' +
        'in one worktree silently collects every other worktree\'s tests and ' +
        'reports green over code that is not its own.',
    ).toBe(true);
  });
});
