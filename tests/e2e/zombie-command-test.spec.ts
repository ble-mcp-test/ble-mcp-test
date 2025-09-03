/**
 * Test the specific 8-byte malformed command from the original zombie repro issue
 * Command: 0xA7, 0xB3, 0x18, 0x00, 0x00, 0x00, 0x0A, 0x0D
 * 
 * This appears to be a header with wrong bytes and no payload:
 * - 0xA7, 0xB3: Standard header
 * - 0x18: Wrong byte (should be 0x02 for most commands)
 * - 0x00, 0x00, 0x00: Zeros 
 * - 0x0A, 0x0D: Looks like line feed + carriage return (suspicious!)
 * 
 * Total: Only 8 bytes (header with no payload)
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { E2E_TEST_CONFIG, getBleConfig } from './test-config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Zombie Command Specific Test', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');
  
  test('CS108 behavior with the specific zombie command', async ({ page }) => {
    console.log('[Zombie Cmd Test] Testing the specific 8-byte command that may have caused zombie issues');
    
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
          body: '<html><body>Zombie Command Test</body></html>',
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
      
      // Commands
      const validBatteryCmd = new Uint8Array([0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]);
      const zombieCmd = new Uint8Array([0xA7, 0xB3, 0x18, 0x00, 0x00, 0x00, 0x0A, 0x0D]);
      
      try {
        log.push('=== PHASE 1: ESTABLISH BASELINE ===');
        
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
          log.push(`Response: ${hex}`);
          responses.push({ 
            hex, 
            timestamp: Date.now(),
            afterCommand: responses.length === 0 ? 'baseline' : 'unknown'
          });
        });
        
        await notifyChar.startNotifications();
        
        // Get baseline with valid command
        log.push('Sending valid battery command for baseline...');
        await writeChar.writeValue(validBatteryCmd);
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const baselineResponse = lastResponse;
        log.push(`Baseline: ${baselineResponse ? 'Got response' : 'No response'}`);
        if (responses.length > 0) {
          responses[responses.length - 1].afterCommand = 'valid_battery';
        }
        
        log.push('\n=== PHASE 2: SEND THE ZOMBIE COMMAND ===');
        log.push('Sending the problematic 8-byte command:');
        log.push('  [0xA7, 0xB3, 0x18, 0x00, 0x00, 0x00, 0x0A, 0x0D]');
        log.push('  Header: A7 B3 (standard)');
        log.push('  Byte 3: 0x18 (WRONG - should be 0x02)');
        log.push('  Bytes 4-6: 0x00 0x00 0x00');
        log.push('  Bytes 7-8: 0x0A 0x0D (LF + CR?!)');
        
        lastResponse = null;
        await writeChar.writeValue(zombieCmd);
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const zombieResponse = lastResponse;
        log.push(`Response to zombie command: ${zombieResponse ? 'Got response' : 'No response (timeout)'}`);
        if (zombieResponse && responses.length > 0) {
          responses[responses.length - 1].afterCommand = 'zombie_8byte';
        }
        
        log.push('\n=== PHASE 3: TEST RECOVERY - IMMEDIATE ===');
        log.push('Sending valid battery command immediately after zombie...');
        
        lastResponse = null;
        await writeChar.writeValue(validBatteryCmd);
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const immediateRecovery = lastResponse;
        const immediatelyRecovered = immediateRecovery !== null;
        log.push(`Immediate recovery: ${immediatelyRecovered ? '✅ Reader responded' : '❌ Reader unresponsive'}`);
        if (immediateRecovery && responses.length > 0) {
          responses[responses.length - 1].afterCommand = 'recovery_immediate';
        }
        
        log.push('\n=== PHASE 4: SEND ZOMBIE COMMAND MULTIPLE TIMES ===');
        log.push('Testing cumulative effect - sending zombie command 3 times...');
        
        for (let i = 1; i <= 3; i++) {
          log.push(`  Zombie command #${i}...`);
          lastResponse = null;
          await writeChar.writeValue(zombieCmd);
          await new Promise(resolve => setTimeout(resolve, 1000));
          log.push(`    Response #${i}: ${lastResponse ? 'Got response' : 'No response'}`);
          if (lastResponse && responses.length > 0) {
            responses[responses.length - 1].afterCommand = `zombie_repeat_${i}`;
          }
        }
        
        log.push('Testing recovery after multiple zombie commands...');
        lastResponse = null;
        await writeChar.writeValue(validBatteryCmd);
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const afterMultipleRecovery = lastResponse;
        const recoveredAfterMultiple = afterMultipleRecovery !== null;
        log.push(`Recovery after multiple: ${recoveredAfterMultiple ? '✅ Still working' : '❌ Reader stuck'}`);
        if (afterMultipleRecovery && responses.length > 0) {
          responses[responses.length - 1].afterCommand = 'recovery_after_multiple';
        }
        
        log.push('\n=== PHASE 5: DISCONNECT/RECONNECT TEST ===');
        log.push('Sending zombie command then disconnecting...');
        
        await writeChar.writeValue(zombieCmd);
        log.push('Zombie sent, disconnecting immediately...');
        await device.gatt.disconnect();
        log.push('Disconnected');
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        log.push('Reconnecting...');
        const device2 = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true
        });
        
        const server2 = await device2.gatt.connect();
        const service2 = await server2.getPrimaryService('9800');
        const writeChar2 = await service2.getCharacteristic('9900');
        const notifyChar2 = await service2.getCharacteristic('9901');
        
        // Reset response tracking
        lastResponse = null;
        notifyChar2.addEventListener('characteristicvaluechanged', (event: any) => {
          const value = new Uint8Array(event.target.value.buffer);
          lastResponse = value;
          const hex = Array.from(value).map(b => b.toString(16).padStart(2, '0')).join(' ');
          log.push(`Response after reconnect: ${hex}`);
          responses.push({ 
            hex, 
            timestamp: Date.now(),
            afterCommand: 'after_reconnect'
          });
        });
        
        await notifyChar2.startNotifications();
        
        log.push('Sending valid command after reconnect...');
        await writeChar2.writeValue(validBatteryCmd);
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const reconnectResponse = lastResponse;
        const reconnectSuccess = reconnectResponse !== null;
        log.push(`After reconnect: ${reconnectSuccess ? '✅ Reader working' : '❌ Reader dead'}`);
        
        // Final analysis
        log.push('\n=== PHASE 6: PATTERN ANALYSIS ===');
        
        // Check if responses follow a pattern
        const errorResponses = responses.filter(r => r.hex.includes('a1 01'));
        const validResponses = responses.filter(r => r.hex.includes('a0 00'));
        
        log.push(`Total responses received: ${responses.length}`);
        log.push(`Error responses (A1 01): ${errorResponses.length}`);
        log.push(`Valid battery responses (A0 00): ${validResponses.length}`);
        
        if (baselineResponse && immediateRecovery) {
          const baseHex = Array.from(baselineResponse).map(b => b.toString(16).padStart(2, '0')).join(' ');
          const recovHex = Array.from(immediateRecovery).map(b => b.toString(16).padStart(2, '0')).join(' ');
          if (baseHex !== recovHex) {
            log.push('⚠️ Recovery response differs from baseline!');
            log.push(`  Baseline: ${baseHex}`);
            log.push(`  Recovery: ${recovHex}`);
          }
        }
        
        // Cleanup
        await device2.gatt.disconnect();
        log.push('\nTest complete');
        
        return {
          log,
          responses,
          baselineWorked: baselineResponse !== null,
          zombieGotResponse: zombieResponse !== null,
          immediateRecovery: immediatelyRecovered,
          multipleRecovery: recoveredAfterMultiple,
          reconnectRecovery: reconnectSuccess,
          allRecovered: immediatelyRecovered && recoveredAfterMultiple && reconnectSuccess,
          conclusion: !immediatelyRecovered ? 
            'CRITICAL: Zombie command breaks reader immediately!' :
            !recoveredAfterMultiple ? 
              'WARNING: Multiple zombie commands cause issues' :
              !reconnectSuccess ?
                'WARNING: Zombie command affects reconnection' :
                'Reader appears to handle zombie command OK'
        };
        
      } catch (error: any) {
        log.push(`ERROR: ${error.message}`);
        return { log, responses, error: error.message };
      }
    });
    
    // Print detailed results
    console.log('[Zombie Cmd Test] Detailed Results:');
    results.log.forEach(line => console.log(`  ${line}`));
    
    console.log('\n[Zombie Cmd Test] Response Details:');
    results.responses.forEach((r: any, i: number) => {
      console.log(`  ${i + 1}. ${r.afterCommand}: ${r.hex}`);
    });
    
    console.log('\n[Zombie Cmd Test] Summary:');
    console.log(`  Baseline worked: ${results.baselineWorked ? '✅' : '❌'}`);
    console.log(`  Zombie got response: ${results.zombieGotResponse ? 'Yes' : 'No'}`);
    console.log(`  Immediate recovery: ${results.immediateRecovery ? '✅' : '❌'}`);
    console.log(`  Multiple recovery: ${results.multipleRecovery ? '✅' : '❌'}`);
    console.log(`  Reconnect recovery: ${results.reconnectRecovery ? '✅' : '❌'}`);
    console.log(`  Conclusion: ${results.conclusion}`);
    
    // Assertions
    expect(results.baselineWorked).toBe(true);
    
    if (!results.allRecovered) {
      console.error('🚨 CRITICAL: The 8-byte zombie command causes reader issues!');
      console.error('Command: [0xA7, 0xB3, 0x18, 0x00, 0x00, 0x00, 0x0A, 0x0D]');
      console.error('This confirms the zombie command can destabilize the CS108.');
    }
    
    // We expect recovery to work, but log if it doesn't
    expect(results.immediateRecovery).toBe(true);
    expect(results.multipleRecovery).toBe(true);
    expect(results.reconnectRecovery).toBe(true);
  });
});