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
  // No `define`. It used to substitute __PACKAGE_VERSION__ -- now the generated
  // src/version.ts -- and five BLE_MCP_MOCK_* environment reads, which the mock
  // now resolves at runtime through `globalThis.process?.env`. Both were the same
  // defect: a value with a second source that agrees with the first only for as
  // long as somebody keeps checking. The cleanup-delay define said 1100 while the
  // source default said 250, so every browser test paid 4.4x the measured figure.
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
 *   serverUrl: 'ws://localhost:25153',            // Required: bridge server URL
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