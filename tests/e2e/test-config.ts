import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.local' });

// Shared E2E test configuration
export const E2E_TEST_CONFIG = {
  // Fixed session ID for all E2E tests - ensures session reuse works across test runs
  sessionId: 'e2e-test-session',
  
  // BLE device configuration from environment
  device: process.env.BLE_MCP_DEVICE_IDENTIFIER || 'CS108',
  service: process.env.BLE_MCP_SERVICE_UUID || '9800',
  write: process.env.BLE_MCP_WRITE_UUID || '9900',
  notify: process.env.BLE_MCP_NOTIFY_UUID || '9901',
  
  // WebSocket server URL
  wsUrl: process.env.BLE_WEBSOCKET_URL || 'ws://localhost:8080',
  
  // Test timeout
  timeout: 30000
};

// Helper to get BLE config object for navigator.bluetooth mock
export function getBleConfig() {
  return {
    device: E2E_TEST_CONFIG.device,
    service: E2E_TEST_CONFIG.service,
    write: E2E_TEST_CONFIG.write,
    notify: E2E_TEST_CONFIG.notify,
    sessionId: E2E_TEST_CONFIG.sessionId
  };
}