import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    watch: false,
    reporters: ['default'],
    // Force exit after tests complete
    onConsoleLog(log) {
      // Filter out noisy logs
      if (log.includes('[NobleTransport]') || log.includes('[BridgeServer]')) {
        return false;
      }
    },
  },
});