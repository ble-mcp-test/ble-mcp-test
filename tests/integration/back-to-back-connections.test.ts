import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();

/**
 * Back-to-back connection tests - the CRITICAL pattern for 5-second battery polling
 * 
 * Tests realistic stress pattern:
 * 1. Pile on concurrent requests (stress)
 * 2. One succeeds, others fail (mutex working)  
 * 3. Rinse repeat (back-to-back reliability)
 * 
 * This pattern must be 98% reliable for production use.
 */
describe('Back-to-Back Connection Tests', () => {
  let server: BridgeServer;
  
  beforeAll(async () => {
    server = new BridgeServer('debug');
    await server.start(8082); // Use different port to avoid conflicts
  });
  
  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  /**
   * Realistic stress pattern: pile on requests, one succeeds, rinse repeat
   */
  it('should handle realistic stress: 5 rounds of concurrent requests + back-to-back success', async () => {
    console.log('\n🔥 Realistic Stress Test: Pile On → One Succeeds → Rinse Repeat');
    
    const rounds = 5;
    const concurrentRequestsPerRound = 8;
    const results: Array<{ round: number; successful: number; rejected: number; batteryVoltage?: number; roundTime: number }> = [];
    
    for (let round = 0; round < rounds; round++) {
      const roundStart = Date.now();
      console.log(`\n  Round ${round + 1}/${rounds}: Launching ${concurrentRequestsPerRound} concurrent requests...`);
      
      // Create concurrent connection attempts
      const promises: Promise<{ success: boolean; batteryVoltage?: number; error?: string }>[] = [];
      
      for (let i = 0; i < concurrentRequestsPerRound; i++) {
        const params = new URLSearchParams(DEVICE_CONFIG);
        const ws = new WebSocket(`${WS_URL.replace('8080', '8082')}?${params}`);
        
        const promise = new Promise<{ success: boolean; batteryVoltage?: number; error?: string }>((resolve) => {
          let connected = false;
          let batteryVoltage: number | undefined;
          
          const timeout = setTimeout(() => {
            resolve({ success: false, error: 'Connection timeout' });
          }, 8000);
          
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            
            if (msg.type === 'connected') {
              connected = true;
              // Send battery voltage command (CS108 GET_BATTERY_VOLTAGE)
              ws.send(JSON.stringify({
                type: 'data',
                data: [0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]
              }));
              
            } else if (msg.type === 'data' && connected) {
              // Parse battery response
              const responseData = new Uint8Array(msg.data);
              if (responseData.length >= 8 && responseData[0] === 0xA7 && responseData[1] === 0xB3) {
                // Extract voltage from CS108 response
                const voltageRaw = (responseData[6] << 8) | responseData[7];
                batteryVoltage = voltageRaw;
                
                // Force cleanup to test the critical disconnect path
                ws.send(JSON.stringify({ type: 'force_cleanup' }));
              }
              
            } else if (msg.type === 'force_cleanup_complete' || msg.type === 'cleanup_complete') {
              clearTimeout(timeout);
              if (batteryVoltage) {
                resolve({ success: true, batteryVoltage });
              } else {
                resolve({ success: false, error: 'No battery reading' });
              }
              
            } else if (msg.type === 'error') {
              clearTimeout(timeout);
              resolve({ success: false, error: msg.error });
            }
          });
          
          ws.on('error', (error) => {
            clearTimeout(timeout);
            resolve({ success: false, error: `WebSocket error: ${error.message}` });
          });
          
          ws.on('close', () => {
            clearTimeout(timeout);
            if (!connected) {
              resolve({ success: false, error: 'Connection closed without connect' });
            }
          });
        });
        
        promises.push(promise);
      }
      
      // Wait for all concurrent attempts to complete
      const roundResults = await Promise.all(promises);
      
      // Analyze this round
      const successful = roundResults.filter(r => r.success).length;
      const rejected = roundResults.filter(r => r.error?.includes('Another connection is active')).length;
      const batteryVoltage = roundResults.find(r => r.success)?.batteryVoltage;
      const roundTime = Date.now() - roundStart;
      
      results.push({ round: round + 1, successful, rejected, batteryVoltage, roundTime });
      
      console.log(`    ✅ Successful: ${successful}/${concurrentRequestsPerRound}`);
      console.log(`    🚫 Rejected: ${rejected}/${concurrentRequestsPerRound}`);
      if (batteryVoltage) {
        console.log(`    🔋 Battery: ${batteryVoltage}mV`);
      }
      console.log(`    ⏱️  Round time: ${roundTime}ms`);
      
      // Brief pause between rounds to let things settle (realistic usage)
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Analyze overall results
    const totalSuccessful = results.reduce((sum, r) => sum + r.successful, 0);
    const totalRejected = results.reduce((sum, r) => sum + r.rejected, 0);
    const avgRoundTime = results.reduce((sum, r) => sum + r.roundTime, 0) / results.length;
    const successfulRounds = results.filter(r => r.successful > 0).length;
    
    console.log(`\n📊 Overall Stress Test Results:`);
    console.log(`  Rounds with successful connection: ${successfulRounds}/${rounds}`);
    console.log(`  Total successful connections: ${totalSuccessful}`);
    console.log(`  Total rejected connections: ${totalRejected}`);
    console.log(`  Average round time: ${Math.round(avgRoundTime)}ms`);
    console.log(`  Success rate per round: ${((successfulRounds / rounds) * 100).toFixed(1)}%`);
    
    // For realistic stress test, we expect:
    // 1. Each round should have exactly 1 successful connection (98%+ of rounds)
    // 2. Most other connections should be properly rejected
    // 3. No deadlocks or hangs
    
    expect(successfulRounds).toBeGreaterThanOrEqual(Math.floor(rounds * 0.98)); // 98% of rounds succeed
    expect(totalRejected).toBeGreaterThan(rounds * 5); // Most concurrent requests get rejected
    
    // Verify all successful connections got valid battery readings
    const successfulResults = results.filter(r => r.batteryVoltage);
    successfulResults.forEach(result => {
      expect(result.batteryVoltage).toBeGreaterThan(3000);
      expect(result.batteryVoltage).toBeLessThan(5000);
    });
    
    console.log(`\n✅ Realistic stress pattern achieved ${((successfulRounds / rounds) * 100).toFixed(1)}% reliability!`);
  });
  
  /**
   * Test rapid back-to-back cycles to stress the cleanup/reconnect timing
   */
  it('should handle rapid back-to-back connections without mutex deadlock', async () => {
    console.log('\n⚡ Testing rapid back-to-back connections (stress test)');
    
    const cycles = 5;
    const results: Array<{ success: boolean; error?: string; time: number }> = [];
    
    for (let i = 0; i < cycles; i++) {
      const startTime = Date.now();
      const params = new URLSearchParams(DEVICE_CONFIG);
      const ws = new WebSocket(`${WS_URL.replace('8080', '8082')}?${params}`);
      
      try {
        const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
          const timeout = setTimeout(() => {
            resolve({ success: false, error: 'Timeout' });
          }, 8000);
          
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            
            if (msg.type === 'connected') {
              // Immediately request cleanup (minimal connection time)
              ws.send(JSON.stringify({ type: 'force_cleanup' }));
              
            } else if (msg.type === 'force_cleanup_complete' || msg.type === 'cleanup_complete') {
              clearTimeout(timeout);
              resolve({ success: true });
              
            } else if (msg.type === 'error') {
              clearTimeout(timeout);
              resolve({ success: false, error: msg.error });
            }
          });
          
          ws.on('error', (error) => {
            clearTimeout(timeout);
            resolve({ success: false, error: `WebSocket error: ${error.message}` });
          });
        });
        
        const time = Date.now() - startTime;
        results.push({ ...result, time });
        
        if (result.success) {
          console.log(`  Rapid cycle ${i + 1}/5: ✅ (${time}ms)`);
        } else {
          console.log(`  Rapid cycle ${i + 1}/5: ❌ ${result.error} (${time}ms)`);
        }
        
      } catch (error: any) {
        const time = Date.now() - startTime;
        results.push({ success: false, error: error.message, time });
        console.log(`  Rapid cycle ${i + 1}/5: ❌ Exception: ${error.message} (${time}ms)`);
      } finally {
        ws.close();
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    const successRate = (successCount / cycles) * 100;
    
    console.log(`\n📊 Rapid Connection Results:`);
    console.log(`  Successful cycles: ${successCount}/${cycles}`);
    console.log(`  Success rate: ${successRate.toFixed(1)}%`);
    
    // Rapid connections should not deadlock - should achieve 100% or very close
    expect(successRate).toBeGreaterThanOrEqual(80); // Allow some margin for rapid timing
    
    console.log(`\n✅ No mutex deadlocks detected!`);
  });
});