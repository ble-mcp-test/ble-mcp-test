import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';
import { setupMockPage, getBleConfig } from './test-config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Mock Bundle Validation Tests
 * 
 * Focused test suite for bundle-specific and parameter validation:
 * 1. Bundle loading and versioning
 * 2. Required parameter validation (v0.6.0 breaking change)
 * 
 * All other mock functionality is tested through actual usage in other tests.
 */
test.describe('Mock Bundle Validation', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');
  const projectRoot = path.resolve(__dirname, '../..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
  const currentVersion = packageJson.version;

  test.describe('Bundle Loading & Versioning', () => {
    test('should load bundle and expose WebBleMock global with correct version', async ({ page }) => {
      await page.goto('about:blank');
      
      // Load the bundle directly
      await page.addScriptTag({ path: bundlePath });
      
      // Check WebBleMock global exists with correct structure
      const bundleInfo = await page.evaluate(() => {
        return {
          hasWebBleMock: typeof window.WebBleMock !== 'undefined',
          hasInjectFunction: typeof window.WebBleMock?.injectWebBluetoothMock === 'function',
          hasMockClass: typeof window.WebBleMock?.MockBluetooth === 'function',
          version: window.WebBleMock?.version,
          bundleVersion: window.WebBleMock?.getBundleVersion?.()
        };
      });
      
      expect(bundleInfo.hasWebBleMock).toBe(true);
      expect(bundleInfo.hasInjectFunction).toBe(true);
      expect(bundleInfo.hasMockClass).toBe(true);
      expect(bundleInfo.version).toBe(currentVersion);
      
      // bundleVersion might not exist in older versions
      if (bundleInfo.bundleVersion !== undefined) {
        expect(bundleInfo.bundleVersion).toBe(currentVersion);
      }
    });

    test('should handle versioned bundle loading', async ({ page }) => {
      // Check that versioned bundle file exists
      const versionedBundlePath = path.join(projectRoot, 'dist', `web-ble-mock.bundle.v${currentVersion}.js`);
      
      // Skip if versioned bundle doesn't exist (not all builds create it)
      if (!fs.existsSync(versionedBundlePath)) {
        test.skip();
        return;
      }

      // Load versioned bundle and verify
      await page.goto('about:blank');
      await page.addScriptTag({ path: versionedBundlePath });

      const version = await page.evaluate(() => {
        return window.WebBleMock?.version;
      });
      expect(version).toBe(currentVersion);
    });

    test('should detect version mismatches correctly', async ({ page }) => {
      await page.goto('about:blank');
      await page.addScriptTag({ path: bundlePath });

      // Simulate version mismatch check
      const mismatchResult = await page.evaluate((expectedVersion) => {
        const loadedVersion = window.WebBleMock?.version;
        return {
          loaded: loadedVersion,
          expected: expectedVersion,
          matches: loadedVersion === expectedVersion
        };
      }, '99.99.99'); // Fake version

      expect(mismatchResult.loaded).toBe(currentVersion);
      expect(mismatchResult.expected).toBe('99.99.99');
      expect(mismatchResult.matches).toBe(false);
    });
  });

  test.describe('Required Parameter Validation (v0.6.0)', () => {
    test.beforeEach(async ({ page }) => {
      // Use shared helper but don't inject mock yet
      await page.goto('about:blank');
      await page.addScriptTag({ path: bundlePath });
    });

    test('should require sessionId and throw clear error when missing', async ({ page }) => {
      const result = await page.evaluate(() => {
        try {
          // Try to inject without sessionId (should fail)
          window.WebBleMock.injectWebBluetoothMock({
            serverUrl: 'ws://localhost:8080',
            service: '9800'
          } as any);
          return { success: true, error: null };
        } catch (error: any) {
          return { success: false, error: error.message };
        }
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('sessionId is required');
      expect(result.error).toContain('prevents session conflicts');
    });

    test('should require serverUrl and throw clear error when missing', async ({ page }) => {
      const result = await page.evaluate(() => {
        try {
          // Try to inject without serverUrl (should fail)
          window.WebBleMock.injectWebBluetoothMock({
            sessionId: 'test-session',
            service: '9800'
          } as any);
          return { success: true, error: null };
        } catch (error: any) {
          return { success: false, error: error.message };
        }
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('serverUrl is required');
      expect(result.error).toContain('bridge server URL');
    });

    test('should require service and throw clear error when missing', async ({ page }) => {
      const result = await page.evaluate(() => {
        try {
          // Try to inject without service (should fail)
          window.WebBleMock.injectWebBluetoothMock({
            sessionId: 'test-session',
            serverUrl: 'ws://localhost:8080'
          } as any);
          return { success: true, error: null };
        } catch (error: any) {
          return { success: false, error: error.message };
        }
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('service is required');
      expect(result.error).toContain('primary service UUID');
    });

    test('should accept all required parameters and inject successfully', async ({ page }) => {
      const config = getBleConfig();
      
      const result = await page.evaluate((cfg) => {
        try {
          window.WebBleMock.injectWebBluetoothMock(cfg);
          return { 
            success: true,
            hasBluetooth: 'bluetooth' in navigator,
            hasRequestDevice: typeof navigator.bluetooth?.requestDevice === 'function'
          };
        } catch (error: any) {
          return { success: false, error: error.message };
        }
      }, config);
      
      expect(result.success).toBe(true);
      expect(result.hasBluetooth).toBe(true);
      expect(result.hasRequestDevice).toBe(true);
    });
  });

  test.describe('Edge Cases', () => {
    test('should handle empty string parameters as missing', async ({ page }) => {
      await page.goto('about:blank');
      await page.addScriptTag({ path: bundlePath });

      const result = await page.evaluate(() => {
        const testCases = [
          { sessionId: '', serverUrl: 'ws://localhost:8080', service: '9800' },
          { sessionId: 'test', serverUrl: '', service: '9800' },
          { sessionId: 'test', serverUrl: 'ws://localhost:8080', service: '' }
        ];

        return testCases.map(config => {
          try {
            window.WebBleMock.injectWebBluetoothMock(config as any);
            return { config, success: true };
          } catch (error: any) {
            return { config, success: false, error: error.message };
          }
        });
      });

      // All should fail with appropriate error messages
      expect(result[0].success).toBe(false);
      expect(result[0].error).toContain('sessionId is required');
      
      expect(result[1].success).toBe(false);
      expect(result[1].error).toContain('serverUrl is required');
      
      expect(result[2].success).toBe(false);
      expect(result[2].error).toContain('service is required');
    });
  });
});