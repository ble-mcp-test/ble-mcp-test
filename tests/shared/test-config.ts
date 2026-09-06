/**
 * Shared Test Configuration - Single Source of Truth
 * 
 * Common configuration and connection builders used across all test suites.
 * This ensures consistent session management and connection patterns.
 */

import os from 'os';

/**
 * Standard test configuration shared across E2E and integration tests
 */
function requireWsUrl(): string {
  const url = process.env.BLE_WEBSOCKET_URL;
  if (!url) {
    throw new Error(
      'BLE_WEBSOCKET_URL is not set. The bridge has no default port, so there is ' +
        'no URL to guess -- set it to ws://<host>:<BLE_MCP_WS_PORT>.'
    );
  }
  return url;
}

/** Chrome's canonical UUID form. Restated here so a bad env value fails at
 *  config time with a message, not later as a TypeError from inside the mock. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requireUuid(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. This repo is device-agnostic: there is no default GATT ` +
        'UUID to fall back to, and the CS108 is the reference device, not a requirement. ' +
        'See the @owner e2e-harness block in .env.local.example.'
    );
  }
  if (!CANONICAL_UUID.test(value)) {
    throw new Error(
      `${name}='${value}' is not a canonical UUID. Real Web Bluetooth accepts only a ` +
        "full lowercase 128-bit UUID (e.g. '00009800-0000-1000-8000-00805f9b34fb') or a " +
        'numeric alias, and rejects short forms and uppercase hex with a TypeError. ' +
        'The mock matches it -- see docs/design/2026-08-27-client-contract.md.'
    );
  }
  return value;
}

/**
 * The one place a session id is built.
 *
 * A session id tells the bridge WHICH REPO is holding the reader. Platform's is
 * `trakrf-platform-dev-${hostname}`; every client of ours carries `ble-mcp-`.
 * That prefix is the only thing that makes the bridge's ownership log
 * self-attributing, and it is worth something precisely when two repos are
 * contending -- which is the moment nobody is in a position to go and ask.
 *
 * On 2026-08-31 the journal for one contested window showed this suite under two
 * unrelated names three seconds apart, one of them `test-ws-url-capture-xyz789`,
 * which is indistinguishable from any stray script on the box. Working out who
 * held the command path took twenty minutes and two wrong answers.
 *
 * **Stable per host, deliberately not unique per process.** The bridge matches a
 * reconnecting client against its own prior name to tell `DEVICE_BUSY_SELF` from
 * a foreign holder (TRA-1216), and connection reuse depends on the id not moving
 * between runs. A per-process id would make every reconnect look like a stranger
 * and undo that. Telling two clients WITHIN this repo apart is a different
 * problem and wants per-connection attribution in the bridge's log, not a
 * different session id.
 *
 * `tests/unit/no-dead-server-instructions.test.ts` fails on a bare literal in
 * `tests/e2e/`, so this is the enforced route rather than the recommended one.
 *
 * @param workload what this client is doing -- `e2e`, `ws-url-capture`. It ends
 *   up in the bridge journal, so name it the way you would want to read it there.
 */
export function bridgeSessionId(workload: string): string {
  return `ble-mcp-${workload}-${os.hostname()}`;
}

export const SHARED_TEST_CONFIG = {
  // Fixed session ID for all tests - ensures session reuse works across test runs
  sessionId: bridgeSessionId('e2e'),
  
  // BLE device configuration from environment.
  //
  // No literal fallback, for the same reason `wsUrl` has none -- and here the
  // fallback was worse than a guess. '9800' is the CS108's service: a run with
  // no env set would silently point at ONE vendor's reader while this repo is
  // device-agnostic by design, and against real Chromium that spelling is not a
  // UUID at all (it throws TypeError; see docs/design/2026-08-27-client-contract.md).
  service: requireUuid('BLE_MCP_SERVICE_UUID'),
  write: requireUuid('BLE_MCP_WRITE_UUID'),
  notify: requireUuid('BLE_MCP_NOTIFY_UUID'),
  
  // WebSocket server URL
  // No literal fallback: renumbering the guess does not stop it being a guess.
  // e2e needs a real bridge anyway, so a missing URL should fail here rather
  // than 30s later as a connection timeout.
  wsUrl: requireWsUrl(),
  
  // Standard test timeout
  timeout: 30000
} as const;

/**
 * Environment-based device filtering (optional)
 */
export const DEVICE_FILTERS = {
  deviceId: process.env.BLE_MCP_DEVICE_IDENTIFIER,
  deviceName: process.env.BLE_MCP_DEVICE_NAME
} as const;

/**
 * Create Web Bluetooth mock config for E2E tests
 */
export function createWebBleMockConfig(overrides?: Partial<{
  sessionId: string;
  serverUrl: string;
  service: string;
  write: string;
  notify: string;
}>) {
  return {
    sessionId: SHARED_TEST_CONFIG.sessionId,
    serverUrl: SHARED_TEST_CONFIG.wsUrl,
    service: SHARED_TEST_CONFIG.service,
    write: SHARED_TEST_CONFIG.write,
    notify: SHARED_TEST_CONFIG.notify,
    ...overrides
  };
}