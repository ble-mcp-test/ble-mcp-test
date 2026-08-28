// Test configuration for BLE bridge
// Can be overridden by environment variables

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env.local if it exists
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

export interface BridgeTestConfig {
  wsUrl: string;
  device: string;
  service: string;
  write: string;
  notify: string;
}

// Get complete test configuration from environment
// All values MUST come from environment - no hardcoded defaults
export function getTestConfig(): BridgeTestConfig {
  const device = process.env.BLE_MCP_DEVICE_IDENTIFIER || 
                 process.env.BLE_MCP_DEVICE_NAME || // Legacy support
                 process.env.BLE_MCP_DEVICE_MAC ||  // Legacy support
                 '';
                 
  const service = process.env.BLE_MCP_SERVICE_UUID || '';
  const write = process.env.BLE_MCP_WRITE_UUID || '';
  const notify = process.env.BLE_MCP_NOTIFY_UUID || '';
  
  const wsPort = process.env.BLE_MCP_WS_PORT || '25153';  // matches the bridge default
  const wsUrl = process.env.BLE_MCP_WS_URL || `ws://localhost:${wsPort}`;

  // Validate required configuration
  // Note: device can be empty string on Linux (searches by service UUID only)
  // Device identifier is optional - empty string means search by service only
  
  if (!service || !write || !notify) {
    throw new Error('BLE service/characteristic UUIDs missing. Set BLE_MCP_SERVICE_UUID, BLE_MCP_WRITE_UUID, and BLE_MCP_NOTIFY_UUID in .env.local');
  }

  return {
    wsUrl,
    device,
    service,
    write,
    notify
  };
}

// Helper to extract just device-related config
export function getDeviceConfig() {
  const config = getTestConfig();
  return {
    device: config.device,
    service: config.service,
    write: config.write,
    notify: config.notify
  };
}

/*
 * `WS_URL` and `setupTestServer()` were deleted by TRA-1186. Both had ZERO
 * consumers -- `getTestConfig` above is the only export anything imports
 * (tests/unit/config.test.ts).
 *
 * They described an architecture that no longer exists in any part: a
 * PM2-supervised Rust bridge on 8080 alongside a Node service on 8081. The
 * Rust spike and the TypeScript server are both deleted, nothing is
 * supervised by PM2, and the bridge is Python on 25153. The failure path even
 * told the reader to `pnpm start`, which has not been a script in this
 * package since the server was removed -- so the one instruction it gave on
 * the way out pointed at nothing.
 */

// Usage examples. UUIDs are the full lowercase 128-bit form because that is
// what the mock accepts -- since 0.8.0 it canonicalises the way real Chromium
// does and rejects short forms like `9800` with a TypeError.
//
// 1. Run tests with real BLE device (e.g., nRF52 dongle):
//    BLE_MCP_DEVICE_NAME=nRF52 \
//    BLE_MCP_SERVICE_UUID=0000180f-0000-1000-8000-00805f9b34fb \
//    BLE_MCP_WRITE_UUID=00002a19-0000-1000-8000-00805f9b34fb \
//    BLE_MCP_NOTIFY_UUID=00002a19-0000-1000-8000-00805f9b34fb \
//    pnpm test
//
// 2. Run tests with CS108 RFID reader:
//    BLE_MCP_DEVICE_IDENTIFIER=6c79b8xxxxxx \
//    BLE_MCP_SERVICE_UUID=00009800-0000-1000-8000-00805f9b34fb \
//    BLE_MCP_WRITE_UUID=00009900-0000-1000-8000-00805f9b34fb \
//    BLE_MCP_NOTIFY_UUID=00009901-0000-1000-8000-00805f9b34fb \
//    pnpm test
//
// 5. Run tests against remote bridge server:
//    BLE_MCP_WS_URL=ws://raspberry-pi.local:25153 \
//    BLE_MCP_DEVICE_NAME=MyDevice \
//    BLE_MCP_SERVICE_UUID=... \
//    BLE_MCP_WRITE_UUID=... \
//    BLE_MCP_NOTIFY_UUID=... \
//    pnpm test