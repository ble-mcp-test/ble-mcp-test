import * as dotenv from 'dotenv';
import { SHARED_TEST_CONFIG } from '../shared/test-config.js';

// Load environment variables
dotenv.config({ path: '.env.local' });

// E2E test configuration extends shared config
export const E2E_TEST_CONFIG = {
  ...SHARED_TEST_CONFIG,
  // E2E-specific: Optional device ID for filtering (shared config has this in DEVICE_FILTERS)
  device: process.env.BLE_MCP_DEVICE_IDENTIFIER || undefined
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


// ============================================================================
// Device-Specific Test Commands - Single Source of Truth
// ============================================================================

import { TEST_COMMAND_BYTES, isValidTestResponse } from '../shared/device-commands.js';

// Test result interface for consistency
export interface TestResult {
  success: boolean;
  response?: Uint8Array;
  responseHex?: string;
  error?: string;
  timeout?: boolean;
}

/**
 * Send test command to device - handles full connection lifecycle
 * Connects, sends command, returns success/failure
 */
export async function testCommandHelper(page: Page): Promise<boolean> {
  // The page returns RAW BYTES and validation happens here, in Node, through the
  // one exported validator. It used to re-implement that validator inline --
  // `page.evaluate` cannot take a function argument, so the duplicate looked
  // forced. It was not: returning the bytes moves the check to the side of the
  // boundary the single source already lives on. Two validators for one contract
  // is how a fix to one silently fails to reach the other.
  const outcome = await page.evaluate(async ({ commandBytes, uuids }) => {
    try {
      const { testCommand } = (navigator.bluetooth as any).testing;

      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [uuids.service] }]
      });

      await device.gatt!.connect();
      const service = await device.gatt!.getPrimaryService(uuids.service);
      const writeChar = await service.getCharacteristic(uuids.write);
      const notifyChar = await service.getCharacteristic(uuids.notify);

      try {
        // Subscribe BEFORE expecting a notification. The mock gates delivery on
        // startNotifications() (TRA-1153 item 2), and `testCommand` itself does
        // not subscribe -- so without this the frame is dropped and the wait
        // expires, which presents as a slow or flaky reader rather than as the
        // missing call it is. Whether `testCommand` should subscribe on the
        // caller's behalf, or be deleted, is TRA-1153's decision; a consumer
        // subscribing before it listens is correct either way.
        await notifyChar.startNotifications();

        const result = await testCommand({
          device,
          writeCharacteristic: writeChar,
          notifyCharacteristic: notifyChar,
          command: new Uint8Array(commandBytes),
          timeout: 2000
        });

        return {
          bytes: result.response ? Array.from(result.response as Uint8Array) : null,
          error: result.error ?? null
        };
      } finally {
        // Release the command path. The bridge holds ONE writer slot -- not a
        // registry keyed on session -- so a helper that connects and does not
        // disconnect makes its own next call fail with "Device is busy",
        // naming its own session as the holder.
        await device.gatt!.disconnect();
      }
    } catch (error: any) {
      return { bytes: null, error: String(error?.message ?? error) };
    }
  }, {
    commandBytes: Array.from(TEST_COMMAND_BYTES),
    // Was three hardcoded '9800'/'9900'/'9901' literals. They are the CS108's,
    // and this repo is device-agnostic by design -- so they come from the
    // configured device like every other UUID in this file.
    uuids: {
      service: E2E_TEST_CONFIG.service,
      write: E2E_TEST_CONFIG.write,
      notify: E2E_TEST_CONFIG.notify
    }
  });

  if (!outcome.bytes) {
    console.error(`[testCommandHelper] no response: ${outcome.error ?? 'unknown'}`);
    return false;
  }
  return isValidTestResponse(new Uint8Array(outcome.bytes));
}

/**
 * Test notification simulation using REAL mock classes - true end-to-end test
 * This connects through the actual mock API and tests simulateNotification on real characteristics
 */
export async function testSimulateNotification(page: Page, testBytes: number[] = [0x01, 0x02, 0x03]): Promise<boolean> {
  return page.evaluate(async ({ config, bytes }) => {
    try {
      const { simulateNotification } = (navigator.bluetooth as any).testing;
      
      // Connect through the REAL mock API to get a real characteristic
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [config.service] }]
      });
      
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(config.service);
      const notifyChar = await service.getCharacteristic(config.notify);
      
      // Set up notification listener on the REAL characteristic
      let receivedData: number[] = [];
      notifyChar.addEventListener('characteristicvaluechanged', (event: any) => {
        // Honour the view window. `new Uint8Array(value.buffer)` would read the
        // whole backing buffer, so this helper would report success against a
        // payload the app never sent.
        const value = event.target.value;
        const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        receivedData = Array.from(data);
      });
      
      // Subscribe before simulating. `simulateNotification` REFUSES an
      // unsubscribed characteristic on purpose (a simulated notification is an
      // instruction, not a device event, so swallowing it would make this helper
      // a check that cannot go red). This helper never subscribed, so it had been
      // asking for delivery it had not arranged -- same missing call as
      // testCommandHelper, one function down.
      await notifyChar.startNotifications();

      try {
        // Test simulateNotification on the REAL characteristic
        await simulateNotification({
          characteristic: notifyChar,  // Real MockBluetoothRemoteGATTCharacteristic!
          data: new Uint8Array(bytes)
        });

        await new Promise(resolve => setTimeout(resolve, 100));

        return bytes.length === receivedData.length &&
               bytes.every((byte, index) => byte === receivedData[index]);
      } finally {
        // See testCommandHelper: one writer slot, so release it before the
        // caller's next invocation asks for it again.
        await server.disconnect();
      }
    } catch (error: any) {
      console.error('testSimulateNotification error:', error);
      return false;
    }
  }, { config: getBleConfig(), bytes: testBytes });
}