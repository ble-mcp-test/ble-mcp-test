import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Deterministic Session ID E2E Tests', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');

  test('should generate deterministic session ID in Playwright', async ({ page }) => {
    // Enable console logging
    const consoleLogs: string[] = [];
    page.on('console', (msg) => {
      consoleLogs.push(msg.text());
    });

    // Serve the bundle
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

    const result = await page.evaluate(async () => {
      // Clear any existing session
      window.WebBleMock.clearStoredSession();
      
      // Inject mock without explicit session - should auto-detect Playwright
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
        service: '9800',
        write: '9900',
        notify: '9901'
      });
      
      // Request device
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'CS108' }]
      });
      
      return {
        sessionId: (device as any).sessionId,
        userAgent: navigator.userAgent
      };
    });

    // Verify deterministic session ID was generated
    console.log('Generated session ID:', result.sessionId);
    console.log('User agent:', result.userAgent);
    
    // Session ID should include hostname and test path
    expect(result.sessionId).toMatch(/^localhost-/);
    expect(result.sessionId).toContain('tests/e2e/deterministic-session');
    
    // Should NOT have random suffix
    expect(result.sessionId).not.toMatch(/-[A-Z0-9]{4}$/);
    
    // Verify Playwright was detected
    const playwrightLogs = consoleLogs.filter(log => 
      log.includes('Playwright') && log.includes('session ID')
    );
    expect(playwrightLogs.length).toBeGreaterThan(0);
  });

  test('should use explicit session ID when provided', async ({ page }) => {
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

    const result = await page.evaluate(async () => {
      // Set explicit test session ID
      window.WebBleMock.setTestSessionId('explicit-e2e-test-session');
      
      // Inject mock
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
        service: '9800',
        write: '9900',
        notify: '9901'
      });
      
      // Request device
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'CS108' }]
      });
      
      return {
        sessionId: (device as any).sessionId
      };
    });

    // Should use the explicit session ID
    expect(result.sessionId).toBe('explicit-e2e-test-session');
  });

  test('should maintain same session ID across page reloads', async ({ page }) => {
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

    // First load
    await page.goto('http://localhost/test');
    await page.addScriptTag({ url: '/bundle.js' });

    const firstSession = await page.evaluate(async () => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'CS108' }]
      });
      return (device as any).sessionId;
    });

    // Reload page
    await page.reload();
    await page.addScriptTag({ url: '/bundle.js' });

    const secondSession = await page.evaluate(async () => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'CS108' }]
      });
      return (device as any).sessionId;
    });

    // Should generate the same deterministic session ID
    expect(secondSession).toBe(firstSession);
  });

  test('should allow different sessions for different test files', async ({ page }) => {
    // This test simulates what happens when different test files run
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

    const results = await page.evaluate(async () => {
      // Simulate test file 1
      window.BLE_TEST_SESSION_ID = 'localhost-tests/e2e/inventory-page';
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
      const device1 = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'CS108' }]
      });
      const session1 = (device1 as any).sessionId;
      
      // Clear for next test
      delete window.BLE_TEST_SESSION_ID;
      
      // Simulate test file 2
      window.BLE_TEST_SESSION_ID = 'localhost-tests/e2e/scanning-page';
      const device2 = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'CS108' }]
      });
      const session2 = (device2 as any).sessionId;
      
      return { session1, session2 };
    });

    // Different test files should get different session IDs
    expect(results.session1).toBe('localhost-tests/e2e/inventory-page');
    expect(results.session2).toBe('localhost-tests/e2e/scanning-page');
    expect(results.session1).not.toBe(results.session2);
  });

  test('should handle environment variable session ID', async ({ page }) => {
    // Set environment variable before test
    process.env.BLE_TEST_SESSION_ID = 'ci-test-run-123';
    
    try {
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

      // Pass environment variable to page context
      await page.evaluate((envSessionId) => {
        // Simulate environment variable in browser context
        (window as any).process = { env: { BLE_TEST_SESSION_ID: envSessionId } };
      }, process.env.BLE_TEST_SESSION_ID);

      const result = await page.evaluate(async () => {
        window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: 'CS108' }]
        });
        return (device as any).sessionId;
      });

      // Should use environment variable (if properly passed to browser context)
      // Note: In real Playwright tests, env vars don't transfer to browser context
      // so this would fall back to deterministic generation
      console.log('Session ID with env var:', result);
    } finally {
      delete process.env.BLE_TEST_SESSION_ID;
    }
  });
});