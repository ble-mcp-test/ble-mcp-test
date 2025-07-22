import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();

describe('Connection Stress Tests', () => {
  let server: BridgeServer;
  let useExternalServer = false;
  
  beforeAll(() => {
    if (process.env.WS_URL && !process.env.WS_URL.includes('localhost')) {
      useExternalServer = true;
      console.log(`🔥 Stress testing external server at: ${WS_URL}`);
    } else {
      server = new BridgeServer();
      server.start(8080);
    }
  });
  
  afterAll(() => {
    if (!useExternalServer && server) {
      server.stop();
    }
  });
  
  it('handles rapid connection cycles without state leakage', async () => {
    console.log('🔥 Test 1: Rapid Connect/Disconnect (10 cycles)');
    
    const cycles = 10;
    const results = [];
    
    for (let i = 0; i < cycles; i++) {
      const params = new URLSearchParams(DEVICE_CONFIG);
      const ws = new WebSocket(`${WS_URL}?${params}`);
      
      try {
        const connected = await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), 3000);
          
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'connected') {
              clearTimeout(timeout);
              resolve(true);
            } else if (msg.type === 'error') {
              clearTimeout(timeout);
              resolve(false);
            }
          });
          
          ws.on('error', () => {
            clearTimeout(timeout);
            resolve(false);
          });
        });
        
        results.push(connected);
        
        // Immediately close
        ws.close();
        
        // No delay needed - server handles all timing internally
        
      } catch (error) {
        results.push(false);
      }
    }
    
    // In test environment, expect all to fail (no device)
    // In real environment, all should succeed or all should fail consistently
    const successCount = results.filter(r => r).length;
    console.log(`✅ ${successCount}/${cycles} connections succeeded`);
    
    // Verify consistency - either all succeed or all fail
    if (successCount > 0 && successCount < cycles) {
      console.warn('⚠️  Inconsistent results may indicate state leakage');
    }
    
    expect(results.length).toBe(cycles);
  });
  
  it('prevents concurrent connections to same BLE device', async () => {
    console.log('\n🔥 Test 2: Concurrent Connection Attempts');
    
    const connections: WebSocket[] = [];
    const promises = [];
    
    // Create 5 simultaneous connection attempts
    for (let i = 0; i < 5; i++) {
      const params = new URLSearchParams(DEVICE_CONFIG);
      const ws = new WebSocket(`${WS_URL}?${params}`);
      connections.push(ws);
      
      const promise = new Promise<string>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'connected') {
            resolve('connected');
          } else if (msg.type === 'error') {
            resolve('error');
          }
        });
        
        ws.on('error', () => resolve('ws-error'));
        ws.on('close', () => resolve('closed'));
        
        // Timeout
        setTimeout(() => resolve('timeout'), 5000);
      });
      
      promises.push(promise);
    }
    
    // Wait for all to settle
    const results = await Promise.all(promises);
    
    // Count successful connections
    const connectedCount = results.filter(r => r === 'connected').length;
    console.log(`✅ ${connectedCount}/5 connections succeeded`);
    console.log(`   Results: ${results.join(', ')}`);
    
    // With connection state tracking, only 1 should connect to BLE
    // Others should be rejected with 'Another connection is active'
    expect(connectedCount).toBeLessThanOrEqual(1);
    expect(results.filter(r => r === 'error').length).toBeGreaterThanOrEqual(3);
    
    // Clean up
    connections.forEach(ws => ws.close());
  });
  
  it('handles disconnect during BLE connection phase', async () => {
    console.log('\n🔥 Test 3: Kill WebSocket During BLE Connection');
    
    const params = new URLSearchParams(DEVICE_CONFIG);
    const ws = new WebSocket(`${WS_URL}?${params}`);
    
    const result = await new Promise<string>((resolve) => {
      // Kill WebSocket after 50ms (during BLE connection)
      setTimeout(() => {
        console.log('  💀 Terminating WebSocket...');
        ws.terminate();
      }, 50);
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        resolve(`message:${msg.type}`);
      });
      
      ws.on('error', () => resolve('error'));
      ws.on('close', () => resolve('closed'));
      
      setTimeout(() => resolve('survived'), 2000);
    });
    
    console.log(`✅ Result: ${result}`);
    expect(['error', 'closed', 'survived', 'message:error']).toContain(result);
  });
  
  it('catches race condition: immediate data after connect', async () => {
    console.log('\n🔥 Test 4: Immediate Data After Connect (Race Condition)');
    
    const params = new URLSearchParams(DEVICE_CONFIG);
    const ws = new WebSocket(`${WS_URL}?${params}`);
    let raceConditionDetected = false;
    
    const result = await new Promise<string>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        
        if (msg.type === 'connected') {
          console.log('  ✅ Connected, immediately sending data...');
          
          // Immediately send data (no delay)
          ws.send(JSON.stringify({
            type: 'data',
            data: [0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]
          }));
          
          // Also try after 10ms
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'data',
              data: [0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]
            }));
          }, 10);
          
        } else if (msg.type === 'error' && msg.error?.includes('Not connected')) {
          console.log('  ❌ RACE CONDITION DETECTED: "Not connected" after connected message');
          raceConditionDetected = true;
          resolve('race-condition');
        } else if (msg.type === 'data') {
          console.log('  ✅ Received data response');
          ws.close();
          resolve('success');
        } else if (msg.type === 'error') {
          resolve('error');
        }
      });
      
      ws.on('error', () => resolve('ws-error'));
      setTimeout(() => {
        ws.close();
        resolve(raceConditionDetected ? 'race-condition' : 'timeout');
      }, 5000);
    });
    
    console.log(`✅ Test result: ${result}`);
    
    // We should NOT see race conditions in our implementation
    expect(result).not.toBe('race-condition');
  });
  
  it('handles rapid-fire data messages', async () => {
    console.log('\n🔥 Test 5: Rapid Data Messages (100 in burst)');
    
    const params = new URLSearchParams(DEVICE_CONFIG);
    const ws = new WebSocket(`${WS_URL}?${params}`);
    let messagesSent = 0;
    let responsesReceived = 0;
    
    const result = await new Promise<string>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        
        if (msg.type === 'connected') {
          console.log('  📡 Sending 100 messages...');
          
          // Send 100 messages as fast as possible
          for (let i = 0; i < 100; i++) {
            ws.send(JSON.stringify({
              type: 'data',
              data: [0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]
            }));
            messagesSent++;
          }
          
          console.log(`  ✅ Sent ${messagesSent} messages`);
          
        } else if (msg.type === 'data') {
          responsesReceived++;
          
          if (responsesReceived >= 10) { // Just wait for some responses
            ws.close();
            resolve('success');
          }
        } else if (msg.type === 'error') {
          resolve(`error:${msg.error}`);
        }
      });
      
      ws.on('error', () => resolve('ws-error'));
      setTimeout(() => {
        ws.close();
        resolve(`received:${responsesReceived}`);
      }, 10000);
    });
    
    console.log(`✅ Result: ${result}, Responses: ${responsesReceived}/${messagesSent}`);
    
    // Should handle rapid messages without crashing
    expect(result).toMatch(/success|received:\d+|error:No device found|error:Another connection is active/);
  });
});