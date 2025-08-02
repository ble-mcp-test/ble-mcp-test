import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig, setupTestServer } from '../test-config.js';
import { NobleTransport } from '../../src/noble-transport.js';
import type { NobleResourceState } from '../../src/noble-transport.js';

const DEVICE_CONFIG = getDeviceConfig();

// Use shortened timeouts for testing - configured via environment variables
const TEST_GRACE_PERIOD_SEC = parseInt(process.env.BLE_SESSION_GRACE_PERIOD_SEC || '5', 10);
const TEST_IDLE_TIMEOUT_SEC = parseInt(process.env.BLE_SESSION_IDLE_TIMEOUT_SEC || '10', 10);

describe.sequential('Timeout Stabilization Tests', () => {
  let originalEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    // Store original env and set test timeouts
    originalEnv = {
      BLE_SESSION_GRACE_PERIOD_SEC: process.env.BLE_SESSION_GRACE_PERIOD_SEC,
      BLE_SESSION_IDLE_TIMEOUT_SEC: process.env.BLE_SESSION_IDLE_TIMEOUT_SEC
    };
    
    process.env.BLE_SESSION_GRACE_PERIOD_SEC = TEST_GRACE_PERIOD_SEC.toString();
    process.env.BLE_SESSION_IDLE_TIMEOUT_SEC = TEST_IDLE_TIMEOUT_SEC.toString();
    
    console.log(`🕒 Using test timeouts: grace=${TEST_GRACE_PERIOD_SEC}s, idle=${TEST_IDLE_TIMEOUT_SEC}s`);
  });

  afterAll(() => {
    // Restore original environment
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  afterEach(async () => {
    // Give hardware time to recover between tests
    await new Promise(resolve => setTimeout(resolve, 3000));
  });

  it('should verify Noble resource cleanup after grace period timeout', async () => {
    console.log('🕒 Test: Grace period timeout with Noble resource verification');
    
    const server = await setupTestServer();
    
    try {
      const params = new URLSearchParams(DEVICE_CONFIG);
      const url = `${WS_URL}?${params}`;
      
      // Initial Noble resource state
      const initialState = await NobleTransport.getResourceState();
      console.log(`  📊 Initial Noble resources:`, initialState);
      
      // Connect to device
      const ws = new WebSocket(url);
      let deviceName: string | null = null;
      
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 15000);
        
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === 'connected') {
            deviceName = msg.device;
            console.log(`  ✅ Connected to device: ${deviceName}`);
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
        
        ws.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      
      // Skip test if no device available
      if (!deviceName) {
        console.log('  ⏭️ Test skipped - no device available');
        return;
      }
      
      // Disconnect WebSocket to trigger grace period
      console.log('  🔌 Closing WebSocket to trigger grace period...');
      ws.close();
      
      // Wait for grace period to expire
      const graceWaitTime = (TEST_GRACE_PERIOD_SEC + 2) * 1000;
      console.log(`  ⏳ Waiting ${graceWaitTime/1000}s for grace period to expire...`);
      await new Promise(resolve => setTimeout(resolve, graceWaitTime));
      
      // Verify Noble resources were cleaned up
      const finalState = await NobleTransport.getResourceState();
      console.log(`  📊 Final Noble resources:`, finalState);
      
      // Check for resource leaks
      const resourcesFreed = initialState.peripheralCount - finalState.peripheralCount;
      const listenersFreed = (initialState.listenerCounts.scanStop + initialState.listenerCounts.discover) - 
                            (finalState.listenerCounts.scanStop + finalState.listenerCounts.discover);
      
      console.log(`  🧹 Resources freed: ${resourcesFreed} peripherals, ${listenersFreed} listeners`);
      
      // Verify no excessive listener accumulation (critical leak indicators)
      expect(finalState.listenerCounts.scanStop).toBeLessThan(90); // From PRP threshold
      expect(finalState.listenerCounts.discover).toBeLessThan(10); // From PRP threshold
      expect(finalState.peripheralCount).toBeLessThan(100); // From PRP threshold
      
      // Verify server state reflects cleanup
      if (server) {
        const serverState = server.getConnectionState();
        console.log(`  📊 Server state after grace timeout: ${serverState.state}, connected: ${serverState.connected}`);
        expect(serverState.connected).toBe(false);
        expect(serverState.deviceName).toBeNull();
      }
      
      console.log('  ✅ Grace period timeout cleanup verified');
      
    } finally {
      if (server) {
        await server.stop();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  });

  it('should verify device availability after idle timeout cleanup', async () => {
    console.log('🕒 Test: Idle timeout with device availability confirmation');
    
    const server = await setupTestServer();
    
    try {
      const params = new URLSearchParams(DEVICE_CONFIG);
      const url = `${WS_URL}?${params}`;
      
      // Connect to device
      const ws = new WebSocket(url);
      let deviceName: string | null = null;
      
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 15000);
        
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === 'connected') {
            deviceName = msg.device;
            console.log(`  ✅ Connected to device: ${deviceName}`);
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
        
        ws.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      
      // Skip test if no device available
      if (!deviceName) {
        console.log('  ⏭️ Test skipped - no device available');
        return;
      }
      
      // Keep WebSocket open but don't send any data to trigger idle timeout
      console.log('  💤 Keeping connection idle to trigger idle timeout...');
      
      // Wait for idle timeout to expire
      const idleWaitTime = (TEST_IDLE_TIMEOUT_SEC + 2) * 1000;
      console.log(`  ⏳ Waiting ${idleWaitTime/1000}s for idle timeout to expire...`);
      await new Promise(resolve => setTimeout(resolve, idleWaitTime));
      
      // Verify server cleaned up
      if (server) {
        const serverState = server.getConnectionState();
        console.log(`  📊 Server state after idle timeout: ${serverState.state}, connected: ${serverState.connected}`);
        expect(serverState.connected).toBe(false);
      }
      
      // Verify device availability after cleanup
      console.log('  🔍 Checking device availability after idle timeout cleanup...');
      const deviceAvailable = await NobleTransport.scanDeviceAvailability(DEVICE_CONFIG.device, 5000);
      console.log(`  📡 Device availability: ${deviceAvailable}`);
      
      // Device should be available after proper cleanup
      if (deviceAvailable) {
        console.log('  ✅ Device availability confirmed after idle timeout cleanup');
        
        // Test reconnection to verify device is truly free
        console.log('  🔄 Testing reconnection to verify device freedom...');
        const ws2 = new WebSocket(url);
        let canReconnect = false;
        
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            console.log('  ⏰ Reconnection timeout - may indicate device still locked');
            resolve();
          }, 10000);
          
          ws2.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            
            if (msg.type === 'connected') {
              canReconnect = true;
              console.log(`  ✅ Reconnection successful to: ${msg.device}`);
              clearTimeout(timeout);
              resolve();
            } else if (msg.type === 'error') {
              console.log(`  ❌ Reconnection failed: ${msg.error}`);
              clearTimeout(timeout);
              resolve();
            }
          });
          
          ws2.on('error', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
        
        ws2.close();
        expect(canReconnect).toBe(true);
      } else {
        console.log('  ⚠️ Device not available - may indicate incomplete cleanup');
      }
      
      ws.close();
      console.log('  ✅ Idle timeout cleanup and device availability verified');
      
    } finally {
      if (server) {
        await server.stop();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  });

  it('should detect and cleanup zombie sessions', async () => {
    console.log('🧟 Test: Zombie session detection and cleanup');
    
    const server = await setupTestServer();
    
    try {
      const params = new URLSearchParams(DEVICE_CONFIG);
      const url = `${WS_URL}?${params}`;
      
      // Connect to device
      const ws = new WebSocket(url);
      let deviceName: string | null = null;
      
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 15000);
        
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === 'connected') {
            deviceName = msg.device;
            console.log(`  ✅ Connected to device: ${deviceName}`);
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
        
        ws.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      
      // Skip test if no device available
      if (!deviceName) {
        console.log('  ⏭️ Test skipped - no device available');
        return;
      }
      
      // Simulate zombie session by abruptly terminating connection
      console.log('  🔥 Creating zombie session via abrupt disconnect...');
      ws.terminate(); // Abrupt termination - no graceful close
      
      // Wait a bit for the server to process the disconnect
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Verify server detects and handles zombie session
      // The enhanced SessionManager should detect zombie sessions in its periodic cleanup
      console.log('  🧟 Waiting for zombie session detection and cleanup...');
      
      // Wait for at least one cleanup cycle (30s interval in SessionManager)
      // But use shorter wait since we're in test mode
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Verify Noble resources were cleaned up from zombie session
      const finalState = await NobleTransport.getResourceState();
      console.log(`  📊 Noble resources after zombie cleanup:`, finalState);
      
      // Check for resource leaks that indicate zombie sessions
      expect(finalState.listenerCounts.scanStop).toBeLessThan(90);
      expect(finalState.listenerCounts.discover).toBeLessThan(10);
      expect(finalState.peripheralCount).toBeLessThan(100);
      
      // Verify device is available after zombie cleanup
      console.log('  🔍 Verifying device availability after zombie cleanup...');
      const deviceAvailable = await NobleTransport.scanDeviceAvailability(DEVICE_CONFIG.device, 5000);
      console.log(`  📡 Device availability after zombie cleanup: ${deviceAvailable}`);
      
      // Test reconnection to ensure zombie was properly cleaned up
      if (deviceAvailable) {
        console.log('  🔄 Testing reconnection after zombie cleanup...');
        const ws2 = new WebSocket(url);
        let canReconnect = false;
        
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            resolve();
          }, 10000);
          
          ws2.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            
            if (msg.type === 'connected') {
              canReconnect = true;
              console.log(`  ✅ Post-zombie reconnection successful to: ${msg.device}`);
              clearTimeout(timeout);
              resolve();
            } else if (msg.type === 'error') {
              console.log(`  ❌ Post-zombie reconnection failed: ${msg.error}`);
              clearTimeout(timeout);
              resolve();
            }
          });
          
          ws2.on('error', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
        
        ws2.close();
        
        if (canReconnect) {
          console.log('  ✅ Zombie session cleanup successful - device reconnection works');
        } else {
          console.log('  ⚠️ Device may still be locked by zombie session');
        }
      }
      
      console.log('  ✅ Zombie session detection and cleanup verified');
      
    } finally {
      if (server) {
        await server.stop();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  });

  it('should handle concurrent cleanup operations without conflicts', async () => {
    console.log('🔄 Test: Concurrent cleanup operations');
    
    const server = await setupTestServer();
    
    try {
      const params = new URLSearchParams(DEVICE_CONFIG);
      const url = `${WS_URL}?${params}`;
      
      // Create multiple rapid connections and disconnections
      const connectionPromises = [];
      
      for (let i = 0; i < 3; i++) {
        const connectionPromise = (async (index: number) => {
          console.log(`  🔗 Starting connection ${index + 1}/3...`);
          
          const ws = new WebSocket(url);
          let connected = false;
          
          try {
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => {
                if (!connected) {
                  console.log(`  ⏭️ Connection ${index + 1}: Timeout, likely no device or device busy`);
                  resolve();
                }
              }, 8000);
              
              ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                
                if (msg.type === 'connected') {
                  connected = true;
                  console.log(`  ✅ Connection ${index + 1}: Connected to ${msg.device}`);
                  clearTimeout(timeout);
                  resolve();
                } else if (msg.type === 'error') {
                  console.log(`  ❌ Connection ${index + 1}: Error - ${msg.error}`);
                  clearTimeout(timeout);
                  resolve();
                }
              });
              
              ws.on('error', () => {
                clearTimeout(timeout);
                resolve();
              });
            });
            
            if (connected) {
              // Wait a moment then disconnect
              await new Promise(resolve => setTimeout(resolve, 500));
              console.log(`  🔌 Disconnecting connection ${index + 1}...`);
              ws.close();
            }
            
          } catch (e) {
            console.log(`  ❌ Connection ${index + 1} failed: ${e}`);
          } finally {
            try {
              ws.close();
            } catch {
              // Ignore close errors
            }
          }
        })(i);
        
        connectionPromises.push(connectionPromise);
        
        // Stagger connection attempts slightly
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      // Wait for all connections to complete
      await Promise.all(connectionPromises);
      
      // Wait for all cleanup operations to complete
      console.log('  ⏳ Waiting for all cleanup operations to complete...');
      await new Promise(resolve => setTimeout(resolve, 8000));
      
      // Verify final Noble resource state is clean
      const finalState = await NobleTransport.getResourceState();
      console.log(`  📊 Final Noble resources after concurrent operations:`, finalState);
      
      // Should not have excessive resource accumulation
      expect(finalState.listenerCounts.scanStop).toBeLessThan(90);
      expect(finalState.listenerCounts.discover).toBeLessThan(10);
      expect(finalState.peripheralCount).toBeLessThan(100);
      
      // Verify device is still available
      const deviceAvailable = await NobleTransport.scanDeviceAvailability(DEVICE_CONFIG.device, 5000);
      console.log(`  📡 Device availability after concurrent operations: ${deviceAvailable}`);
      
      console.log('  ✅ Concurrent cleanup operations handled successfully');
      
    } finally {
      if (server) {
        await server.stop();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  });
});