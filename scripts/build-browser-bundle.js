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

// Get version from package.json for cache busting
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const version = packageJson.version;

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
    'process.env.BLE_MCP_MOCK_LOG_RETRIES': '"true"',
    '__PACKAGE_VERSION__': JSON.stringify(version)
  }
});

// Read the generated bundle
const bundlePath = join(projectRoot, 'dist/web-ble-mock.bundle.js');
let bundleContent = readFileSync(bundlePath, 'utf8');

// The IIFE sets window.WebBleMock inside, but we need to ensure it's actually set
// Add version info and verification
const fixExports = `
/**
 * ble-mcp-test Web Bluetooth Mock - Version ${version}
 * 
 * Documentation & Examples:
 * - GitHub: https://github.com/ble-mcp-test/ble-mcp-test
 * - Examples: https://github.com/ble-mcp-test/ble-mcp-test/tree/main/examples
 * - Docs: https://github.com/ble-mcp-test/ble-mcp-test/tree/main/docs
 * 
 * Quick Start (v0.6.0+):
 * window.WebBleMock.injectWebBluetoothMock({
 *   sessionId: 'test-session-' + os.hostname(),  // Required: unique session ID
 *   serverUrl: 'ws://localhost:8080',            // Required: bridge server URL
 *   service: '9800'                              // Required: service UUID
 * });
 * 
 * See examples/smart-mock-helper.ts for auto-detection of dev vs CI context
 */
// Bundle version: ${version}
if (typeof window !== 'undefined' && window.WebBleMock) {
  window.WebBleMock.version = '${version}';
  console.log('[WebBleMock] Bundle loaded successfully, version: ${version}, exports:', Object.keys(window.WebBleMock));
  console.log('[WebBleMock] Documentation: https://github.com/ble-mcp-test/ble-mcp-test');
} else {
  console.error('[WebBleMock] Bundle failed to create window.WebBleMock');
}
`;

bundleContent += fixExports;

// Write the modified bundle
writeFileSync(bundlePath, bundleContent);

// Also create a versioned copy for cache busting
const versionedPath = join(projectRoot, 'dist', `web-ble-mock.bundle.v${version}.js`);
writeFileSync(versionedPath, bundleContent);

console.log(`✅ Browser bundle built with proper exports (v${version})`);