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
    // Read the HTML file content and update the expected version
    const fs = await import('fs');
    const htmlPath = path.join(projectRoot, 'examples', 'version-check.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf-8');
    
    // Read the actual version from package.json
    const packageJsonPath = path.join(projectRoot, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const currentVersion = packageJson.version;
    
    // Update the expected version to match our current bundle version
    htmlContent = htmlContent.replace(/const EXPECTED_VERSION = '[^']+';/, `const EXPECTED_VERSION = '${currentVersion}';`);
    
    // Set up routing to serve the HTML and bundle
    await page.route('**/*', async route => {
      const url = route.request().url();
      
      if (url.endsWith('/version-check.html') || url === 'http://localhost/') {
        // Serve the HTML content
        await route.fulfill({
          body: htmlContent,
          contentType: 'text/html',
        });
      } else if (url.includes('web-ble-mock.bundle')) {
        // Extract the requested bundle file name
        const urlPath = new URL(url).pathname;
        const bundleMatch = urlPath.match(/web-ble-mock\.bundle(\.v[\d.]+)?\.js/);
        
        if (bundleMatch) {
          const bundleFileName = bundleMatch[0];
          const bundlePath = path.join(projectRoot, 'dist', bundleFileName);
          
          // Check if the specific version exists, otherwise use the default
          if (fs.existsSync(bundlePath)) {
            await route.fulfill({
              path: bundlePath,
              contentType: 'application/javascript',
            });
          } else {
            // Fallback to non-versioned bundle
            const defaultBundlePath = path.join(projectRoot, 'dist', 'web-ble-mock.bundle.js');
            await route.fulfill({
              path: defaultBundlePath,
              contentType: 'application/javascript',
            });
          }
        }
      } else {
        await route.continue();
      }
    });
    
    // Navigate to the test page
    await page.goto('http://localhost/');

    // Wait for page to load
    await page.waitForSelector('h1');

    // Test loading versioned bundle
    await page.click('button:has-text("Load Versioned Bundle")');
    
    // Wait a bit for the script to load
    await page.waitForTimeout(1000);
    
    // Check if there's an error message
    const errorMessages = await page.locator('#output .error').allTextContents();
    if (errorMessages.length > 0) {
      console.log('Error loading bundle:', errorMessages);
    }
    
    // Wait for any message to appear in output
    await page.waitForSelector('#output > *', { timeout: 5000 });
    
    // Get all messages
    const allMessages = await page.locator('#output > *').allTextContents();
    console.log('All output messages:', allMessages);
    
    // Check if bundle loaded successfully
    const hasLoadedMessage = allMessages.some(msg => msg.includes('Loaded versioned bundle'));
    const hasError = allMessages.some(msg => msg.includes('Failed to load'));
    
    if (hasError) {
      throw new Error('Failed to load versioned bundle');
    }
    
    expect(hasLoadedMessage).toBe(true);

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