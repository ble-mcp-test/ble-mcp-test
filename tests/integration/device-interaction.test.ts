import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig, setupTestServer } from '../test-config.js';
import { connectionFactory } from '../connection-factory.js';

const DEVICE_CONFIG = getDeviceConfig();


describe.sequential('Device Interaction Tests', () => {
  // Test battery command with both info and debug log levels
  ['info', 'debug'].forEach((logLevel) => {
    it(`sends GET_BATTERY_VOLTAGE command with ${logLevel} logging`, async () => {
      console.log(`🔋 Test: GET_BATTERY_VOLTAGE (0xA000) command with ${logLevel.toUpperCase()} logging`);
      
      // Save original LOG_LEVEL and set test level
      const originalLogLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = logLevel;
      
      // Start server with the specific log level
      const server = await setupTestServer();
      
      // Set up log capture
      const logs: any[] = [];
      const logWs = new WebSocket(`${WS_URL}?command=log-stream`);
      
      await new Promise<void>((resolve, reject) => {
        logWs.on('open', () => resolve());
        logWs.on('error', reject);
      });
      
      // Capture log messages
      logWs.on('message', (data) => {
        const log = JSON.parse(data.toString());
        logs.push(log);
      });
      
      try {
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
            
            // Wait briefly for logs to arrive through the log stream
            await new Promise(resolve => setTimeout(resolve, 200));
            
            if (logLevel === 'debug') {
              // In debug mode, we should see TX/RX hex logs
              const txLogs = logs.filter(log => 
                log.type === 'log' && 
                log.message.includes('[TX]') && 
                log.message.includes('A7 B3 02 D9 82 37 00 00 A0 00')
              );
              console.log('  📝 TX hex logs captured:', txLogs.length);
              expect(txLogs.length).toBeGreaterThan(0);
              
              const rxLogs = logs.filter(log => 
                log.type === 'log' && 
                log.message.includes('[RX]') &&
                log.message.includes('A7 B3')
              );
              console.log('  📝 RX hex logs captured:', rxLogs.length);
              expect(rxLogs.length).toBeGreaterThan(0);
              
              // Should also see detailed Noble logs
              const nobleDiscoveryLogs = logs.filter(log => 
                log.type === 'log' && 
                log.message.includes('[NobleTransport] Discovered:')
              );
              console.log('  📝 Noble discovery logs:', nobleDiscoveryLogs.length);
              expect(nobleDiscoveryLogs.length).toBeGreaterThan(0);
              
            } else {
              // In info mode, we should NOT see TX/RX hex logs
              const txLogs = logs.filter(log => 
                log.type === 'log' && 
                log.message.includes('[TX]')
              );
              console.log('  📝 TX hex logs should be absent:', txLogs.length);
              expect(txLogs.length).toBe(0);
              
              const rxLogs = logs.filter(log => 
                log.type === 'log' && 
                log.message.includes('[RX]')
              );
              console.log('  📝 RX hex logs should be absent:', rxLogs.length);
              expect(rxLogs.length).toBe(0);
              
              // Should NOT see detailed Noble logs
              const nobleDiscoveryLogs = logs.filter(log => 
                log.type === 'log' && 
                log.message.includes('[NobleTransport] Discovered:')
              );
              console.log('  📝 Noble discovery logs should be absent:', nobleDiscoveryLogs.length);
              expect(nobleDiscoveryLogs.length).toBe(0);
              
              // But we should still see high-level connection events
              const connectionLogs = logs.filter(log => 
                log.type === 'log' && 
                (log.message.includes('BLE connected') || 
                 log.message.includes('Starting BLE connection'))
              );
              console.log('  📝 High-level connection logs:', connectionLogs.length);
              expect(connectionLogs.length).toBeGreaterThan(0);
            }
          } else {
            throw new Error('Unexpected response format');
          }
        } else if (response.type === 'error') {
          throw new Error(`Device error: ${response.error}`);
        } else {
          throw new Error(`Unexpected result: ${JSON.stringify(response)}`);
        }
      } finally {
        // Clean up
        logWs.close();
        await connectionFactory.cleanup();
        
        // Stop server
        if (server) {
          await server.stop();
        }
        
        // Restore original LOG_LEVEL
        if (originalLogLevel !== undefined) {
          process.env.LOG_LEVEL = originalLogLevel;
        } else {
          delete process.env.LOG_LEVEL;
        }
      }
    });
  });

  it('handles connection errors gracefully', async () => {
    console.log('🚫 Test: Connection error handling for non-existent device');
    
    const server = await setupTestServer();
    
    try {
      const errorConfig = { ...DEVICE_CONFIG, device: 'NONEXISTENT' };
      const params = new URLSearchParams(errorConfig);
      const result = await connectionFactory.connect(WS_URL, params);
      
      expect(result.connected).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('No device found');
      console.log('  ✅ Correctly handled non-existent device error');
    } finally {
      await connectionFactory.cleanup();
      if (server) {
        await server.stop();
      }
    }
  });

  // Future tests can be added here for other commands
  // e.g., READ_TAG, WRITE_TAG, etc.
});