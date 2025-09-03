/**
 * Minimal zombie session repro test
 * Just connect and get battery twice using the mock (not direct WebSocket)
 * This should reveal if sessions are properly cleaned up between connections
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Zombie Session Repro', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');
  
  test('connect and get battery twice in a row', async ({ page }) => {
    console.log('[Zombie Test] Starting zombie session reproduction test');
    
    // Setup page with bundle
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.endsWith('/bundle.js')) {
        await route.fulfill({
          path: bundlePath,
          contentType: 'application/javascript',
        });
      } else {
        await route.fulfill({
          body: '<html><body>Test Page</body></html>',
          contentType: 'text/html',
        });
      }
    });

    await page.goto('http://localhost/test');
    await page.addScriptTag({ url: '/bundle.js' });
    
    // Inject mock with session
    await page.evaluate(() => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
        sessionId: 'e2e-test-session',
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
        
        // Request device (this goes through the mock)
        log.push('Requesting device...');
        const device1 = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,  // Accept any device, don't filter by name
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
          if (value && value.byteLength >= 2) {
            const bytes = new Uint8Array(value.buffer);
            // For this test, any response with non-zero/non-FFFF values is valid battery
            const firstTwo = (bytes[0] << 8) | bytes[1];
            if (firstTwo !== 0x0000 && firstTwo !== 0xFFFF) {
              battery1 = 1; // Just mark as received, actual value doesn't matter for zombie test
              log.push(`Battery response received: ${bytes.length} bytes, first: 0x${bytes[0].toString(16).padStart(2, '0').toUpperCase()}`);
            }
          }
        });
        
        // Send battery command (correct voltage command)
        log.push('Sending battery command...');
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
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // === SECOND CONNECTION ===
        log.push('');
        log.push('=== SECOND CONNECTION ATTEMPT ===');
        
        // Request device again
        log.push('Requesting device again...');
        const device2 = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,  // Accept any device, don't filter by name
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
          if (value && value.byteLength >= 2) {
            const bytes = new Uint8Array(value.buffer);
            // For this test, any response with non-zero/non-FFFF values is valid battery
            const firstTwo = (bytes[0] << 8) | bytes[1];
            if (firstTwo !== 0x0000 && firstTwo !== 0xFFFF) {
              battery2 = 1; // Just mark as received, actual value doesn't matter for zombie test
              log.push(`Battery response received: ${bytes.length} bytes, first: 0x${bytes[0].toString(16).padStart(2, '0').toUpperCase()}`);
            }
          }
        });
        
        // Send battery command
        log.push('Sending battery command...');
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
        
        // === RESULTS ===
        log.push('');
        log.push('=== TEST RESULTS ===');
        log.push(`First connection: ${battery1 ? `✅ Got response` : '❌ No response'}`);
        log.push(`Second connection: ${battery2 ? `✅ Got response` : '❌ No response'}`);
        log.push(`Same device ID: ${device1.id === device2.id ? 'Yes' : 'No'}`);
        
        return { 
          success: battery1 !== null && battery2 !== null,
          log,
          battery1,
          battery2,
          deviceId1: device1.id,
          deviceId2: device2.id
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
    console.log('[Zombie Test] Results:');
    results.log.forEach(line => console.log(`  ${line}`));
    
    // Test assertions
    expect(results.success).toBe(true);
    if (results.battery1) {
      expect(results.battery1).toBeTruthy(); // Got response on first connection
    }
    if (results.battery2) {
      expect(results.battery2).toBeTruthy(); // Got response on second connection
    }
  });
});