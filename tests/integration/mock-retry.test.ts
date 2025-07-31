import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import { SharedState } from '../../src/shared-state.js';
import { MockBluetooth, injectWebBluetoothMock, updateMockConfig } from '../../src/mock-bluetooth.js';
import { WS_URL, getDeviceConfig } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();

/**
 * Test the mock's retry behavior when bridge is busy
 */
describe('Mock Retry Behavior', () => {
  let server: BridgeServer;
  let port = 8086;
  
  beforeAll(async () => {
    // Start server with debug logging to see retry messages
    const sharedState = new SharedState(true);
    server = new BridgeServer('debug', sharedState);
    await server.start(port);
  });
  
  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  afterEach(async () => {
    // Ensure clean state between tests
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  it('should retry when bridge is in disconnecting state', async () => {
    console.log('\n🔄 Testing mock retry behavior during bridge recovery period\n');
    
    // Configure mock for testing
    updateMockConfig({
      logRetries: true,
      connectRetryDelay: 200, // Faster for testing
      maxConnectRetries: 10, // Enough retries for 1s recovery
      postDisconnectDelay: 0 // No delay so we hit recovery period
    });
    
    // First, establish a connection to put device in use
    const mock1 = new MockBluetooth(`ws://localhost:${port}`, DEVICE_CONFIG);
    const device1 = await mock1.requestDevice({ 
      filters: [{ namePrefix: DEVICE_CONFIG.device }] 
    });
    
    console.log('  1️⃣ Connecting first device...');
    await device1.gatt.connect();
    console.log('  ✅ First device connected');
    
    // Disconnect to trigger recovery period
    console.log('\n  2️⃣ Disconnecting to trigger recovery period...');
    await device1.gatt.disconnect();
    console.log('  🕒 Bridge entering 1-second recovery period');
    
    // Immediately try to connect second device - should retry
    const mock2 = new MockBluetooth(`ws://localhost:${port}`, DEVICE_CONFIG);
    const device2 = await mock2.requestDevice({ 
      filters: [{ namePrefix: DEVICE_CONFIG.device }] 
    });
    
    console.log('\n  3️⃣ Attempting second connection (should retry)...');
    const startTime = Date.now();
    
    // Capture console output to verify retry messages
    const originalLog = console.log;
    const logMessages: string[] = [];
    console.log = (message: string) => {
      logMessages.push(message);
      originalLog(message);
    };
    
    try {
      await device2.gatt.connect();
      const elapsed = Date.now() - startTime;
      
      console.log(`\n  ✅ Second device connected after ${elapsed}ms`);
      
      // Should have taken some time due to retries
      expect(elapsed).toBeGreaterThan(500); // At least some retry delay
      
      // Should see retry messages
      const retryMessages = logMessages.filter(msg => 
        msg.includes('[Mock] Bridge busy') || 
        msg.includes('[Mock] Connected successfully after')
      );
      
      console.log(`\n  📊 Retry statistics:`);
      console.log(`     Total retries: ${retryMessages.length}`);
      console.log(`     Time to connect: ${elapsed}ms`);
      
      expect(retryMessages.length).toBeGreaterThan(0);
      
      // Clean up
      await device2.gatt.disconnect();
      
    } finally {
      // Restore console.log
      console.log = originalLog;
    }
  }, 30000);

  it('should respect max retries configuration', async () => {
    console.log('\n⛔ Testing max retries limit\n');
    
    // Configure for quick failure
    updateMockConfig({
      connectRetryDelay: 100,
      maxConnectRetries: 2, // Only 2 retries
      postDisconnectDelay: 0 // No delay for testing
    });
    
    // Connect and disconnect to trigger recovery
    const mock1 = new MockBluetooth(`ws://localhost:${port}`, DEVICE_CONFIG);
    const device1 = await mock1.requestDevice({ 
      filters: [{ namePrefix: DEVICE_CONFIG.device }] 
    });
    
    await device1.gatt.connect();
    await device1.gatt.disconnect();
    
    // Try to connect during recovery - should fail after 2 retries
    const mock2 = new MockBluetooth(`ws://localhost:${port}`, DEVICE_CONFIG);
    const device2 = await mock2.requestDevice({ 
      filters: [{ namePrefix: DEVICE_CONFIG.device }] 
    });
    
    const startTime = Date.now();
    
    try {
      await device2.gatt.connect();
      // Should not reach here
      expect.fail('Should have failed after max retries');
    } catch (error: any) {
      const elapsed = Date.now() - startTime;
      console.log(`  ❌ Failed after ${elapsed}ms as expected`);
      console.log(`  Error: ${error.message}`);
      
      // Should fail relatively quickly with only 2 retries
      expect(elapsed).toBeLessThan(1000); // 2 retries * 100ms + some overhead
      expect(error.message).toContain('Bridge is disconnecting');
    }
  });
});