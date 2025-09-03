/**
 * Fixed zombie session repro test
 * Corrected issues:
 * - Proper byte order for response checking (A7 B3, not B3 A7)
 * - Proper mock injection with bundle and config
 * - Using shared session ID for consistency
 * - Correct characteristic response handling
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Zombie Session Repro - Fixed', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');
  
  test('connect and get battery twice in a row', async ({ page }) => {
    console.log('[Zombie Test Fixed] Starting zombie session reproduction test');
    
    // Proper setup with bundle serving
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.endsWith('/bundle.js')) {
        await route.fulfill({
          path: bundlePath,
          contentType: 'application/javascript',
        });
      } else {
        await route.fulfill({
          body: '<html><body>Zombie Test Fixed</body></html>',
          contentType: 'text/html',
        });
      }
    });

    await page.goto('http://localhost/test');
    await page.addScriptTag({ url: '/bundle.js' });
    
    // Wait for bundle to load
    await page.waitForTimeout(100);
    
    // Inject Web Bluetooth mock with proper config and session
    await page.evaluate(() => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
        sessionId: 'e2e-test-session',
        device: 'CS108',  // This will match the filter
        service: '9800',
        write: '9900',
        notify: '9901'
      });
    });
    
    const results = await page.evaluate(async () => {
      const log: string[] = [];
      
      try {
        // === FIRST CONNECTION ===
        log.push('=== FIRST CONNECTION ATTEMPT ===');
        
        // Use the mock-injected navigator.bluetooth
        if (!navigator.bluetooth) {
          log.push('ERROR: Web Bluetooth not available');
          return { success: false, log };
        }
        
        // Request device - using acceptAllDevices to avoid filter issues
        log.push('Requesting device...');
        const device1 = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: ['9800']
        });
        log.push(`Device found: ${device1.name || 'unnamed'}, ID: ${device1.id}`);
        
        // Connect GATT
        log.push('Connecting GATT...');
        if (!device1.gatt) {
          log.push('ERROR: No GATT interface on device');
          return { success: false, log };
        }
        const server1 = await device1.gatt.connect();
        log.push(`GATT connected: ${server1.connected}`);
        
        // Get service
        log.push('Getting service...');
        const service1 = await server1.getPrimaryService('9800');
        log.push('Service obtained');
        
        // Get characteristics
        log.push('Getting write characteristic...');
        const writeChar1 = await service1.getCharacteristic('9900');
        log.push('Getting notify characteristic...');
        const notifyChar1 = await service1.getCharacteristic('9901');
        log.push('Characteristics obtained');
        
        // Set up notifications
        log.push('Starting notifications...');
        await notifyChar1.startNotifications();
        
        // Capture battery response
        let battery1: number | null = null;
        notifyChar1.addEventListener('characteristicvaluechanged', (event) => {
          const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
          if (value) {
            const bytes = new Uint8Array(value.buffer);
            // FIXED: Check for battery voltage response (A7 B3, not B3 A7!)
            if (bytes[0] === 0xA7 && bytes[1] === 0xB3) {
              // Check if this is a battery response (command code A0 00)
              if (bytes[8] === 0xA0 && bytes[9] === 0x00) {
                // Battery voltage is in bytes 10-11 (big endian millivolts)
                const millivolts = (bytes[10] << 8) | bytes[11];
                battery1 = Math.round(millivolts / 100) / 10; // Convert to volts
                log.push(`Battery voltage response received: ${battery1}V (${millivolts}mV)`);
              }
            }
          }
        });
        
        // Send battery command (correct voltage command)
        log.push('Sending battery voltage command...');
        const batteryCmd = new Uint8Array([0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]);
        await writeChar1.writeValue(batteryCmd);
        
        // Wait for response
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        if (!battery1) {
          log.push('WARNING: No battery response received');
        }
        
        // Disconnect first connection
        log.push('Disconnecting first connection...');
        device1.gatt!.disconnect();
        log.push('First connection disconnected');
        
        // Wait a moment for cleanup
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // === SECOND CONNECTION ===
        log.push('');
        log.push('=== SECOND CONNECTION ATTEMPT ===');
        
        // Request device again
        log.push('Requesting device again...');
        const device2 = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: ['9800']
        });
        log.push(`Device found: ${device2.name || 'unnamed'}, ID: ${device2.id}`);
        
        // Connect GATT
        log.push('Connecting GATT...');
        if (!device2.gatt) {
          log.push('ERROR: No GATT interface on device');
          return { success: false, log };
        }
        const server2 = await device2.gatt.connect();
        log.push(`GATT connected: ${server2.connected}`);
        
        // Get service
        log.push('Getting service...');
        const service2 = await server2.getPrimaryService('9800');
        log.push('Service obtained');
        
        // Get characteristics
        log.push('Getting write characteristic...');
        const writeChar2 = await service2.getCharacteristic('9900');
        log.push('Getting notify characteristic...');
        const notifyChar2 = await service2.getCharacteristic('9901');
        log.push('Characteristics obtained');
        
        // Set up notifications
        log.push('Starting notifications...');
        await notifyChar2.startNotifications();
        
        // Capture battery response
        let battery2: number | null = null;
        notifyChar2.addEventListener('characteristicvaluechanged', (event) => {
          const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
          if (value) {
            const bytes = new Uint8Array(value.buffer);
            // FIXED: Check for battery voltage response (A7 B3, not B3 A7!)
            if (bytes[0] === 0xA7 && bytes[1] === 0xB3) {
              // Check if this is a battery response (command code A0 00)
              if (bytes[8] === 0xA0 && bytes[9] === 0x00) {
                // Battery voltage is in bytes 10-11 (big endian millivolts)
                const millivolts = (bytes[10] << 8) | bytes[11];
                battery2 = Math.round(millivolts / 100) / 10; // Convert to volts
                log.push(`Battery voltage response received: ${battery2}V (${millivolts}mV)`);
              }
            }
          }
        });
        
        // Send battery command
        log.push('Sending battery voltage command...');
        await writeChar2.writeValue(batteryCmd);
        
        // Wait for response
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        if (!battery2) {
          log.push('WARNING: No battery response received');
        }
        
        // Disconnect second connection
        log.push('Disconnecting second connection...');
        device2.gatt!.disconnect();
        log.push('Second connection disconnected');
        
        // === THIRD CONNECTION FOR EXTRA VALIDATION ===
        log.push('');
        log.push('=== THIRD CONNECTION ATTEMPT (Extra Validation) ===');
        
        // Request device again
        log.push('Requesting device for third time...');
        const device3 = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: ['9800']
        });
        log.push(`Device found: ${device3.name || 'unnamed'}, ID: ${device3.id}`);
        
        // Connect and test
        const server3 = await device3.gatt!.connect();
        const service3 = await server3.getPrimaryService('9800');
        const writeChar3 = await service3.getCharacteristic('9900');
        const notifyChar3 = await service3.getCharacteristic('9901');
        
        await notifyChar3.startNotifications();
        
        let battery3: number | null = null;
        notifyChar3.addEventListener('characteristicvaluechanged', (event) => {
          const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
          if (value) {
            const bytes = new Uint8Array(value.buffer);
            if (bytes[0] === 0xA7 && bytes[1] === 0xB3 && bytes[8] === 0xA0 && bytes[9] === 0x00) {
              const millivolts = (bytes[10] << 8) | bytes[11];
              battery3 = Math.round(millivolts / 100) / 10;
              log.push(`Battery voltage response received: ${battery3}V (${millivolts}mV)`);
            }
          }
        });
        
        log.push('Sending battery voltage command...');
        await writeChar3.writeValue(batteryCmd);
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        if (!battery3) {
          log.push('WARNING: No battery response received on third attempt');
        }
        
        device3.gatt!.disconnect();
        log.push('Third connection disconnected');
        
        // === RESULTS ===
        log.push('');
        log.push('=== TEST RESULTS ===');
        log.push(`First connection: ${battery1 ? `✅ Battery voltage ${battery1}V` : '❌ No battery response'}`);
        log.push(`Second connection: ${battery2 ? `✅ Battery voltage ${battery2}V` : '❌ No battery response'}`);
        log.push(`Third connection: ${battery3 ? `✅ Battery voltage ${battery3}V` : '❌ No battery response'}`);
        log.push(`Device IDs: 1st=${device1.id}, 2nd=${device2.id}, 3rd=${device3.id}`);
        log.push(`All same device ID: ${device1.id === device2.id && device2.id === device3.id ? 'Yes' : 'No'}`);
        
        const successCount = [battery1, battery2, battery3].filter(b => b !== null).length;
        log.push(`Success count: ${successCount}/3 connections got battery response`);
        
        return { 
          success: battery1 !== null && battery2 !== null && battery3 !== null,
          log,
          battery1,
          battery2,
          battery3,
          deviceId1: device1.id,
          deviceId2: device2.id,
          deviceId3: device3.id,
          successCount
        };
        
      } catch (error) {
        const err = error as Error;
        log.push(`ERROR: ${err.message}`);
        if (err.stack) {
          const stackLine = err.stack.split('\n')[1]?.trim() || '';
          log.push(`  at: ${stackLine}`);
        }
        return { success: false, log, error: err.message };
      }
    });
    
    // Print results
    console.log('[Zombie Test Fixed] Results:');
    results.log.forEach(line => console.log(`  ${line}`));
    console.log(`[Zombie Test Fixed] Success count: ${results.successCount}/3 connections got battery response`);
    
    // Test assertions
    expect(results.success).toBe(true);
    
    // All three connections should get battery voltage around 40V (test mock value)
    expect(results.battery1).toBe(40.2);
    expect(results.battery2).toBe(40.2);
    expect(results.battery3).toBe(40.2);
    
    // All should use same device ID
    expect(results.deviceId1).toBe(results.deviceId2);
    expect(results.deviceId2).toBe(results.deviceId3);
  });
});