import * as dotenv from 'dotenv';
import os from 'os';

// Load environment variables
dotenv.config({ path: '.env.local' });

// Shared E2E test configuration
export const E2E_TEST_CONFIG = {
  // Fixed session ID for all E2E tests - ensures session reuse works across test runs
  // Include hostname for better debugging
  sessionId: `ble-mcp-e2e-${os.hostname()}`,  // e.g., "ble-mcp-e2e-macbook-pro"
  
  // BLE device configuration from environment
  // Don't specify a device by default - let it connect to any device with the service
  device: process.env.BLE_MCP_DEVICE_IDENTIFIER || undefined,
  service: process.env.BLE_MCP_SERVICE_UUID || '9800',
  write: process.env.BLE_MCP_WRITE_UUID || '9900',
  notify: process.env.BLE_MCP_NOTIFY_UUID || '9901',
  
  // WebSocket server URL
  wsUrl: process.env.BLE_WEBSOCKET_URL || 'ws://localhost:8080',
  
  // Test timeout
  timeout: 30000
};

// Helper to get BLE config object for navigator.bluetooth mock (NEW API)
export function getBleConfig() {
  // NEVER include device - only use service-based filtering
  return {
    sessionId: E2E_TEST_CONFIG.sessionId,
    serverUrl: E2E_TEST_CONFIG.wsUrl,
    service: E2E_TEST_CONFIG.service,
    write: E2E_TEST_CONFIG.write,
    notify: E2E_TEST_CONFIG.notify
  };
}

// ============================================================================
// Test Helper Functions - Reduce boilerplate across E2E tests
// ============================================================================

import { Page } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');

/**
 * Smart setup that works in BOTH dev and CI modes
 * Automatically detects context and does the right thing:
 * - Dev mode: Uses pre-injected mock from dev server
 * - CI mode: Loads bundle and injects mock
 * 
 * This means the SAME tests work everywhere!
 */
export async function setupMockPage(page: Page, customHtml?: string) {
  // First check if we're connecting to a dev server or need to serve our own page
  const isDevServer = process.env.DEV_SERVER_URL || process.env.VITE_BLE_MOCK_ENABLED;
  
  if (isDevServer) {
    // Dev mode: Navigate to dev server
    const devUrl = process.env.DEV_SERVER_URL || 'http://localhost:5173';
    console.log(`[Setup] Navigating to dev server: ${devUrl}`);
    await page.goto(devUrl);
    
    // Check if mock is already injected
    const alreadyInjected = await isMockPreInjected(page);
    
    if (alreadyInjected) {
      console.log('[Setup] Using pre-injected mock from dev server');
      return; // Mock ready, nothing to do
    }
    
    // Dev server running but mock not injected? That's unusual
    console.warn('[Setup] Dev server running but mock not injected, injecting now');
    await injectMockInPage(page);
    
  } else {
    // CI mode: Serve our own page
    console.log('[Setup] CI mode - serving test page and injecting mock');
    
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.endsWith('/bundle.js')) {
        await route.fulfill({
          path: bundlePath,
          contentType: 'application/javascript',
        });
      } else {
        await route.fulfill({
          body: customHtml || `
            <!DOCTYPE html>
            <html>
            <head>
              <script src="/bundle.js"></script>
            </head>
            <body>
              <div id="result">E2E Test Page</div>
            </body>
            </html>
          `,
          contentType: 'text/html',
        });
      }
    });

    await page.goto('http://localhost/test');
    
    // Load bundle and inject mock
    await page.addScriptTag({ path: bundlePath });
    await injectMockInPage(page);
  }
}

/**
 * Detect if mock is already injected (dev server mode)
 */
export async function isMockPreInjected(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    return (window as any).__webBluetoothMocked === true;
  });
}

/**
 * Inject mock with config in page context
 * Returns the config that was used for verification
 * Skips injection if already injected (dev server mode)
 */
export async function injectMockInPage(
  page: Page, 
  customConfig?: Partial<ReturnType<typeof getBleConfig>>
) {
  // Check if already injected
  const alreadyInjected = await isMockPreInjected(page);
  
  if (alreadyInjected) {
    console.log('[Test Config] Mock already injected by dev server, skipping injection');
    return getBleConfig(); // Return expected config for consistency
  }
  
  const config = {
    ...getBleConfig(),
    ...customConfig
  };

  await page.evaluate((cfg) => {
    window.WebBleMock.injectWebBluetoothMock(cfg);
  }, config);
  
  console.log('[Test Config] Mock injected for CI/CD mode');
  return config;
}

/**
 * Standard device connection flow with error handling
 * Returns common test result structure
 */
export async function connectToDevice(
  page: Page,
  config = getBleConfig(),
  deviceFilter?: string
) {
  return page.evaluate(async ({ cfg, filter }) => {
    try {
      // Inject mock if not already injected
      if (!navigator.bluetooth || !(navigator.bluetooth as any).__mock) {
        window.WebBleMock.injectWebBluetoothMock(cfg);
      }
      
      // Request device
      const device = await navigator.bluetooth.requestDevice({
        filters: [filter ? { namePrefix: filter } : { services: [cfg.service] }]
      });
      
      // Connect
      const server = await device.gatt!.connect();
      
      return {
        success: true,
        connected: server.connected,
        deviceId: device.id,
        deviceName: device.name,
        sessionId: (device as any).sessionId,
        error: null
      };
    } catch (error: any) {
      return {
        success: false,
        connected: false,
        deviceId: null,
        deviceName: null,
        sessionId: null,
        error: error.message
      };
    }
  }, { cfg: config, filter: deviceFilter });
}