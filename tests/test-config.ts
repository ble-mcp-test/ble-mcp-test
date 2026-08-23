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
  
  const wsPort = process.env.BLE_MCP_WS_PORT || '8080';
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

export const WS_URL = getTestConfig().wsUrl;

// Shared test server setup helper
// Returns: null - tests now use the PM2-managed Rust bridge on port 8080
export async function setupTestServer() {
  // NOTE: With new Rust bridge architecture, we no longer start our own BridgeServer
  // The PM2-managed server handles both Rust (8080) and Node (8081) services
  const WebSocket = (await import('ws')).default;
  
  // With new Rust bridge, we always connect to the PM2-managed server
  
  // First, try to connect to the configured URL
  const testWs = new WebSocket(WS_URL);
  
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        testWs.close();
        reject(new Error('Connection timeout'));
      }, 2000);
      
      testWs.onopen = () => {
        clearTimeout(timeout);
        testWs.close();
        resolve();
      };
      
      testWs.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Connection failed'));
      };
    });
    
    // Connection successful, use Rust bridge server
    console.log(`[Test] Connected to Rust bridge server at: ${WS_URL}`);
    return null; // No local server needed - PM2 handles everything
  } catch (error) {
    // Connection failed - PM2 server should be running for new architecture
    console.error(`[Test] Cannot connect to Rust bridge at ${WS_URL}`);
    console.error(`[Test] Please ensure the bridge is running: pnpm start`);
    throw new Error(`Cannot connect to Rust bridge server at ${WS_URL}. Run 'pnpm start' to start the server.`);
  }
}

// Usage examples:
// 
// 1. Run integration tests without real devices (tests will skip if device not found):
//    pnpm test:integration
//
// 2. Run integration tests with a specific test device:
//    BLE_MCP_DEVICE=MockBLE pnpm test:integration
//
// 3. Run tests with real BLE device (e.g., nRF52 dongle):
//    BLE_MCP_DEVICE_NAME=nRF52 \
//    BLE_MCP_SERVICE_UUID=180f \
//    BLE_MCP_WRITE_UUID=2a19 \
//    BLE_MCP_NOTIFY_UUID=2a19 \
//    pnpm test
//
// 4. Run tests with CS108 RFID reader:
//    BLE_MCP_DEVICE_IDENTIFIER=6c79b8xxxxxx \
//    BLE_MCP_SERVICE_UUID=9800 \
//    BLE_MCP_WRITE_UUID=9900 \
//    BLE_MCP_NOTIFY_UUID=9901 \
//    pnpm test
//
// 5. Run tests against remote bridge server:
//    BLE_MCP_WS_URL=ws://raspberry-pi.local:8080 \
//    BLE_MCP_DEVICE_NAME=MyDevice \
//    BLE_MCP_SERVICE_UUID=... \
//    BLE_MCP_WRITE_UUID=... \
//    BLE_MCP_NOTIFY_UUID=... \
//    pnpm test