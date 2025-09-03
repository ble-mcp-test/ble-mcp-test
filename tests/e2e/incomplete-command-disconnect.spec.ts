/**
 * Test to verify if sending incomplete/partial commands followed by disconnect
 * leaves the CS108 reader in a bad state that affects reconnection
 * 
 * Hypothesis: Partial data in the command buffer might not be cleared on disconnect,
 * causing the next connection to receive corrupted responses or fail
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { E2E_TEST_CONFIG, getBleConfig } from './test-config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Incomplete Command + Disconnect Test', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');
  
  test.skip('CS108 should handle incomplete command + disconnect + reconnect - SKIPPED: device-specific edge case', async ({ page }) => {
    console.log('[Incomplete Cmd Test] Testing reader stability with partial commands and disconnects');
    
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
          body: '<html><body>Incomplete Command Disconnect Test</body></html>',
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
      const validBatteryCmd = new Uint8Array([0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]);
      
      try {
        log.push('=== PHASE 1: INITIAL CONNECTION & BASELINE ===');
        
        // First connection - establish baseline
        let device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true
        });
        
        let server = await device.gatt.connect();
        let service = await server.getPrimaryService('9800');
        let writeChar = await service.getCharacteristic('9900');
        let notifyChar = await service.getCharacteristic('9901');
        
        // Set up notification handler
        let responses: Uint8Array[] = [];
        const handleNotification = (event: any) => {
          const value = new Uint8Array(event.target.value.buffer);
          responses.push(value);
          const hex = Array.from(value).map(b => b.toString(16).padStart(2, '0')).join(' ');
          log.push(`Response: ${hex}`);
        };
        
        notifyChar.addEventListener('characteristicvaluechanged', handleNotification);
        await notifyChar.startNotifications();
        
        // Send valid command to get baseline
        log.push('Sending valid battery command for baseline...');
        await writeChar.writeValue(validBatteryCmd);
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const baselineResponse = responses[responses.length - 1];
        log.push(`Baseline established: ${baselineResponse ? 'Got response' : 'No response'}`);
        
        log.push('\n=== PHASE 2: INCOMPLETE COMMAND + DISCONNECT ===');
        
        // Test 1: Send partial command (only first 3 bytes) then disconnect immediately
        log.push('Test 1: Sending 3-byte partial command and disconnecting...');
        const partial3Bytes = new Uint8Array([0xA7, 0xB3, 0x02]);
        await writeChar.writeValue(partial3Bytes);
        log.push('Partial command sent, disconnecting immediately...');
        
        // Disconnect without waiting for response
        await device.gatt.disconnect();
        log.push('Disconnected');
        
        // Wait a bit before reconnecting
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        log.push('\n=== PHASE 3: RECONNECT AND TEST ===');
        log.push('Reconnecting to device...');
        
        // Reconnect
        device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true
        });
        
        server = await device.gatt.connect();
        service = await server.getPrimaryService('9800');
        writeChar = await service.getCharacteristic('9900');
        notifyChar = await service.getCharacteristic('9901');
        
        // Reset response tracking
        responses = [];
        notifyChar.addEventListener('characteristicvaluechanged', handleNotification);
        await notifyChar.startNotifications();
        
        log.push('Reconnected successfully');
        
        // Try sending valid command after reconnect
        log.push('Sending valid battery command after reconnect...');
        await writeChar.writeValue(validBatteryCmd);
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const reconnectResponse1 = responses[responses.length - 1];
        const test1Success = reconnectResponse1 !== undefined;
        log.push(`Test 1 result: ${test1Success ? '✅ Reader responded correctly' : '❌ No response'}`);
        
        // Disconnect again
        await device.gatt.disconnect();
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        log.push('\n=== PHASE 4: MORE AGGRESSIVE TEST ===');
        
        // Test 2: Send multiple partial commands then disconnect
        log.push('Test 2: Sending multiple partial commands then disconnect...');
        
        // Reconnect again
        device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true
        });
        
        server = await device.gatt.connect();
        service = await server.getPrimaryService('9800');
        writeChar = await service.getCharacteristic('9900');
        notifyChar = await service.getCharacteristic('9901');
        
        responses = [];
        notifyChar.addEventListener('characteristicvaluechanged', handleNotification);
        await notifyChar.startNotifications();
        
        // Send multiple incomplete commands rapidly
        log.push('Sending rapid-fire partial commands...');
        const partial1 = new Uint8Array([0xA7]);
        const partial2 = new Uint8Array([0xB3, 0x02]);
        const partial3 = new Uint8Array([0xD9, 0x82, 0x37]);
        const partial4 = new Uint8Array([0x00]);
        
        await writeChar.writeValue(partial1);
        await writeChar.writeValue(partial2);
        await writeChar.writeValue(partial3);
        await writeChar.writeValue(partial4);
        log.push('4 partial fragments sent, disconnecting...');
        
        // Disconnect immediately
        await device.gatt.disconnect();
        log.push('Disconnected');
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        log.push('\n=== PHASE 5: FINAL RECONNECT TEST ===');
        log.push('Final reconnection attempt...');
        
        // Final reconnect
        device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true
        });
        
        server = await device.gatt.connect();
        service = await server.getPrimaryService('9800');
        writeChar = await service.getCharacteristic('9900');
        notifyChar = await service.getCharacteristic('9901');
        
        responses = [];
        notifyChar.addEventListener('characteristicvaluechanged', handleNotification);
        await notifyChar.startNotifications();
        
        log.push('Reconnected, sending valid command...');
        
        // Try valid command one more time
        await writeChar.writeValue(validBatteryCmd);
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const finalResponse = responses[responses.length - 1];
        const finalSuccess = finalResponse !== undefined;
        log.push(`Final test result: ${finalSuccess ? '✅ Reader still working' : '❌ Reader unresponsive'}`);
        
        if (finalResponse && baselineResponse) {
          const baselineHex = Array.from(baselineResponse).map(b => b.toString(16).padStart(2, '0')).join(' ');
          const finalHex = Array.from(finalResponse).map(b => b.toString(16).padStart(2, '0')).join(' ');
          const sameAsBaseline = baselineHex === finalHex;
          log.push(`Response comparison: ${sameAsBaseline ? '✅ Same as baseline' : '⚠️ Different from baseline'}`);
          if (!sameAsBaseline) {
            log.push(`  Baseline: ${baselineHex}`);
            log.push(`  Final:    ${finalHex}`);
          }
        }
        
        // Test 3: Edge case - disconnect during a write operation
        log.push('\n=== PHASE 6: DISCONNECT DURING WRITE ===');
        log.push('Test 3: Starting write and disconnecting mid-operation...');
        
        // Start a write but disconnect immediately
        const writePromise = writeChar.writeValue(validBatteryCmd);
        device.gatt.disconnect(); // Don't await - disconnect during write
        
        let writeError = null;
        try {
          await writePromise;
        } catch (e: any) {
          writeError = e.message;
          log.push(`Write failed as expected: ${e.message}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Try to reconnect one final time
        log.push('Final reconnection after disconnect-during-write...');
        device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true
        });
        
        server = await device.gatt.connect();
        service = await server.getPrimaryService('9800');
        writeChar = await service.getCharacteristic('9900');
        notifyChar = await service.getCharacteristic('9901');
        
        responses = [];
        notifyChar.addEventListener('characteristicvaluechanged', handleNotification);
        await notifyChar.startNotifications();
        
        // Final command
        log.push('Sending final validation command...');
        await writeChar.writeValue(validBatteryCmd);
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const veryFinalResponse = responses[responses.length - 1];
        const veryFinalSuccess = veryFinalResponse !== undefined;
        log.push(`Very final test: ${veryFinalSuccess ? '✅ Reader recovered from all abuse' : '❌ Reader finally gave up'}`);
        
        // Clean disconnect
        await device.gatt.disconnect();
        log.push('\nTest complete, disconnected cleanly');
        
        return {
          log,
          baselineWorked: baselineResponse !== undefined,
          test1_partialThenReconnect: test1Success,
          test2_multiplePartials: finalSuccess,
          test3_disconnectDuringWrite: veryFinalSuccess,
          allTestsPassed: test1Success && finalSuccess && veryFinalSuccess,
          conclusion: (test1Success && finalSuccess && veryFinalSuccess) ?
            'CS108 handles incomplete commands + disconnects correctly' :
            'CS108 may have issues with incomplete commands in buffer'
        };
        
      } catch (error: any) {
        log.push(`ERROR: ${error.message}`);
        return {
          log,
          error: error.message
        };
      }
    });
    
    // Print results
    console.log('[Incomplete Cmd Test] Results:');
    results.log.forEach(line => console.log(`  ${line}`));
    
    console.log('\n[Incomplete Cmd Test] Summary:');
    console.log(`  Baseline worked: ${results.baselineWorked}`);
    console.log(`  Test 1 (3-byte partial): ${results.test1_partialThenReconnect ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`  Test 2 (multiple partials): ${results.test2_multiplePartials ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`  Test 3 (disconnect during write): ${results.test3_disconnectDuringWrite ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`  Conclusion: ${results.conclusion}`);
    
    // Assertions
    expect(results.baselineWorked).toBe(true);
    
    // These are the critical tests
    if (!results.allTestsPassed) {
      console.warn('⚠️ WARNING: CS108 has issues with incomplete commands in buffer!');
      console.warn('Partial commands followed by disconnect may leave reader in bad state.');
    }
    
    expect(results.test1_partialThenReconnect).toBe(true);
    expect(results.test2_multiplePartials).toBe(true);
    expect(results.test3_disconnectDuringWrite).toBe(true);
  });
});