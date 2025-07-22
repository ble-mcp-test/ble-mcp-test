import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();

// Helper to find free port
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.listen(0, () => {
      const port = server.address()?.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

describe('Device Interaction Tests', () => {
  let server: BridgeServer;
  let useExternalServer = false;
  let testPort = 8080;
  let testUrl = WS_URL;
  
  beforeAll(async () => {
    if (process.env.WS_URL && !process.env.WS_URL.includes('localhost')) {
      useExternalServer = true;
      console.log(`🔋 Testing device interaction at: ${WS_URL}`);
    } else {
      // Find free port to avoid conflicts
      testPort = await findFreePort();
      testUrl = `ws://localhost:${testPort}`;
      console.log(`Starting device interaction test server on port ${testPort}`);
      
      server = new BridgeServer();
      server.start(testPort, { useMockTransport: true });
      
      // Wait for server to be ready
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  });
  
  afterAll(async () => {
    if (!useExternalServer && server) {
      await server.stop();
      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  });
  
  it('sends GET_BATTERY_VOLTAGE command and receives response', async () => {
    console.log('🔋 Test: GET_BATTERY_VOLTAGE (0xA000) command');
    
    const params = new URLSearchParams(DEVICE_CONFIG);
    const ws = new WebSocket(`${testUrl}?${params}`);
    let deviceConnected = false;
    let batteryVoltage = 0;
    
    const result = await new Promise<{ success: boolean; voltage?: number; error?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve({ success: false, error: 'Timeout' });
      }, 10000);
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        
        if (msg.type === 'connected') {
          console.log(`  ✅ Connected to device: ${msg.device}`);
          deviceConnected = true;
          
          // Send GET_BATTERY_VOLTAGE command (0xA000)
          // Based on packet capture: a7 b3 02 d9 82 37 00 00 a0 00
          const batteryCommand = {
            type: 'data',
            data: [0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]
          };
          
          console.log('  📡 Sending GET_BATTERY_VOLTAGE command...');
          ws.send(JSON.stringify(batteryCommand));
          
        } else if (msg.type === 'data' && msg.data) {
          // Check if this is a battery voltage response
          const data = msg.data;
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
            batteryVoltage = (data[10] << 8) | data[11];
            console.log(`  🔋 Battery voltage: ${batteryVoltage} mV (${(batteryVoltage/1000).toFixed(2)}V)`);
            
            clearTimeout(timeout);
            ws.close();
            resolve({ success: true, voltage: batteryVoltage });
          }
          
        } else if (msg.type === 'error') {
          console.log(`  ❌ Error: ${msg.error}`);
          clearTimeout(timeout);
          ws.close();
          resolve({ success: false, error: msg.error });
        }
      });
      
      ws.on('error', (error) => {
        clearTimeout(timeout);
        resolve({ success: false, error: error.message });
      });
    });
    
    // Check results
    if (result.error?.includes('No device found')) {
      console.log('  ℹ️  No CS108 device available (expected in test environment)');
      expect(result.error).toContain('No device found');
    } else if (result.success && result.voltage) {
      console.log(`  ✅ Successfully received battery voltage: ${result.voltage} mV`);
      
      // Verify voltage is in reasonable range (3000-4500 mV)
      expect(result.voltage).toBeGreaterThan(3000);
      expect(result.voltage).toBeLessThan(4500);
      
      // Calculate battery percentage (rough estimate)
      const percentage = Math.round(((result.voltage - 3000) / (4200 - 3000)) * 100);
      console.log(`  🔋 Battery level: ~${percentage}%`);
    } else {
      throw new Error(`Unexpected result: ${JSON.stringify(result)}`);
    }
  });
});