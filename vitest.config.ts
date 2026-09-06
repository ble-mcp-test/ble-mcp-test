import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000,
    // TRA-1257. Some suites here need things only the BRIDGE host has --
    // flock(1), /proc, `getconf CLK_TCK`, lsof -- and arm B structurally
    // requires a host that is not the bridge's. They skip there rather than
    // failing, and this prints WHICH ones and why, on the way in and on the way
    // out. A quiet skip would make the gate green on a host that ran half of it.
    globalSetup: './tests/support/host-banner.ts',
    // '**/.claude/worktrees/**' is load-bearing: that directory is gitignored,
    // but globs do not consult gitignore, so without it a run collects every
    // sibling worktree's tests as this tree's own. See tests/unit/vitest-isolation.test.ts.
    // '**/*.spec.ts' is the file-naming convention that keeps the two runners
    // apart: *.test.ts is vitest, *.spec.ts is Playwright. tests/conformance/
    // holds one of each -- arm A and arm B of the same contract -- so the split
    // has to be by filename, not by directory.
    exclude: [
      '**/e2e/**',
      '**/*.spec.ts',
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/worktrees/**'
    ],
    // Force sequential execution for BLE singleton connection
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true
      }
    },
    // ALWAYS run once and exit, never watch
    watch: false,
    bail: 0,  // Don't bail on first failure
    // Force proper cleanup after tests
    teardown: true,
    // Ensure process exits after tests complete
    hookTimeout: 15000,
    // Don't keep process alive after tests
    isolate: true,
    // Force exit after tests complete
    forceExit: true
  },
});