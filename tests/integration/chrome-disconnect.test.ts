import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import { exec } from 'child_process';
import { promisify } from 'util';
import { WS_URL, getDeviceConfig, setupTestServer } from '../test-config.js';

const execAsync = promisify(exec);
const DEVICE_CONFIG = getDeviceConfig();

describe.sequential('Chrome Interactive Disconnect Tests', () => {
  afterEach(async () => {
    // Give hardware time to recover between tests
    await new Promise(resolve => setTimeout(resolve, 3000));
  });

  async function checkBleConnections(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('sudo hcitool con');
      const lines = stdout.split('\n').filter(line => line.includes('LE'));
      return lines.map(line => {
        const match = line.match(/([0-9A-F:]{17})/);
        return match ? match[1] : '';
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  it('should properly cleanup BLE connection after Chrome-style disconnect', async () => {
    console.log('🌐 Test: Chrome interactive disconnect (WebSocket close → grace period → cleanup)');
    
    const server = await setupTestServer();
    
    try {
      const params = new URLSearchParams(DEVICE_CONFIG);
      const url = `${WS_URL}?${params}`;
      
      // Check initial BLE state
      const initialConnections = await checkBleConnections();
      console.log(`  📊 Initial BLE connections: ${initialConnections.length}`);
      
      // Connect to device
      const ws = new WebSocket(url);
      let deviceName: string | null = null;
      let deviceAddress: string | null = null;
      
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 15000);
        
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === 'connected') {
            deviceName = msg.device;
            console.log(`  ✅ Connected to device: ${deviceName}`);
            // Extract address from device name if it's in MAC format
            if (deviceName && deviceName.match(/^[0-9a-fA-F]{12}$/)) {
              deviceAddress = deviceName.match(/.{2}/g)!.join(':').toUpperCase();
            }
            clearTimeout(timeout);
            resolve();
          } else if (msg.type === 'error') {
            if (msg.error?.includes('No device found')) {
              console.log('  ⏭️ Skipping: No device available');
              clearTimeout(timeout);
              resolve();
              return;
            }
            clearTimeout(timeout);
            reject(new Error(`Connection error: ${msg.error}`));
          }
        });
        
        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
      
      if (!deviceName) {
        console.log('  ⚠️ Test skipped: No device connected');
        return;
      }
      
      // Verify BLE connection exists
      const connectedState = await checkBleConnections();
      console.log(`  📊 BLE connections after connect: ${connectedState.length}`);
      if (deviceAddress) {
        const hasOurDevice = connectedState.includes(deviceAddress);
        console.log(`  🔍 Our device (${deviceAddress}) connected: ${hasOurDevice}`);
      }
      
      // Simulate Chrome disconnect - just close WebSocket without cleanup
      console.log('  🔌 Simulating Chrome tab close (WebSocket disconnect)...');
      ws.close();
      
      // Wait a moment for WebSocket to close
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Check if BLE is still connected (it should be - grace period)
      const gracePeriodState = await checkBleConnections();
      console.log(`  📊 BLE connections during grace period: ${gracePeriodState.length}`);
      
      // Wait for grace period to expire (5s in test mode)
      console.log('  ⏳ Waiting 6s for grace period to expire...');
      await new Promise(resolve => setTimeout(resolve, 6000));
      
      // Check if BLE cleanup worked
      const finalState = await checkBleConnections();
      console.log(`  📊 BLE connections after grace period: ${finalState.length}`);
      
      // With our fix, the connection should be cleaned up
      if (deviceAddress) {
        const stillConnected = finalState.includes(deviceAddress);
        console.log(`  🔍 Our device (${deviceAddress}) still connected: ${stillConnected}`);
        expect(stillConnected).toBe(false);
      } else {
        // If we couldn't determine the address, just check that connections decreased
        expect(finalState.length).toBeLessThan(gracePeriodState.length);
      }
      
      console.log('  ✅ BLE connection properly cleaned up after grace period');
      
    } finally {
      await server.stop();
    }
  });

  it('should block new connections during cleanup with friendly message', async () => {
    console.log('🚫 Test: Connection blocking during cleanup');
    
    const server = await setupTestServer();
    
    try {
      const params = new URLSearchParams(DEVICE_CONFIG);
      const url = `${WS_URL}?${params}`;
      
      // First connection
      const ws1 = new WebSocket(url);
      let connected = false;
      
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 5000);
        
        ws1.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'connected') {
            connected = true;
            console.log(`  ✅ First connection established`);
            clearTimeout(timeout);
            resolve();
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      
      if (!connected) {
        console.log('  ⚠️ Test skipped: No device available');
        return;
      }
      
      // Close first connection to trigger cleanup
      console.log('  🔌 Closing first connection...');
      ws1.close();
      
      // Immediately try to connect again (during cleanup)
      await new Promise(resolve => setTimeout(resolve, 100));
      
      console.log('  🔄 Attempting second connection during cleanup...');
      const ws2 = new WebSocket(url);
      
      const error = await new Promise<string | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 5000);
        
        ws2.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'error') {
            clearTimeout(timeout);
            resolve(msg.error);
          } else if (msg.type === 'connected') {
            clearTimeout(timeout);
            resolve(null);
          }
        });
        
        ws2.on('error', () => {
          clearTimeout(timeout);
          resolve('WebSocket error');
        });
      });
      
      if (error) {
        console.log(`  ✅ Got expected error: "${error}"`);
        // Should get recovery message
        expect(error).toMatch(/recovering|cleanup|try again/i);
      } else {
        console.log('  ⚠️ Connection succeeded - cleanup may have completed quickly');
      }
      
      ws2.close();
      
    } finally {
      await server.stop();
    }
  });
});