#!/usr/bin/env node
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// First build TypeScript
await build({
  entryPoints: [join(projectRoot, 'src/mock-browser-entry.ts')],
  outfile: join(projectRoot, 'dist/mock-browser-entry.js'),
  platform: 'browser',
  format: 'esm',
  bundle: false
});

// Build the bundle using the browser entry point
await build({
  entryPoints: [join(projectRoot, 'dist/mock-browser-entry.js')],
  bundle: true,
  format: 'iife',
  outfile: join(projectRoot, 'dist/web-ble-mock.bundle.js'),
  platform: 'browser',
  define: {
    'process.env.BLE_MCP_MOCK_RETRY_DELAY': '"1200"',
    'process.env.BLE_MCP_MOCK_MAX_RETRIES': '"20"',
    'process.env.BLE_MCP_MOCK_CLEANUP_DELAY': '"1100"',
    'process.env.BLE_MCP_MOCK_BACKOFF': '"1.3"',
    'process.env.BLE_MCP_MOCK_LOG_RETRIES': '"true"'
  }
});

// Read the generated bundle
const bundlePath = join(projectRoot, 'dist/web-ble-mock.bundle.js');
let bundleContent = readFileSync(bundlePath, 'utf8');

// The IIFE sets window.WebBleMock inside, but we need to ensure it's actually set
// Add a verification and log
const fixExports = `
// Verify WebBleMock is available globally
if (typeof window !== 'undefined' && window.WebBleMock) {
  console.log('[WebBleMock] Bundle loaded successfully, exports:', Object.keys(window.WebBleMock));
} else {
  console.error('[WebBleMock] Bundle failed to create window.WebBleMock');
}
`;

bundleContent += fixExports;

// Write the modified bundle
writeFileSync(bundlePath, bundleContent);

console.log('✅ Browser bundle built with proper exports');