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

export const SHARED_TEST_CONFIG = {
  // Fixed session ID for all tests - ensures session reuse works across test runs
  sessionId: `ble-mcp-e2e-${os.hostname()}`,
  
  // BLE device configuration from environment
  service: process.env.BLE_MCP_SERVICE_UUID || '9800',
  write: process.env.BLE_MCP_WRITE_UUID || '9900',
  notify: process.env.BLE_MCP_NOTIFY_UUID || '9901',
  
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
 * Create NodeBleClient options with shared configuration
 */
export function createNodeClientConfig(overrides?: Partial<{
  sessionId: string;
  bridgeUrl: string;
  service: string;
  write: string;
  notify: string;
  deviceId?: string;
  deviceName?: string;
  debug?: boolean;
}>) {
  return {
    sessionId: SHARED_TEST_CONFIG.sessionId,
    bridgeUrl: SHARED_TEST_CONFIG.wsUrl,
    service: SHARED_TEST_CONFIG.service,
    write: SHARED_TEST_CONFIG.write,
    notify: SHARED_TEST_CONFIG.notify,
    deviceId: DEVICE_FILTERS.deviceId,
    deviceName: DEVICE_FILTERS.deviceName,
    debug: false,
    ...overrides
  };
}

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