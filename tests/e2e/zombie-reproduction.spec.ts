/**
 * Minimal zombie session repro test
 * Just connect and get battery twice using the mock (not direct WebSocket)
 * This should reveal if sessions are properly cleaned up between connections
 */

import { test, expect } from '@playwright/test';
import { getBleConfig, setupMockPage, injectMockInPage } from './test-config';
import { getBatteryVoltageCommand } from '../../src/cs108-commands';

test.describe('Zombie Session Repro', () => {
  test('connect and get battery twice in a row', async ({ page }) => {
    console.log('[Zombie Test] Starting zombie session reproduction test');
    
    // Test will fail if bridge server not available - that's intentional for troubleshooting
    
    // Setup page with bundle and auto-inject mock
    await setupMockPage(page, `
      <!DOCTYPE html>
      <html>
      <head>
        <script src="/bundle.js"></script>
      </head>
      <body>
        <div id="result">Zombie Reproduction Test</div>
      </body>
      </html>
    `);
    
    const batteryCommand = Array.from(getBatteryVoltageCommand());
    
    const results = await page.evaluate(async ({ testConfig, batteryCmd }) => {
      const log: string[] = [];
      const { service, write, notify } = testConfig;
      
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
          filters: [{ services: [service] }]  // Use service filtering from config
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
        const service1 = await server1.getPrimaryService(service);
        log.push('Service obtained');
        
        // Get characteristics
        log.push('Getting write characteristic...');
        const writeChar1 = await service1.getCharacteristic(write);
        log.push('Getting notify characteristic...');
        const notifyChar1 = await service1.getCharacteristic(notify);
        log.push('Characteristics obtained');
        
        // Set up notifications
        log.push('Starting notifications...');
        await notifyChar1.startNotifications();
        
        // Capture battery voltage response
        let battery1: number | null = null;
        notifyChar1.addEventListener('characteristicvaluechanged', (event) => {
          const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
          if (value) {
            const bytes = new Uint8Array(value.buffer);
            // Check for battery voltage response
            // Response format: A7 B3 04 D9 82 9E xx xx A0 00 VH VL
            // Where VH VL = voltage raw value (big-endian)
            if (bytes.length >= 12 && 
                bytes[0] === 0xA7 && bytes[1] === 0xB3 && 
                bytes[8] === 0xA0 && bytes[9] === 0x00) {
              // Extract raw voltage from bytes 10-11 (big-endian)
              const voltageRaw = (bytes[10] << 8) | bytes[11];
              battery1 = voltageRaw; // Report raw value without scaling
              log.push(`Battery voltage response received: raw=${battery1}`);
            }
          }
        });
        
        // Send GET_BATTERY_VOLTAGE command (0xA000)
        log.push('Sending battery voltage command...');
        await writeChar1.writeValue(new Uint8Array(batteryCmd));
        
        // Wait for response
        log.push('Waiting 1 second for battery response...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        if (!battery1) {
          log.push('WARNING: No battery response received');
        }
        
        // Disconnect first connection normally
        log.push('Disconnecting first connection...');
        device1.gatt!.disconnect();
        log.push('First connection disconnected');
        
        // Wait a moment for cleanup
        log.push('Waiting 1 second before next connection...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // === SECOND CONNECTION ===
        log.push('');
        log.push('=== SECOND CONNECTION ATTEMPT ===');
        
        // Request device again
        log.push('Requesting device again...');
        const device2 = await navigator.bluetooth.requestDevice({
          filters: [{ services: [service] }]  // Use service filtering from config
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
        const service2 = await server2.getPrimaryService(service);
        log.push('Service obtained');
        
        // Get characteristics
        log.push('Getting write characteristic...');
        const writeChar2 = await service2.getCharacteristic(write);
        log.push('Getting notify characteristic...');
        const notifyChar2 = await service2.getCharacteristic(notify);
        log.push('Characteristics obtained');
        
        // Set up notifications
        log.push('Starting notifications...');
        await notifyChar2.startNotifications();
        
        // Capture battery voltage response
        let battery2: number | null = null;
        notifyChar2.addEventListener('characteristicvaluechanged', (event) => {
          const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
          if (value) {
            const bytes = new Uint8Array(value.buffer);
            // Check for battery voltage response (same format as first connection)
            if (bytes.length >= 12 && 
                bytes[0] === 0xA7 && bytes[1] === 0xB3 && 
                bytes[8] === 0xA0 && bytes[9] === 0x00) {
              const voltageRaw = (bytes[10] << 8) | bytes[11];
              battery2 = voltageRaw;
              log.push(`Battery voltage response received: raw=${battery2}`);
            }
          }
        });
        
        // Send battery voltage command (reuse same command)
        log.push('Sending battery voltage command...');
        await writeChar2.writeValue(batteryCmd);
        
        // Wait for response
        log.push('Waiting 1 second for battery response...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        if (!battery2) {
          log.push('WARNING: No battery response received');
        }
        
        // Disconnect second connection normally (force cleanup is broken - creates zombies)
        log.push('Disconnecting second connection...');
        device2.gatt!.disconnect();
        log.push('Second connection disconnected');
        
        // Wait before third attempt
        log.push('Waiting 1 second before next connection...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // === THIRD CONNECTION ===
        log.push('');
        log.push('=== THIRD CONNECTION ATTEMPT ===');
        
        // Request device for third time
        log.push('Requesting device for third time...');
        const device3 = await navigator.bluetooth.requestDevice({
          filters: [{ services: [service] }]
        });
        log.push(`Device found: ${device3.name || 'unnamed'}, ID: ${device3.id}`);
        
        // Connect GATT
        log.push('Connecting GATT...');
        if (!device3.gatt) {
          log.push('ERROR: No GATT interface on device');
          return { success: false, log };
        }
        const server3 = await device3.gatt.connect();
        log.push(`GATT connected: ${server3.connected}`);
        
        // Get service
        log.push('Getting service...');
        const service3 = await server3.getPrimaryService(service);
        log.push('Service obtained');
        
        // Get characteristics
        log.push('Getting write characteristic...');
        const writeChar3 = await service3.getCharacteristic(write);
        log.push('Getting notify characteristic...');
        const notifyChar3 = await service3.getCharacteristic(notify);
        log.push('Characteristics obtained');
        
        // Set up notifications
        log.push('Starting notifications...');
        await notifyChar3.startNotifications();
        
        // Capture battery voltage response
        let battery3: number | null = null;
        notifyChar3.addEventListener('characteristicvaluechanged', (event) => {
          const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
          if (value) {
            const bytes = new Uint8Array(value.buffer);
            // Check for battery voltage response
            if (bytes.length >= 12 && 
                bytes[0] === 0xA7 && bytes[1] === 0xB3 && 
                bytes[8] === 0xA0 && bytes[9] === 0x00) {
              const voltageRaw = (bytes[10] << 8) | bytes[11];
              battery3 = voltageRaw;
              log.push(`Battery voltage response received: raw=${battery3}`);
            }
          }
        });
        
        // Send battery voltage command
        log.push('Sending battery voltage command...');
        await writeChar3.writeValue(batteryCmd);
        
        // Wait for response
        log.push('Waiting 1 second for battery response...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        if (!battery3) {
          log.push('WARNING: No battery response received');
        }
        
        // Disconnect third connection normally (force cleanup creates zombies)
        log.push('Disconnecting third connection...');
        device3.gatt!.disconnect();
        log.push('Third connection disconnected');
        
        // === RESULTS ===
        log.push('');
        log.push('=== TEST RESULTS ===');
        log.push(`First connection: ${battery1 ? `✅ Battery raw value ${battery1}` : '❌ No battery voltage response'}`);
        log.push(`Second connection: ${battery2 ? `✅ Battery raw value ${battery2}` : '❌ No battery voltage response'}`);
        log.push(`Third connection: ${battery3 ? `✅ Battery raw value ${battery3}` : '❌ No battery voltage response'}`);
        log.push(`Device IDs: 1st=${device1.id}, 2nd=${device2.id}, 3rd=${device3.id}`);
        log.push(`All same device ID: ${(device1.id === device2.id && device2.id === device3.id) ? 'Yes' : 'No'}`);
        
        return { 
          success: battery1 !== null && battery2 !== null && battery3 !== null,
          log,
          battery1,
          battery2,
          battery3,
          deviceId1: device1.id,
          deviceId2: device2.id,
          deviceId3: device3.id
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
    }, { testConfig: getBleConfig(), batteryCmd: batteryCommand });
    
    // Print results
    console.log('[Zombie Test] Results:');
    results.log.forEach(line => console.log(`  ${line}`));
    
    // Test assertions - we expect ALL THREE to work
    // But if there's a pattern (like first fails, rest work), we want to see it
    const successCount = [results.battery1, results.battery2, results.battery3].filter(b => b !== null && b !== undefined).length;
    console.log(`[Zombie Test] Success count: ${successCount}/3 connections got battery response`);
    
    // All 3 MUST work - no partial credit (completeNobleReset ensures success)
    expect(successCount).toBe(3);
    
    // Check the pattern
    if (!results.battery1 && results.battery2 && results.battery3) {
      console.log('[Zombie Test] Pattern detected: First connection fails, subsequent connections work');
      console.log('[Zombie Test] This suggests the first connection creates a zombie that gets cleared');
    } else if (results.battery1 && !results.battery2 && results.battery3) {
      console.log('[Zombie Test] Pattern detected: Alternating success/failure');
    } else if (!results.battery1 && !results.battery2 && results.battery3) {
      console.log('[Zombie Test] Pattern detected: Only third connection works');
    }
    
    // If multiple connections worked, raw values should be similar
    const rawValues = [results.battery1, results.battery2, results.battery3].filter(v => v !== null && v !== undefined);
    if (rawValues.length >= 2) {
      const minValue = Math.min(...rawValues);
      const maxValue = Math.max(...rawValues);
      expect(maxValue - minValue).toBeLessThanOrEqual(100); // Within 100 raw units
    }
  });
});