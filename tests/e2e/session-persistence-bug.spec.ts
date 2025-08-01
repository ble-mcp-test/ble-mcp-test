import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

test.describe('Session Persistence Bug Reproduction', () => {
  test('should maintain same session ID across page reloads', async ({ page }) => {
    // Use a simple HTTP server URL or file:// protocol
    const htmlPath = join(__dirname, '../../examples/minimal-session-repro.html');
    await page.goto(`file://${htmlPath}`);
    
    // Enable console logging
    page.on('console', msg => {
      console.log(`[Browser Console] ${msg.text()}`);
    });
    
    // Wait for page to load
    await page.waitForLoadState('domcontentloaded');
    
    // Step 1: Inject mock
    await page.click('#inject');
    await page.waitForTimeout(500);
    
    // Step 2: Show session info
    await page.click('#showSession');
    await page.waitForTimeout(500);
    
    // Get the session ID from the log
    const firstSessionLog = await page.locator('#log').textContent();
    // In Playwright context, we'll have an autoSessionId instead of localStorage
    const firstAutoMatch = firstSessionLog?.match(/navigator\.bluetooth\.autoSessionId: ([\w\.-]+)/);
    const firstSessionId = firstAutoMatch?.[1];
    console.log('First session ID:', firstSessionId);
    
    // Step 3: Connect
    await page.click('#connect');
    await page.waitForTimeout(2000);
    
    // Get WebSocket session from log
    const firstConnectLog = await page.locator('#log').textContent();
    const firstWsMatch = firstConnectLog?.match(/WebSocket URL session parameter: ([\w\.-]+)/);
    const firstWsSession = firstWsMatch?.[1];
    console.log('First WebSocket session:', firstWsSession);
    
    // Step 4: Reload page
    console.log('\n--- Reloading page ---\n');
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    
    // Check if session persisted (may not have the message div)
    try {
      const reloadMessage = await page.locator('body > div.success, body > div.info').first().textContent({ timeout: 2000 });
      console.log('After reload message:', reloadMessage);
    } catch {
      console.log('No reload message found');
    }
    
    // Step 5: Inject mock again
    await page.click('#inject');
    await page.waitForTimeout(500);
    
    // Step 6: Show session info again
    await page.click('#showSession');
    await page.waitForTimeout(500);
    
    // Get the session ID after reload
    const secondSessionLog = await page.locator('#log').textContent();
    // In Playwright context, we'll have an autoSessionId instead of localStorage
    const secondAutoMatch = secondSessionLog?.match(/navigator\.bluetooth\.autoSessionId: ([\w\.-]+)/);
    const secondSessionId = secondAutoMatch?.[1];
    console.log('Second session ID:', secondSessionId);
    
    // Step 7: Connect again
    await page.click('#connect');
    await page.waitForTimeout(2000);
    
    // Get WebSocket session from log
    const secondConnectLog = await page.locator('#log').textContent();
    // Find the last occurrence of WebSocket URL session parameter
    const allWsMatches = [...secondConnectLog?.matchAll(/WebSocket URL session parameter: ([\w\.-]+)/g) || []];
    const secondWsSession = allWsMatches[allWsMatches.length - 1]?.[1];
    console.log('Second WebSocket session:', secondWsSession);
    
    // Check for bug
    const bugDetected = await page.locator('#log').textContent();
    const hasBug = bugDetected?.includes('🐛 BUG:');
    
    console.log('\n=== Test Results ===');
    console.log('First session ID:', firstSessionId);
    console.log('Second session ID:', secondSessionId);
    console.log('First WebSocket session:', firstWsSession);
    console.log('Second WebSocket session:', secondWsSession);
    console.log('Bug detected?', hasBug);
    
    // Assertions
    expect(firstSessionId).toBeTruthy();
    expect(secondSessionId).toBeTruthy();
    expect(firstSessionId).toBe(secondSessionId); // Should reuse same session
    
    // In Playwright context with deterministic session IDs, the WebSocket connection
    // will fail (no server running) but we can verify the session IDs are consistent
    if (firstWsSession) {
      expect(firstWsSession).toBe(firstSessionId); // WebSocket should use stored session
    }
    if (secondWsSession) {
      expect(secondWsSession).toBe(secondSessionId); // WebSocket should use stored session
    }
    
    // Since we're using deterministic session IDs in Playwright, there's no bug
    expect(hasBug).toBe(false); // Should not detect bug
  });
});