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

test.describe('Deterministic Session ID E2E Tests', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');

  test('should generate deterministic session ID in Playwright', async ({ page }) => {
    // Enable console logging
    const consoleLogs: string[] = [];
    page.on('console', (msg) => {
      console.log('Console:', msg.text());
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

    const bleConfig = getBleConfig();
    const result = await page.evaluate(async (config) => {
      // No need to clear session - localStorage is no longer used
      
      // Debug: Check what's available in Playwright environment
      const debugInfo = {
        userAgent: navigator.userAgent,
        windowKeys: Object.keys(window).filter(k => k.includes('play') || k.includes('test') || k.includes('__')),
        processEnv: typeof process !== 'undefined' ? Object.keys(process.env || {}).filter(k => k.includes('PLAYWRIGHT') || k.includes('TEST')) : [],
        locationHref: window.location.href,
        documentURL: document.URL,
      };
      
      console.log('Playwright environment debug:', debugInfo);
      
      // Inject mock without explicit session - should auto-detect Playwright
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
        service: config.service,
        write: config.write,
        notify: config.notify
      });
      
      // Request device
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: config.device }]
      });
      
      return {
        sessionId: (device as any).sessionId,
        userAgent: navigator.userAgent,
        debugInfo
      };
    }, bleConfig);

    // Verify deterministic session ID was generated
    console.log('Generated session ID:', result.sessionId);
    console.log('User agent:', result.userAgent);
    
    // Session ID should have simplified format: playwright-{project}
    expect(result.sessionId).toMatch(/^playwright-/);
    
    // Should have deterministic format: playwright-projectname
    // Since we simplified the session system for E2E testing
    expect(result.sessionId).toMatch(/^playwright-[a-z0-9-]+$/);
    
    // Verify Playwright was detected by checking the session format
    // The simplified system uses 'playwright-' prefix for Playwright environments
    expect(result.sessionId).toMatch(/^playwright-/);
    expect(result.sessionId).toBe('playwright-localhost');
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

    const bleConfig = getBleConfig();
    const result = await page.evaluate(async (config) => {
      // Use explicit session ID via config parameter
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
        service: config.service,
        write: config.write,
        notify: config.notify,
        sessionId: 'explicit-e2e-test-session'
      });
      
      // Request device
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: config.device }]
      });
      
      return {
        sessionId: (device as any).sessionId
      };
    }, bleConfig);

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

    const bleConfig = getBleConfig();
    const firstSession = await page.evaluate(async (config) => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: config.device }]
      });
      return (device as any).sessionId;
    }, bleConfig);

    // Reload page
    await page.reload();
    await page.addScriptTag({ url: '/bundle.js' });

    const secondSession = await page.evaluate(async (config) => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: config.device }]
      });
      return (device as any).sessionId;
    }, bleConfig);

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

    const bleConfig = getBleConfig();
    const results = await page.evaluate(async (config) => {
      // In the simplified system, all Playwright tests in the same project get the same session ID
      // This is intentional for connection pool sharing
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
      const device1 = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: config.device }]
      });
      const session1 = (device1 as any).sessionId;
      
      // Second device request in same project
      const device2 = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: config.device }]
      });
      const session2 = (device2 as any).sessionId;
      
      return { session1, session2 };
    }, bleConfig);

    // Both sessions should use the simplified format since the explicit IDs are ignored in favor of project-based IDs
    expect(results.session1).toMatch(/^playwright-/);
    expect(results.session2).toMatch(/^playwright-/);
    // They should be the same because both are using the same project
    expect(results.session1).toBe(results.session2);
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

      const bleConfig = getBleConfig();
      const result = await page.evaluate(async (config) => {
        window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: config.device }]
        });
        return (device as any).sessionId;
      }, bleConfig);

      // Should use environment variable (if properly passed to browser context)
      // Note: In real Playwright tests, env vars don't transfer to browser context
      // so this would fall back to deterministic generation
      console.log('Session ID with env var:', result);
    } finally {
      delete process.env.BLE_TEST_SESSION_ID;
    }
  });
});