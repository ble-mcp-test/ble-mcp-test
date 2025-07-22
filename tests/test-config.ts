// Test configuration for BLE bridge
// Can be overridden by environment variables

export interface BridgeTestConfig {
  wsUrl: string;
  device: string;
  service: string;
  write: string;
  notify: string;
}

// Default CS108 RFID Reader configuration
const DEFAULT_CONFIG: BridgeTestConfig = {
  wsUrl: 'ws://localhost:8080',
  device: 'CS108',
  service: '9800',
  write: '9900',
  notify: '9901'
};

// Get complete test configuration from environment or use defaults
export function getTestConfig(): BridgeTestConfig {
  return {
    wsUrl: process.env.WS_URL || DEFAULT_CONFIG.wsUrl,
    device: process.env.BLE_DEVICE_PREFIX || DEFAULT_CONFIG.device,
    service: process.env.BLE_SERVICE_UUID || DEFAULT_CONFIG.service,
    write: process.env.BLE_WRITE_UUID || DEFAULT_CONFIG.write,
    notify: process.env.BLE_NOTIFY_UUID || DEFAULT_CONFIG.notify
  };
}

// For backward compatibility with existing tests
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
  const { default: BridgeServer } = await import('../dist/bridge-server.js');
  const WebSocket = (await import('ws')).default;
  
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
    if (WS_URL.includes('localhost') || WS_URL.includes('127.0.0.1')) {
      // Local URL - start our own server
      console.log('[Test] Starting local bridge server...');
      const server = new BridgeServer();
      server.start();
      console.log('[Test] Started local bridge server');
      return server; // Return server instance for cleanup
    } else {
      // External URL - fail the test
      throw new Error(`Cannot connect to external bridge server at ${WS_URL}. Please ensure the server is running.`);
    }
  }
}

// Usage examples:
// 
// 1. Run tests with default CS108 configuration:
//    WS_URL=ws://cheetah.local:8080 pnpm test
//
// 2. Run tests with custom device configuration:
//    BLE_DEVICE_PREFIX=MyDevice \
//    BLE_SERVICE_UUID=180f \
//    BLE_WRITE_UUID=2a19 \
//    BLE_NOTIFY_UUID=2a20 \
//    WS_URL=ws://cheetah.local:8080 \
//    pnpm test