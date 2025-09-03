import { defineConfig } from '@playwright/test';

// Playwright tests ALWAYS run once and exit - no watch mode
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  fullyParallel: false,  // MUST be false - we only have one BLE device
  workers: 1,            // Force single worker - no parallel execution
  reporter: 'list',
  outputDir: './tmp/test-results',
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    video: 'retain-on-failure',
    baseURL: 'http://localhost:3000',
  },
  projects: [
    {
      name: 'chromium',
      use: { 
        browserName: 'chromium',
        launchOptions: {
          args: ['--disable-blink-features=AutomationControlled']
        }
      },
    },
  ],
  // No web server needed - all tests run directly in Playwright
});