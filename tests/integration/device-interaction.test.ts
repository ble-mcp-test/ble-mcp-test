import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig, setupTestServer } from '../test-config.js';
import { connectionFactory } from '../connection-factory.js';

const DEVICE_CONFIG = getDeviceConfig();


describe.sequential('Device Interaction Tests', () => {
  let server: any;
  
  beforeAll(async () => {
    server = await setupTestServer();
  });
  
  afterAll(async () => {
    await connectionFactory.cleanup();
    if (server) {
      server.stop();
    }
  });
  
  afterEach(async () => {
    // Ensure proper cleanup between tests
    await connectionFactory.cleanup();
    // Start with 30s delay for binary search
    // CS108 on Pi needs more time for full BLE stack recovery
    const delayMs = 30000; // Start high: 30s
    console.log(`[Test] Waiting ${delayMs/1000}s for BLE cleanup...`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  });
  
  it('sends GET_BATTERY_VOLTAGE command and receives response', async () => {
    console.log('🔋 Test: GET_BATTERY_VOLTAGE (0xA000) command');
    
    const params = new URLSearchParams(DEVICE_CONFIG);
    const connectionResult = await connectionFactory.connect(WS_URL, params);
    
    if (!connectionResult.connected) {
      // Skip test if no device available
      if (connectionResult.error?.includes('No device found')) {
        console.log('Skipping battery test: No device available');
        return;
      }
      throw new Error(`Failed to connect: ${connectionResult.error}`);
    }
    
    console.log(`  ✅ Connected to device: ${connectionResult.deviceName}`);
    
    // Send GET_BATTERY_VOLTAGE command (0xA000)
    // Based on packet capture: a7 b3 02 d9 82 37 00 00 a0 00
    const batteryCommand = {
      type: 'data',
      data: [0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]
    };
    
    console.log('  📡 Sending GET_BATTERY_VOLTAGE command...');
    
    // Use the connection factory's sendCommand method
    const response = await connectionFactory.sendCommand(batteryCommand);
    
    if (response.type === 'data' && response.data) {
      const data = response.data;
      console.log(`  📥 Received data: [${data.map((b: number) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);
      
      // Battery voltage response format (from packet capture):
      // a7 b3 04 d9 82 9e 59 8f a0 00 0f eb
      // - Byte 5 = 0x9E (response direction)
      // - Bytes 8-9 = 0xA000 (command code)
      // - Bytes 10-11 = voltage in millivolts (big-endian)
      if (data.length >= 12 && 
          data[5] === 0x9E &&  // Response direction byte
          data[8] === 0xA0 && 
          data[9] === 0x00) {
        
        // Extract voltage (big-endian 16-bit value at bytes 10-11)
        const batteryVoltage = (data[10] << 8) | data[11];
        console.log(`  🔋 Battery voltage: ${batteryVoltage} mV (${(batteryVoltage/1000).toFixed(2)}V)`);
        console.log(`  ✅ Successfully received battery voltage: ${batteryVoltage} mV`);
        
        // Verify reasonable battery voltage (3.0V to 4.2V for typical Li-ion)
        expect(batteryVoltage).toBeGreaterThan(3000);
        expect(batteryVoltage).toBeLessThan(4500);
        
        // Calculate approximate battery percentage (3.3V = 0%, 4.1V = 100%)
        const percentage = Math.round(((batteryVoltage - 3300) / (4100 - 3300)) * 100);
        console.log(`  🔋 Battery level: ~${percentage}%`);
      } else {
        throw new Error('Unexpected response format');
      }
    } else if (response.type === 'error') {
      throw new Error(`Device error: ${response.error}`);
    } else {
      throw new Error(`Unexpected result: ${JSON.stringify(response)}`);
    }
  });

  // Future tests can be added here for other commands
  // e.g., READ_TAG, WRITE_TAG, etc.
});