import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
    }
  },
});