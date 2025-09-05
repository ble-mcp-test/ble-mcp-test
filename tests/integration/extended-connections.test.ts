/**
 * Extended connections test - verify 20 sequential connections work reliably
 * This ensures the Noble zombie fix handles production workloads
 */

import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig, setupTestServer } from '../test-config.js';
import { connectionFactory } from '../connection-factory.js';
import { getBatteryVoltageCommand } from '../../src/cs108-commands.js';

const DEVICE_CONFIG = getDeviceConfig();
const NUM_CONNECTIONS = 20;
const TEST_SESSION_ID = `extended-connections-${Date.now()}`;

describe.sequential('Extended Connections Test', () => {
  it(`should successfully connect and get battery ${NUM_CONNECTIONS} times sequentially`, async () => {
    console.log(`[Extended Test] Starting ${NUM_CONNECTIONS} sequential connections test`);
    console.log(`[Extended Test] Target device: ${DEVICE_CONFIG.deviceName}`);
    
    const results: boolean[] = [];
    
    for (let i = 1; i <= NUM_CONNECTIONS; i++) {
      console.log(`\n[Extended Test] Connection ${i}/${NUM_CONNECTIONS}`);
      
      try {
        // Create WebSocket connection
        const ws = new WebSocket(`${WS_URL}/device/${encodeURIComponent(DEVICE_CONFIG.deviceName)}?sessionId=${TEST_SESSION_ID}-${i}`);
        
        // Wait for connection
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('WebSocket connection timeout'));
          }, 15000);
          
          ws.on('open', () => {
            clearTimeout(timeout);
            console.log(`  ✅ WebSocket connected for connection ${i}`);
            resolve();
          });
          
          ws.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
        
        // Send battery command and wait for response
        const batteryCmd = getBatteryVoltageCommand();
        const responsePromise = new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => {
            console.log(`  ⚠️ No response for connection ${i}`);
            resolve(false);
          }, 2000);
          
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'data' && msg.data) {
              clearTimeout(timeout);
              console.log(`  ✅ Battery response received for connection ${i}`);
              resolve(true);
            }
          });
        });
        
        // Send command
        ws.send(JSON.stringify({
          type: 'data',
          data: Array.from(batteryCmd)
        }));
        
        const success = await responsePromise;
        results.push(success);
        
        // Clean up connection
        ws.close();
        
        // Give hardware time to recover between connections
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(`  ❌ Connection ${i} failed:`, error);
        results.push(false);
      }
    }
    
    // Report results
    const successCount = results.filter(r => r).length;
    console.log(`\n[Extended Test] Final Results:`);
    console.log(`  Success: ${successCount}/${NUM_CONNECTIONS} connections`);
    console.log(`  Success rate: ${((successCount / NUM_CONNECTIONS) * 100).toFixed(1)}%`);
    
    // Pattern analysis
    const firstHalfSuccess = results.slice(0, 10).filter(r => r).length;
    const secondHalfSuccess = results.slice(10).filter(r => r).length;
    console.log(`  First half (1-10): ${firstHalfSuccess}/10 successful`);
    console.log(`  Second half (11-20): ${secondHalfSuccess}/10 successful`);
    
    // All connections MUST succeed with completeNobleReset fix
    expect(successCount).toBe(NUM_CONNECTIONS);
  }, 120000); // 2 minute timeout for 20 connections
});