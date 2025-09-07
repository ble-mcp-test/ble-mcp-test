/**
 * Minimal zombie session repro test
 * Just connect and get battery twice using the mock (not direct WebSocket)
 * This should reveal if sessions are properly cleaned up between connections
 */

import { test, expect } from '@playwright/test';
import { getBleConfig, setupMockPage, testCommandHelper } from './test-config';

test.describe('Zombie Session Repro', () => {
  test('simplified test using testCommand helper', async ({ page }) => {
    console.log('[Zombie Test] Starting simplified test using testCommand helper');
    
    // Setup page with bundle and inject mock
    await setupMockPage(page);
    
    // Use the testCommandHelper three times in sequence
    console.log('=== FIRST TEST COMMAND ===');
    const result1 = await testCommandHelper(page);
    
    console.log('Waiting 1 second...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('=== SECOND TEST COMMAND ===');
    const result2 = await testCommandHelper(page);
    
    console.log('=== THIRD TEST COMMAND ===');
    const result3 = await testCommandHelper(page);
    
    const results = {
      success: result1 && result2 && result3,
      results: [result1, result2, result3],
      log: [`First: ${result1}`, `Second: ${result2}`, `Third: ${result3}`]
    };

    console.log('[Zombie Test] Results:', results);
    results.log.forEach(line => console.log(`  ${line}`));

    expect(results.success).toBe(true);
    expect(results.results?.length).toBe(3);
    expect(results.results?.every(r => r)).toBe(true);
  });

  test('connect and send test command multiple times', async ({ page }) => {
    console.log('[Zombie Test] Starting multiple connection test');
    
    // Setup page with bundle and inject mock
    await setupMockPage(page);
    
    // Use testCommandHelper for three sequential connections
    console.log('=== FIRST CONNECTION ===');
    const result1 = await testCommandHelper(page);
    
    console.log('Waiting 1 second...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('=== SECOND CONNECTION ===');
    const result2 = await testCommandHelper(page);
    
    console.log('Waiting 1 second...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('=== THIRD CONNECTION ===');
    const result3 = await testCommandHelper(page);
    
    const results = {
      success: result1 && result2 && result3,
      results: [result1, result2, result3],
      log: [`First: ${result1}`, `Second: ${result2}`, `Third: ${result3}`]
    };

    console.log('[Zombie Test] Results:', results);
    results.log.forEach(line => console.log(`  ${line}`));

    // All 3 MUST work
    expect(results.success).toBe(true);
    expect(results.results?.length).toBe(3);
    expect(results.results?.every(r => r)).toBe(true);
  });
});