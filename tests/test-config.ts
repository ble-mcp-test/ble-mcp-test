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
  device: process.platform === 'linux' ? '6c79b82603a7' : 'CS108',
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
      const logLevel = normalizeLogLevel(process.env.LOG_LEVEL);
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
// 1. Run tests with default CS108 configuration:
//    WS_URL=ws://cheetah.local:8080 pnpm test
//    Note: On Linux, defaults to MAC address 6c79b82603a7 instead of device name
//
// 2. Run tests with custom device configuration:
//    BLE_DEVICE_PREFIX=MyDevice \
//    BLE_SERVICE_UUID=180f \
//    BLE_WRITE_UUID=2a19 \
//    BLE_NOTIFY_UUID=2a20 \
//    WS_URL=ws://cheetah.local:8080 \
//    pnpm test
//
// 3. Override default device on Linux:
//    BLE_DEVICE_PREFIX=CS108 WS_URL=ws://cheetah.local:8080 pnpm test