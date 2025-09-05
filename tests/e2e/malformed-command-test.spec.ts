/**
 * Test to verify if malformed/invalid commands leave the CS108 reader in an unstable state
 * This tests the hypothesis that sending bad commands might cause the reader to become unresponsive
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { E2E_TEST_CONFIG, getBleConfig } from './test-config';
import { getBatteryVoltageCommand } from '../../src/cs108-commands';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Malformed Command Recovery Test', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');
  
  test('CS108 should recover from malformed commands', async ({ page }) => {
    console.log('[Malformed Test] Testing reader stability with invalid commands');
    
    // Setup page
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.endsWith('/bundle.js')) {
        await route.fulfill({
          path: bundlePath,
          contentType: 'application/javascript',
        });
      } else {
        await route.fulfill({
          body: '<html><body>Malformed Command Test</body></html>',
          contentType: 'text/html',
        });
      }
    });

    await page.goto('http://localhost/test');
    await page.addScriptTag({ url: '/bundle.js' });
    
    // Wait for bundle to load
    await page.waitForTimeout(100);
    
    // Inject Web Bluetooth mock with shared session ID
    await page.evaluate((config) => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', config);
    }, getBleConfig());
    
    const results = await page.evaluate(async () => {
      const log: string[] = [];
      const responses: any[] = [];
      
      try {
        log.push('=== PHASE 1: ESTABLISH BASELINE CONNECTION ===');
        
        // Connect to device
        const device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true
        });
        
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService('9800');
        const writeChar = await service.getCharacteristic('9900');
        const notifyChar = await service.getCharacteristic('9901');
        
        // Set up notification handler
        let lastResponse: Uint8Array | null = null;
        notifyChar.addEventListener('characteristicvaluechanged', (event: any) => {
          const value = new Uint8Array(event.target.value.buffer);
          lastResponse = value;
          const hex = Array.from(value).map(b => b.toString(16).padStart(2, '0')).join(' ');
          log.push(`Response received: ${hex}`);
          responses.push({ type: 'notification', hex, timestamp: Date.now() });
        });
        
        await notifyChar.startNotifications();
        
        // Send valid battery command to establish baseline
        log.push('Sending VALID battery voltage command (0xA000)...');
        const validBatteryCmd = getBatteryVoltageCommand();
        await writeChar.writeValue(validBatteryCmd);
        
        await new Promise(resolve => setTimeout(resolve, 1500));
        const baselineResponse = lastResponse;
        log.push(`Baseline response: ${baselineResponse ? 'Received' : 'None'}`);
        
        log.push('\n=== PHASE 2: SEND MALFORMED COMMANDS ===');
        
        // Test 1: Completely invalid header
        log.push('Test 1: Sending garbage data (invalid header)...');
        const garbageCmd = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
        lastResponse = null;
        await writeChar.writeValue(garbageCmd);
        await new Promise(resolve => setTimeout(resolve, 1500));
        log.push(`Response to garbage: ${lastResponse ? 'Received' : 'None (timeout)'}`);
        
        // Test 2: Valid header but invalid command code
        log.push('Test 2: Sending valid header with invalid command (0xFFFF)...');
        const invalidCmd = new Uint8Array([0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xFF, 0xFF]);
        lastResponse = null;
        await writeChar.writeValue(invalidCmd);
        await new Promise(resolve => setTimeout(resolve, 1500));
        log.push(`Response to invalid command: ${lastResponse ? 'Received' : 'None (timeout)'}`);
        
        // Test 3: Truncated command (too short)
        log.push('Test 3: Sending truncated command (only 5 bytes)...');
        const truncatedCmd = new Uint8Array([0xA7, 0xB3, 0x02, 0xD9, 0x82]);
        lastResponse = null;
        await writeChar.writeValue(truncatedCmd);
        await new Promise(resolve => setTimeout(resolve, 1500));
        log.push(`Response to truncated: ${lastResponse ? 'Received' : 'None (timeout)'}`);
        
        // Test 4: Oversized command
        log.push('Test 4: Sending oversized command (30 bytes)...');
        const oversizedCmd = new Uint8Array(30).fill(0xAA);
        oversizedCmd[0] = 0xA7;
        oversizedCmd[1] = 0xB3;
        lastResponse = null;
        await writeChar.writeValue(oversizedCmd);
        await new Promise(resolve => setTimeout(resolve, 1500));
        log.push(`Response to oversized: ${lastResponse ? 'Received' : 'None (timeout)'}`);
        
        // Test 5: Wrong checksum/CRC (if applicable)
        log.push('Test 5: Sending command with bad checksum...');
        const badChecksumCmd = new Uint8Array([0xA7, 0xB3, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xA0, 0x00]);
        lastResponse = null;
        await writeChar.writeValue(badChecksumCmd);
        await new Promise(resolve => setTimeout(resolve, 1500));
        log.push(`Response to bad checksum: ${lastResponse ? 'Received' : 'None (timeout)'}`);
        
        log.push('\n=== PHASE 3: VERIFY READER RECOVERY ===');
        
        // Send the same valid battery command again to check if reader still responds
        log.push('Sending VALID battery command again to test recovery...');
        lastResponse = null;
        await writeChar.writeValue(validBatteryCmd);
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const recoveryResponse = lastResponse;
        const recovered = recoveryResponse !== null;
        log.push(`Recovery test: ${recovered ? '✅ RECOVERED - Reader still responds' : '❌ FAILED - Reader unresponsive'}`);
        
        if (recoveryResponse && baselineResponse) {
          const baselineHex = Array.from(baselineResponse).map(b => b.toString(16).padStart(2, '0')).join(' ');
          const recoveryHex = Array.from(recoveryResponse).map(b => b.toString(16).padStart(2, '0')).join(' ');
          const sameResponse = baselineHex === recoveryHex;
          log.push(`Response comparison: ${sameResponse ? '✅ Same as baseline' : '⚠️ Different from baseline'}`);
          log.push(`  Baseline: ${baselineHex}`);
          log.push(`  Recovery: ${recoveryHex}`);
        }
        
        // Try one more valid command to be sure
        log.push('\nDouble-check: Sending battery command once more...');
        lastResponse = null;
        await writeChar.writeValue(validBatteryCmd);
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const finalResponse = lastResponse;
        log.push(`Final test: ${finalResponse ? '✅ Reader still working' : '❌ Reader not responding'}`);
        
        // Disconnect cleanly
        await device.gatt.disconnect();
        log.push('\nDisconnected from device');
        
        return {
          log,
          responses,
          baselineWorked: baselineResponse !== null,
          recovered: recovered,
          finallyWorking: finalResponse !== null,
          summary: {
            totalMalformedSent: 5,
            readerRecovered: recovered && (finalResponse !== null),
            conclusion: recovered ? 
              'Reader appears resilient to malformed commands' : 
              'Reader may have issues with malformed commands'
          }
        };
        
      } catch (error: any) {
        log.push(`ERROR: ${error.message}`);
        return {
          log,
          responses,
          error: error.message
        };
      }
    });
    
    // Print results
    console.log('[Malformed Test] Results:');
    results.log.forEach(line => console.log(`  ${line}`));
    
    console.log('\n[Malformed Test] Summary:');
    console.log(`  Baseline worked: ${results.baselineWorked}`);
    console.log(`  Recovered after malformed: ${results.recovered}`);
    console.log(`  Still working at end: ${results.finallyWorking}`);
    console.log(`  Conclusion: ${results.summary?.conclusion}`);
    
    // Assertions
    expect(results.baselineWorked).toBe(true);
    
    // The key test: does the reader recover after malformed commands?
    if (!results.recovered) {
      console.warn('⚠️ WARNING: Reader did not recover after malformed commands!');
      console.warn('This suggests malformed commands may leave the CS108 in an unstable state.');
    }
    
    expect(results.recovered).toBe(true);
    expect(results.finallyWorking).toBe(true);
  });
});