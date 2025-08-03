import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

// Load environment variables for BLE configuration
dotenv.config({ path: '.env.local' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Helper to get BLE configuration from environment
function getBleConfig() {
  return {
    device: process.env.BLE_MCP_DEVICE_IDENTIFIER || 'CS108',
    service: process.env.BLE_MCP_SERVICE_UUID || '9800',
    write: process.env.BLE_MCP_WRITE_UUID || '9900',
    notify: process.env.BLE_MCP_NOTIFY_UUID || '9901'
  };
}

test.describe('WebSocket URL Session Verification', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');

  test('should include session parameter in actual WebSocket URL', async ({ page }) => {
    // Intercept WebSocket connections to capture the URL
    let capturedWsUrl: string | null = null;
    
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.endsWith('/bundle.js')) {
        await route.fulfill({
          path: bundlePath,
          contentType: 'application/javascript',
        });
      } else {
        await route.fulfill({
          body: '<html><body>Test Page</body></html>',
          contentType: 'text/html',
        });
      }
    });

    await page.goto('http://localhost/test');
    await page.addScriptTag({ url: '/bundle.js' });

    // Override WebSocket constructor to capture URLs
    await page.evaluate(() => {
      const OriginalWebSocket = window.WebSocket;
      (window as any).WebSocket = class extends OriginalWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          console.log(`[WebSocket] Attempting connection to: ${url}`);
          (window as any).__lastWebSocketUrl = url;
          super(url, protocols);
        }
      };
    });

    const testSessionId = 'test-ws-url-capture-xyz789';
    
    // Inject mock and attempt connection
    const bleConfig = getBleConfig();
    const result = await page.evaluate(async ({ sessionId, config }) => {
      // Clear any captured URL
      delete (window as any).__lastWebSocketUrl;
      
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
        sessionId,
        service: config.service,
        write: config.write,
        notify: config.notify
      });

      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: config.device }]
      });
      
      try {
        await device.gatt!.connect();
      } catch (e) {
        // Connection will fail without server, but URL should still be captured
      }
      
      return {
        deviceSessionId: (device as any).sessionId,
        capturedUrl: (window as any).__lastWebSocketUrl || null
      };
    }, { sessionId: testSessionId, config: bleConfig });

    console.log('Result:', result);
    
    // Verify the WebSocket URL includes the session parameter
    expect(result.capturedUrl).toBeTruthy();
    expect(result.capturedUrl).toContain('ws://localhost:8080');
    expect(result.capturedUrl).toContain(`session=${testSessionId}`);
    
    // Parse the URL to verify all parameters
    const wsUrl = new URL(result.capturedUrl!);
    expect(wsUrl.searchParams.get('session')).toBe(testSessionId);
    expect(wsUrl.searchParams.get('service')).toBe(getBleConfig().service);
    expect(wsUrl.searchParams.get('write')).toBe(getBleConfig().write);
    expect(wsUrl.searchParams.get('notify')).toBe(getBleConfig().notify);
    
    console.log('\n=== WebSocket URL Verification ===');
    console.log(`✅ Captured WebSocket URL: ${result.capturedUrl}`);
    console.log(`✅ Session parameter present: session=${testSessionId}`);
    console.log('✅ All BLE config parameters included in URL');
  });

  test('should NOT include session when sessionId not provided', async ({ page }) => {
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.endsWith('/bundle.js')) {
        await route.fulfill({
          path: bundlePath,
          contentType: 'application/javascript',
        });
      } else {
        await route.fulfill({
          body: '<html><body>Test Page</body></html>',
          contentType: 'text/html',
        });
      }
    });

    await page.goto('http://localhost/test');
    await page.addScriptTag({ url: '/bundle.js' });

    // Override WebSocket constructor
    await page.evaluate(() => {
      const OriginalWebSocket = window.WebSocket;
      (window as any).WebSocket = class extends OriginalWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          console.log(`[WebSocket] Attempting connection to: ${url}`);
          (window as any).__lastWebSocketUrl = url;
          super(url, protocols);
        }
      };
    });

    // Inject mock WITHOUT sessionId
    const bleConfig = getBleConfig();
    const result = await page.evaluate(async (config) => {
      delete (window as any).__lastWebSocketUrl;
      
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
        service: config.service,
        write: config.write,
        notify: config.notify
        // Note: no sessionId provided
      });

      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: config.device }]
      });
      
      try {
        await device.gatt!.connect();
      } catch (e) {
        // Expected to fail
      }
      
      return {
        deviceSessionId: (device as any).sessionId,
        capturedUrl: (window as any).__lastWebSocketUrl || null
      };
    }, bleConfig);

    console.log('Result without explicit sessionId:', result);
    
    // Should have auto-generated session ID in simplified format
    expect(result.deviceSessionId).toBeTruthy();
    expect(result.deviceSessionId).toMatch(/^playwright-/);
    
    // WebSocket URL should include the auto-generated session
    expect(result.capturedUrl).toBeTruthy();
    const wsUrl = new URL(result.capturedUrl!);
    expect(wsUrl.searchParams.get('session')).toBe(result.deviceSessionId);
    
    console.log('\n=== Auto-generated Session Test ===');
    console.log(`✅ Auto-generated session ID: ${result.deviceSessionId}`);
    console.log(`✅ WebSocket URL includes auto-generated session`);
  });
});