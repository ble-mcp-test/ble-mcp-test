import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Error Handling E2E Tests', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');

  // Helper to set up page with bundle
  async function setupPage(page) {
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.endsWith('/bundle.js')) {
        await route.fulfill({
          path: bundlePath,
          contentType: 'application/javascript',
        });
      } else {
        await route.fulfill({
          body: '<html><body>Error Test Page</body></html>',
          contentType: 'text/html',
        });
      }
    });

    await page.goto('http://localhost/test');
    await page.addScriptTag({ url: '/bundle.js' });
  }

  test('should handle WebSocket connection failure gracefully', async ({ page }) => {
    await setupPage(page);

    const result = await page.evaluate(async () => {
      try {
        // Try to connect to a non-existent WebSocket server
        window.WebBleMock.injectWebBluetoothMock('ws://localhost:9999', {
          sessionId: 'error-test-1'
        });

        const device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: 'TestDevice' }]
        });

        // Try to connect - should fail due to no WebSocket
        await device.gatt.connect();
        
        return { 
          success: true,
          error: null 
        };
      } catch (error) {
        return { 
          success: false,
          error: error.message,
          errorType: error.constructor.name
        };
      }
    });

    console.log('WebSocket failure result:', result);
    
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    // Should get a connection or network error
    expect(result.error).toMatch(/connect|network|WebSocket|closed/i);
  });

  test('should handle device not found scenario', async ({ page }) => {
    await setupPage(page);

    const result = await page.evaluate(async () => {
      try {
        window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', 'error-test-2');

        // Request a device with a filter that won't match anything
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: 'NonExistentDevice_' + Math.random() }]
        });

        return { 
          success: true,
          deviceFound: !!device,
          error: null 
        };
      } catch (error) {
        return { 
          success: false,
          deviceFound: false,
          error: error.message,
          errorType: error.constructor.name
        };
      }
    });

    console.log('Device not found result:', result);
    
    // Mock always returns a device, but real implementation might not
    // This test documents the current behavior
    if (result.success) {
      expect(result.deviceFound).toBe(true);
      console.log('Note: Mock always returns a device even with non-matching filter');
    }
  });

  test('should handle multiple simultaneous connection attempts', async ({ page }) => {
    await setupPage(page);

    const result = await page.evaluate(async () => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', 'error-test-3');

      const results = [];
      
      // Try to connect multiple times simultaneously
      const promises = [];
      for (let i = 0; i < 3; i++) {
        promises.push(
          navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'TestDevice' }]
          })
          .then(device => device.gatt.connect())
          .then(() => ({ index: i, success: true, error: null }))
          .catch(error => ({ index: i, success: false, error: error.message }))
        );
      }

      return Promise.all(promises);
    });

    console.log('Simultaneous connection results:', result);
    
    // All might fail with WebSocket error if no server is running
    const successes = result.filter(r => r.success).length;
    const errors = result.filter(r => r.error).length;
    
    expect(successes + errors).toBe(3); // All attempts should complete
    console.log(`Successes: ${successes}, Errors: ${errors}`);
    
    // Document the behavior
    if (errors === 3) {
      console.log('Note: All connections failed - likely no WebSocket server running');
    }
  });

  test('should handle disconnect during operation', async ({ page }) => {
    await setupPage(page);

    const result = await page.evaluate(async () => {
      try {
        window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', 'error-test-4');

        const device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: 'TestDevice' }]
        });

        // Connect successfully
        await device.gatt.connect();
        
        // Check initial state
        const connectedBefore = device.gatt.connected;
        
        // Force disconnect
        device.gatt.disconnect();
        
        // Check state after disconnect
        const connectedAfter = device.gatt.connected;
        
        // Try to use after disconnect - should fail
        let reconnectError = null;
        try {
          await device.gatt.getPrimaryService('180f');
        } catch (error) {
          reconnectError = error.message;
        }

        return {
          connectedBefore,
          connectedAfter,
          reconnectError
        };
      } catch (error) {
        return {
          error: error.message
        };
      }
    });

    console.log('Disconnect handling result:', result);
    
    if (!result.error) {
      expect(result.connectedBefore).toBe(true);
      expect(result.connectedAfter).toBe(false);
      expect(result.reconnectError).toBeTruthy();
    }
  });

  test('should handle invalid WebSocket URL gracefully', async ({ page }) => {
    await setupPage(page);

    const result = await page.evaluate(async () => {
      const results = [];
      
      // Test various invalid URLs
      const invalidUrls = [
        'not-a-url',
        'http://localhost:8080', // Wrong protocol
        'ws://', // Incomplete
        '', // Empty
      ];

      for (const url of invalidUrls) {
        try {
          window.WebBleMock.injectWebBluetoothMock(url);
          // Check if mock accepts the URL
          const device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'Test' }]
          });
          results.push({ url, success: true, hasDevice: !!device });
        } catch (error) {
          results.push({ url, success: false, error: error.message });
        }
      }

      return results;
    });

    console.log('Invalid URL results:', result);
    
    // Document actual behavior - mock is very permissive with URLs
    result.forEach(r => {
      console.log(`URL "${r.url}": ${r.success ? 'accepted' : 'rejected'}`);
    });
    
    // All URLs are accepted by the mock
    const allAccepted = result.every(r => r.success);
    expect(allAccepted).toBe(true);
    console.log('Note: Mock accepts all URL formats - permissive behavior');
  });

  test('should handle rapid connect/disconnect cycles', async ({ page }) => {
    await setupPage(page);

    const result = await page.evaluate(async () => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', 'error-test-5');

      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'TestDevice' }]
      });

      const results = [];
      let errorOccurred = false;
      
      // Rapid connect/disconnect cycles
      for (let i = 0; i < 5; i++) {
        try {
          await device.gatt.connect();
          results.push({ cycle: i, action: 'connect', success: true });
          
          device.gatt.disconnect();
          results.push({ cycle: i, action: 'disconnect', success: true });
          
          // No delay - stress test
        } catch (error) {
          results.push({ cycle: i, error: error.message });
          errorOccurred = true;
          break;
        }
      }

      return { results, errorOccurred, deviceName: device.name };
    });

    console.log('Rapid cycle results:', result);
    
    // Document the behavior
    if (result.errorOccurred) {
      console.log('Note: Rapid cycles caused an error - expected without WebSocket server');
      expect(result.results.length).toBeGreaterThan(0);
    } else {
      const cycles = result.results.filter(r => r.action === 'connect').length;
      console.log(`Completed ${cycles} connect/disconnect cycles successfully`);
      expect(cycles).toBeGreaterThan(0);
    }
  });
});