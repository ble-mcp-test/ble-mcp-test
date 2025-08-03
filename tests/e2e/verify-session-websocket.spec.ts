import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Verify Session ID in WebSocket', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');

  test('should pass sessionId to WebSocket and verify with MCP', async ({ page }) => {
    // First, clear any recent logs
    await page.evaluate(() => {
      // This will be used to verify the server is running
      return fetch('http://localhost:8081/health')
        .then(res => res.json())
        .catch(() => ({ status: 'not running' }));
    }).then(health => {
      console.log('Bridge server health:', health);
    });

    // Capture console logs
    const consoleLogs: string[] = [];
    page.on('console', msg => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });

    // Set up page with bundle
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

    const testSessionId = 'verify-websocket-session-12345';
    const deviceIdentifier = process.env.BLE_MCP_DEVICE_IDENTIFIER || 'CS108';
    
    // Inject mock and attempt connection
    const connectionResult = await page.evaluate(async ({ sessionId, device }) => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
        sessionId,
        service: '9800',
        write: '9900',
        notify: '9901'
      });

      try {
        const bleDevice = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: device }]
        });
        
        // Store session for verification
        const deviceSessionId = (bleDevice as any).sessionId;
        
        // Try to connect (this will fail if no server, but that's OK)
        try {
          await bleDevice.gatt!.connect();
          return { 
            connected: true, 
            deviceSessionId,
            error: null 
          };
        } catch (e) {
          return { 
            connected: false, 
            deviceSessionId,
            error: e.message 
          };
        }
      } catch (e) {
        return { 
          connected: false, 
          deviceSessionId: null,
          error: e.message 
        };
      }
    }, { sessionId: testSessionId, device: deviceIdentifier });

    console.log('Connection result:', connectionResult);
    
    // Verify the mock logged the session ID mapping
    const sessionLog = consoleLogs.find(log => 
      log.includes('[MockGATT] Using session ID for WebSocket:')
    );
    
    expect(sessionLog).toBeTruthy();
    expect(sessionLog).toContain(testSessionId);
    
    // Verify WebSocket connect options included session
    const connectOptionsLog = consoleLogs.find(log => 
      log.includes('[MockGATT] WebSocket connect options:')
    );
    
    expect(connectOptionsLog).toBeTruthy();
    expect(connectOptionsLog).toContain(`"session":"${testSessionId}"`);
    
    // The device should have the session ID
    expect(connectionResult.deviceSessionId).toBe(testSessionId);
    
    console.log('\n=== Test Summary ===');
    console.log('✅ Session ID was correctly mapped from sessionId to session parameter');
    console.log('✅ WebSocket connect options included session parameter');
    console.log('✅ Device object has correct sessionId property');
    console.log(`Session ID used: ${testSessionId}`);
    
    // Note: To fully verify with MCP, run this test with the bridge server running:
    // 1. In one terminal: pnpm run bridge
    // 2. In another terminal: pnpm test:e2e verify-session-websocket.spec.ts
    // 3. Then use MCP: mcp ble-mcp-test get_logs --since 30s --filter "verify-websocket"
  });
});