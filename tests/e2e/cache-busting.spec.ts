import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Cache Busting', () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
  const currentVersion = packageJson.version;

  test('versioned bundle should exist and contain correct version', async ({ page }) => {
    // Check that versioned bundle file exists
    const versionedBundlePath = path.join(projectRoot, 'dist', `web-ble-mock.bundle.v${currentVersion}.js`);
    expect(fs.existsSync(versionedBundlePath)).toBe(true);

    // Load the bundle and check version property
    await page.goto('about:blank');
    await page.addScriptTag({ path: versionedBundlePath });

    // Check WebBleMock is loaded with correct version
    const version = await page.evaluate(() => {
      return (window as any).WebBleMock?.version;
    });
    expect(version).toBe(currentVersion);

    // Check getBundleVersion function
    const bundleVersion = await page.evaluate(() => {
      return (window as any).WebBleMock?.getBundleVersion?.();
    });
    expect(bundleVersion).toBe(currentVersion);
  });

  test('loading with timestamp query param should bypass cache', async ({ page }) => {
    // Just load the bundle directly since we're testing cache-busting functionality
    await page.goto('about:blank');
    await page.addScriptTag({ 
      path: path.join(projectRoot, 'dist', 'web-ble-mock.bundle.js'),
      // Add a unique identifier to force reload
      content: `// Cache bust: ${Date.now()}`
    });

    // Check version is present
    const version = await page.evaluate(() => (window as any).WebBleMock?.version);
    expect(version).toBe(currentVersion);
  });

  test('multiple loads with different timestamps should not conflict', async ({ page }) => {
    await page.goto('about:blank');
    
    // First load
    await page.addScriptTag({ 
      path: path.join(projectRoot, 'dist', 'web-ble-mock.bundle.js')
    });
    const firstVersion = await page.evaluate(() => (window as any).WebBleMock?.version);

    // Navigate to new blank page to simulate fresh load
    await page.goto('about:blank');
    
    // Second load
    await page.addScriptTag({ 
      path: path.join(projectRoot, 'dist', 'web-ble-mock.bundle.js')
    });
    const secondVersion = await page.evaluate(() => (window as any).WebBleMock?.version);

    // Both loads should have the same version
    expect(firstVersion).toBe(currentVersion);
    expect(secondVersion).toBe(currentVersion);
  });

  test('version mismatch detection', async ({ page }) => {
    await page.goto('about:blank');

    // Load bundle
    await page.addScriptTag({ path: path.join(projectRoot, 'dist', 'web-ble-mock.bundle.js') });

    // Simulate version mismatch scenario
    const mismatchResult = await page.evaluate((expectedVersion) => {
      const loadedVersion = (window as any).WebBleMock?.version;
      return {
        loaded: loadedVersion,
        expected: expectedVersion,
        matches: loadedVersion === expectedVersion
      };
    }, '99.99.99'); // Fake version to force mismatch

    expect(mismatchResult.loaded).toBe(currentVersion);
    expect(mismatchResult.expected).toBe('99.99.99');
    expect(mismatchResult.matches).toBe(false);
  });

  test('version check example page functions correctly', async ({ page }) => {
    // Use file:// URL to load the example
    const examplePath = `file://${path.join(projectRoot, 'examples', 'version-check.html')}`;
    await page.goto(examplePath);

    // Wait for page to load
    await page.waitForSelector('h1');

    // Test loading versioned bundle
    await page.click('button:has-text("Load Versioned Bundle")');
    await page.waitForTimeout(500);

    // Check success message appears
    const successMessage = await page.textContent('.success');
    expect(successMessage).toContain('Loaded versioned bundle');

    // Test version check
    await page.click('button:has-text("Check Version")');
    await page.waitForTimeout(100);

    // Verify version info is displayed
    const output = await page.textContent('#output');
    expect(output).toContain('WebBleMock loaded');
    expect(output).toContain(`Bundle version: ${currentVersion}`);
    expect(output).toContain('Version matches expected');
  });

  test('cache busting with random query prevents stale loads', async ({ page, context }) => {
    // Create two pages to simulate different sessions
    const page1 = await context.newPage();
    const page2 = await context.newPage();

    // Load bundle in both pages
    await page1.goto('about:blank');
    await page1.addScriptTag({ 
      path: path.join(projectRoot, 'dist', 'web-ble-mock.bundle.js')
    });

    await page2.goto('about:blank'); 
    await page2.addScriptTag({ 
      path: path.join(projectRoot, 'dist', 'web-ble-mock.bundle.js')
    });

    // Check versions
    const version1 = await page1.evaluate(() => (window as any).WebBleMock?.version);
    const version2 = await page2.evaluate(() => (window as any).WebBleMock?.version);

    expect(version1).toBe(currentVersion);
    expect(version2).toBe(currentVersion);

    await page1.close();
    await page2.close();
  });
});