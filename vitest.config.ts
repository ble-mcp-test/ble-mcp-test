import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalTeardown: './tests/global-teardown.ts',
    setupFiles: ['./tests/vitest-setup.ts'],
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    exclude: ['**/e2e/**', '**/node_modules/**', '**/dist/**'],
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