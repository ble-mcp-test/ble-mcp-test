import { test, expect } from '@playwright/test';
import { getBleConfig, setupMockPage, E2E_TEST_CONFIG } from './test-config';

test.describe('WebSocket URL Session Verification', () => {
  test('should include session parameter in actual WebSocket URL', async ({ page }) => {
    // Intercept WebSocket connections to capture the URL
    let capturedWsUrl: string | null = null;
    
    // Setup page with bundle and auto-inject mock
    await setupMockPage(page);

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
      
      window.WebBleMock.injectWebBluetoothMock({
        sessionId,
        serverUrl: config.serverUrl,
        service: config.service,
        write: config.write,
        notify: config.notify
      });

      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [config.service] }]
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
    }, { sessionId: testSessionId, config: { ...bleConfig, serverUrl: E2E_TEST_CONFIG.wsUrl } });

    console.log('Result:', result);
    
    // Verify the WebSocket URL includes the session parameter
    expect(result.capturedUrl).toBeTruthy();
    expect(result.capturedUrl).toContain(E2E_TEST_CONFIG.wsUrl);
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
});