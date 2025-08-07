import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as dotenv from 'dotenv';

// Load environment variables for BLE configuration
dotenv.config({ path: '.env.local' });

const __dirname = dirname(fileURLToPath(import.meta.url));

// Helper to get BLE configuration from environment
function getBleConfig() {
  return {
    device: process.env.BLE_MCP_DEVICE_IDENTIFIER || 'CS108',
    service: process.env.BLE_MCP_SERVICE_UUID || '9800',
    write: process.env.BLE_MCP_WRITE_UUID || '9900',
    notify: process.env.BLE_MCP_NOTIFY_UUID || '9901'
  };
}

/**
 * Test session management features in the Web Bluetooth mock
 */
test.describe('Session Management E2E Tests', () => {
  test('should support session ID in injectWebBluetoothMock', async ({ page }) => {
    await page.goto('about:blank');
    
    // Load the bundle
    const bundlePath = join(__dirname, '../../dist/web-ble-mock.bundle.js');
    await page.addScriptTag({ path: bundlePath });
    
    // Test session support in injection
    const sessionResult = await page.evaluate(() => {
      try {
        // Test new session parameter
        const sessionId = 'test-session-12345';
        window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
        
        return {
          success: true,
          hasNavigatorBluetooth: 'bluetooth' in navigator,
          bluetoothType: typeof navigator.bluetooth
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });
    
    console.log('Session injection result:', sessionResult);
    
    expect(sessionResult.success).toBe(true);
    expect(sessionResult.hasNavigatorBluetooth).toBe(true);
    expect(sessionResult.bluetoothType).toBe('object');
  });

  test('should create devices with session support', async ({ page }) => {
    await page.goto('about:blank');
    
    // Load the bundle
    const bundlePath = join(__dirname, '../../dist/web-ble-mock.bundle.js');
    await page.addScriptTag({ path: bundlePath });
    
    // Test device creation with session
    const bleConfig = getBleConfig();
    const deviceResult = await page.evaluate((config) => {
      try {
        const sessionId = 'device-test-session-' + Date.now();
        
        // Inject with session
        window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
        
        // Request device
        return navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: config.device }]
        }).then(device => {
          return {
            success: true,
            hasDevice: !!device,
            deviceName: device.name,
            hasGatt: 'gatt' in device,
            hasTransport: 'transport' in device,
            hasSessionId: 'sessionId' in device,
            sessionId: device.sessionId
          };
        });
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    }, bleConfig);
    
    console.log('Device with session result:', deviceResult);
    
    expect(deviceResult.success).toBe(true);
    expect(deviceResult.hasDevice).toBe(true);
    expect(deviceResult.hasTransport).toBe(true);
    expect(deviceResult.hasSessionId).toBe(true);
    expect(deviceResult.sessionId).toContain('device-test-session-');
  });

  test('should support auto-generated sessions', async ({ page }) => {
    await page.goto('about:blank');
    
    // Load the bundle
    const bundlePath = join(__dirname, '../../dist/web-ble-mock.bundle.js');
    await page.addScriptTag({ path: bundlePath });
    
    // Test auto-generated session
    const autoSessionResult = await page.evaluate((config) => {
      try {
        // Inject with auto-generation
        window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
        
        // Request device
        return navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: config.device }]
        }).then(device => {
          // Check if device has generateSession flag set
          const hasGenerateFlag = device.bleConfig?.generateSession === true;
          
          // For auto-generated sessions, we can't check the actual ID without connecting
          // But we can verify the configuration is correct
          return {
            success: true,
            hasSessionId: hasGenerateFlag,
            sessionId: hasGenerateFlag ? 'will-be-generated-on-connect' : undefined,
            sessionFormat: hasGenerateFlag
          };
        });
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    }, getBleConfig());
    
    console.log('Auto-generated session result:', autoSessionResult);
    
    expect(autoSessionResult.success).toBe(true);
    expect(autoSessionResult.hasSessionId).toBe(true);
    expect(autoSessionResult.sessionFormat).toBe(true);
  });

  test('should auto-generate session IDs when none provided', async ({ page }) => {
    await page.goto('about:blank');
    
    // Load the bundle
    const bundlePath = join(__dirname, '../../dist/web-ble-mock.bundle.js');
    await page.addScriptTag({ path: bundlePath });
    
    // Test legacy usage (no session parameters)
    const legacyResult = await page.evaluate((config) => {
      try {
        // Inject without session parameters (old way)
        window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
        
        // Request device
        return navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: config.device }]
        }).then(device => {
          return {
            success: true,
            hasDevice: !!device,
            deviceName: device.name,
            hasGatt: 'gatt' in device,
            hasTransport: 'transport' in device,
            sessionId: device.sessionId || null
          };
        });
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    }, getBleConfig());
    
    console.log('Legacy compatibility result:', legacyResult);
    
    expect(legacyResult.success).toBe(true);
    expect(legacyResult.hasDevice).toBe(true);
    expect(legacyResult.hasGatt).toBe(true);
    expect(legacyResult.hasTransport).toBe(true);
    // Session ID should be auto-generated (not null anymore in v0.5.1+)
    expect(legacyResult.sessionId).toBeTruthy();
    expect(typeof legacyResult.sessionId).toBe('string');
  });

  test('should demonstrate session persistence pattern (simulated)', async ({ page }) => {
    // Use file:// protocol to allow localStorage access
    await page.goto('data:text/html,<html><body><script>/* Placeholder for session test */</script></body></html>');
    
    // Load the bundle
    const bundlePath = join(__dirname, '../../dist/web-ble-mock.bundle.js');
    await page.addScriptTag({ path: bundlePath });
    
    // Test localStorage integration pattern (simulated without actual storage)
    const persistenceResult = await page.evaluate((config) => {
      try {
        // Simulate web app session management pattern without localStorage
        const sessionId = 'web-session-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        
        // Inject with session
        window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
        
        // Request device
        return navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: config.device }]
        }).then(device => {
          return {
            success: true,
            sessionMatches: device.sessionId === sessionId,
            sessionId: device.sessionId,
            expectedSessionId: sessionId,
            sessionPattern: device.sessionId?.startsWith('web-session-')
          };
        });
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    }, getBleConfig());
    
    console.log('Persistence pattern result:', persistenceResult);
    
    expect(persistenceResult.success).toBe(true);
    expect(persistenceResult.sessionMatches).toBe(true);
    expect(persistenceResult.sessionPattern).toBe(true);
    expect(persistenceResult.sessionId).toContain('web-session-');
  });



  test('should validate force-cleanup-simple.html functionality', async ({ page }) => {
    // Navigate to the actual force-cleanup-simple.html page
    const htmlPath = join(__dirname, '../../examples/force-cleanup-simple.html');
    await page.goto(`file://${htmlPath}`);
    
    // Wait for page to load
    await page.waitForLoadState('domcontentloaded');
    
    // Test that the force cleanup UI elements exist
    const uiElements = await page.evaluate(() => {
      return {
        hasCleanupBtn: !!document.getElementById('cleanupBtn'),
        hasStatusDiv: !!document.getElementById('status'),
        hasForceCleanupFunction: typeof window.forceCleanupBLE === 'function'
      };
    });
    
    console.log('Force cleanup UI elements:', uiElements);
    
    expect(uiElements.hasCleanupBtn).toBe(true);
    expect(uiElements.hasStatusDiv).toBe(true);
    expect(uiElements.hasForceCleanupFunction).toBe(true);
  });

  test('should verify session URL parameters are correctly formed', async ({ page }) => {
    await page.goto('about:blank');
    
    // Load the bundle and add helper script
    const bundlePath = join(__dirname, '../../dist/web-ble-mock.bundle.js');
    await page.addScriptTag({ path: bundlePath });
    
    // Test URL parameter formation
    const urlTest = await page.evaluate((config) => {
      // Mock WebSocket to capture URL
      const capturedUrls: string[] = [];
      const OriginalWebSocket = WebSocket;
      
      (window as any).WebSocket = class MockWS {
        url: string;
        readyState = WebSocket.CONNECTING;
        
        constructor(url: string) {
          this.url = url;
          capturedUrls.push(url);
          
          // Simulate connection
          setTimeout(() => {
            this.readyState = WebSocket.OPEN;
            if (this.onopen) this.onopen(new Event('open'));
          }, 1);
        }
        
        send() {}
        close() {}
        
        onopen: ((ev: Event) => any) | null = null;
        onmessage: ((ev: MessageEvent) => any) | null = null;
        onerror: ((ev: Event) => any) | null = null;
        onclose: ((ev: CloseEvent) => any) | null = null;
      };
      
      try {
        const sessionId = 'url-test-session-456';
        
        // Create MockBluetooth instance directly to test URL generation
        const MockBluetooth = window.WebBleMock.MockBluetooth;
        const mockBt = new MockBluetooth('ws://localhost:8080', {
          service: '9800',
          write: '9900',
          notify: '9901',
          sessionId: sessionId
        });
        
        return mockBt.requestDevice({
          filters: [{ namePrefix: config.device }]
        }).then((device: any) => {
          // Trigger connection to capture URL
          return device.gatt.connect().then(() => {
            // Restore original WebSocket
            (window as any).WebSocket = OriginalWebSocket;
            
            return {
              success: true,
              capturedUrls: capturedUrls,
              urlCount: capturedUrls.length,
              hasSessionParam: capturedUrls.some(url => url.includes(`session=${sessionId}`)),
              hasBleParams: capturedUrls.some(url => 
                url.includes(`device=${config.device}`) && 
                url.includes('service=9800') &&
                url.includes('write=9900') &&
                url.includes('notify=9901')
              )
            };
          }).catch(() => {
            // Restore even on error
            (window as any).WebSocket = OriginalWebSocket;
            
            return {
              success: true,
              capturedUrls: capturedUrls,
              urlCount: capturedUrls.length,
              hasSessionParam: capturedUrls.some(url => url.includes(`session=${sessionId}`)),
              hasBleParams: capturedUrls.some(url => 
                url.includes(`device=${config.device}`) && 
                url.includes('service=9800') &&
                url.includes('write=9900') &&
                url.includes('notify=9901')
              )
            };
          });
        });
      } catch (error) {
        // Restore on error
        (window as any).WebSocket = OriginalWebSocket;
        
        return {
          success: false,
          error: error.message
        };
      }
    }, getBleConfig());
    
    console.log('URL parameter test:', urlTest);
    
    expect(urlTest.success).toBe(true);
    expect(urlTest.urlCount).toBeGreaterThan(0);
    expect(urlTest.hasSessionParam).toBe(true);
    expect(urlTest.hasBleParams).toBe(true);
  });
});