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
  if (device === undefined) {
    throw new Error('BLE device configuration missing. Set BLE_MCP_DEVICE_IDENTIFIER in .env.local');
  }
  
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
// Returns: server instance if we started one (for cleanup), null if using external server
export async function setupTestServer() {
  const { BridgeServer } = await import('../dist/bridge-server.js');
  const { normalizeLogLevel } = await import('../dist/utils.js');
  const WebSocket = (await import('ws')).default;
  
  // Parse the URL to get host and port
  const url = new URL(WS_URL);
  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const port = parseInt(url.port || '8080', 10);
  
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
    
    // Connection successful, use external server
    console.log(`[Test] Using external bridge server at: ${WS_URL}`);
    return null; // No local server needed
  } catch (error) {
    // Connection failed
    if (isLocalhost) {
      // Local URL - start our own server on the port from WS_URL
      console.log(`[Test] Starting local bridge server on port ${port}...`);
      const logLevel = normalizeLogLevel(process.env.BLE_MCP_LOG_LEVEL);
      const server = new BridgeServer(logLevel);
      await server.start(port); // Use port from WS_URL, not WS_PORT
      console.log(`[Test] Started local bridge server on port ${port}`);
      
      // Give server a moment to fully initialize
      await new Promise(resolve => setTimeout(resolve, 500));
      
      return server; // Return server instance for cleanup
    } else {
      // External URL - fail the test
      throw new Error(`Cannot connect to external bridge server at ${WS_URL}. Please ensure the server is running.`);
    }
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
//    BLE_MCP_DEVICE_IDENTIFIER=6c79b82603a7 \
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