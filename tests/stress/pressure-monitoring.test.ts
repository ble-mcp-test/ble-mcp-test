import { describe, it, beforeAll, afterAll } from 'vitest';
import { BridgeServer, NobleTransport } from '../../src/index.js';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();

describe('Pressure Monitoring Test', () => {
  let server: BridgeServer;
  
  beforeAll(() => {
    server = new BridgeServer('debug');
    server.start(8080);
  });
  
  afterAll(() => {
    if (server) {
      server.stop();
    }
  });
  
  it('monitors pressure levels during connection cycling', async () => {
    console.log('\n📊 PRESSURE MONITORING TEST\n');
    console.log('Monitoring Noble.js resource pressure during connection cycling...\n');
    
    // Helper to print pressure report
    const reportPressure = (label: string) => {
      const pressure = NobleTransport.checkPressure();
      console.log(`\n${label}:`);
      console.log(`  Noble listeners: ${pressure.nobleListeners}`);
      console.log(`  HCI bindings listeners: ${pressure.bindingsListeners}`);
      console.log(`  Peripheral listeners: ${pressure.peripheralListeners}`);
      console.log(`  Total listeners: ${pressure.totalListeners}`);
      console.log(`  Tracked peripherals: ${pressure.peripheralCount}`);
      console.log(`  Active scanners: ${pressure.activeScanners}`);
      console.log(`  scanStop listeners: ${pressure.scanStopListeners}`);
      console.log(`  discover listeners: ${pressure.discoverListeners}`);
    };
    
    // Initial state
    reportPressure('🟢 Initial state');
    
    const connections = 15;
    
    for (let i = 0; i < connections; i++) {
      console.log(`\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`Connection ${i + 1}/${connections}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      
      const params = new URLSearchParams(DEVICE_CONFIG);
      const ws = new WebSocket(`${WS_URL}?${params}`);
      
      try {
        // Wait for connection
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Connection timeout'));
          }, 5000);
          
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'connected') {
              clearTimeout(timeout);
              console.log(`✅ Connected to ${msg.device}`);
              resolve();
            } else if (msg.type === 'error') {
              clearTimeout(timeout);
              reject(new Error(msg.error));
            }
          });
          
          ws.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
        
        // Check pressure while connected
        reportPressure('🔵 While connected');
        
        // Brief activity
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Disconnect
        console.log('\n🔌 Disconnecting...');
        ws.close();
        
        // Wait for disconnect
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Check pressure after disconnect
        reportPressure('🟡 After disconnect');
        
      } catch (error: any) {
        console.log(`❌ Connection failed: ${error.message}`);
        ws.close();
        
        // Check pressure after error
        reportPressure('🔴 After error');
      }
      
      // Small delay between connections
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // Final pressure check
    reportPressure('\n\n🏁 Final state after all connections');
    
    console.log('\n\n✅ Pressure monitoring complete!');
    console.log('Review the pressure readings above to see how resources accumulate.');
  });
});