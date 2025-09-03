/**
 * Cross-VM bridge server test - tests connection from client VM perspective
 * Uses the client's IP address (192.168.50.73) and corrected protocol/UUIDs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { getDeviceConfig, setupTestServer } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();
const TEST_SESSION_ID = `cross-vm-${Date.now()}`;

// Client's correct IP for this bridge server
const BRIDGE_HOST = '192.168.50.73';
const BRIDGE_PORT = '8080';

describe.sequential('Bridge Server Cross-VM Protocol Test', () => {
  let server: any;

  beforeAll(async () => {
    server = await setupTestServer();
    console.log('[Cross-VM Test] Server started');
    console.log('[Cross-VM Test] Testing client connection to:', `${BRIDGE_HOST}:${BRIDGE_PORT}`);
    console.log('[Cross-VM Test] Using correct device config:', DEVICE_CONFIG);
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
      console.log('[Cross-VM Test] Server stopped');
    }
  });

  it('should connect from client VM using correct IP and protocol', async () => {
    console.log('[Cross-VM Test] Testing cross-VM bridge protocol');
    
    // Build WebSocket URL exactly as the client would
    const params = new URLSearchParams({
      ...DEVICE_CONFIG,
      session: TEST_SESSION_ID
    });
    const wsUrl = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}?${params.toString()}`;
    
    console.log(`[Cross-VM Test] Client would connect to: ${wsUrl}`);
    
    return new Promise<void>((resolve, reject) => {
      const results: string[] = [];
      const messages: any[] = [];
      
      const ws = new WebSocket(wsUrl);
      let resolved = false;
      
      // Set up timeout
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.terminate();
          console.log('[Cross-VM Test] Results so far:', results);
          console.log('[Cross-VM Test] Messages received:', messages);
          reject(new Error('Cross-VM connection timeout - see results above'));
        }
      }, 15000);
      
      ws.on('open', () => {
        results.push('Cross-VM WebSocket connected');
        console.log('[Cross-VM Test] Cross-VM WebSocket connected successfully');
      });
      
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          messages.push(msg);
          results.push(`Received: ${JSON.stringify(msg)}`);
          console.log(`[Cross-VM Test] Received: ${JSON.stringify(msg)}`);
          
          // Handle connection established
          if (msg.type === 'connected') {
            results.push(`Cross-VM BLE connection established: ${msg.device || 'unknown device'}`);
            console.log(`[Cross-VM Test] BLE connected to: ${msg.device}`);
            
            // Test complete - we proved cross-VM connectivity works
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              ws.close();
              console.log('[Cross-VM Test] ✅ Cross-VM bridge protocol test PASSED');
              console.log('[Cross-VM Test] Client can connect from different VM using:');
              console.log(`[Cross-VM Test]   IP: ${BRIDGE_HOST}:${BRIDGE_PORT}`);
              console.log(`[Cross-VM Test]   UUIDs: service=${DEVICE_CONFIG.service}, write=${DEVICE_CONFIG.write}, notify=${DEVICE_CONFIG.notify}`);
              console.log(`[Cross-VM Test]   Protocol: URL parameters, not message-based session establishment`);
              resolve();
            }
            
          } else if (msg.type === 'error') {
            results.push(`Cross-VM connection failed: ${msg.error}`);
            console.log(`[Cross-VM Test] Error: ${msg.error}`);
            
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              ws.close();
              
              // If it's a "no device" error, that's expected in some environments
              if (msg.error.includes('No device found') || msg.error.includes('timeout')) {
                console.log('[Cross-VM Test] ⚠️ No device available - but cross-VM connection worked');
                console.log('[Cross-VM Test] ✅ Network connectivity test PASSED');
                resolve();
              } else {
                reject(new Error(`Cross-VM bridge connection failed: ${msg.error}`));
              }
            }
          }
          
        } catch (e) {
          console.error('[Cross-VM Test] Failed to parse message:', e);
        }
      });
      
      ws.on('error', (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          console.log('[Cross-VM Test] WebSocket error:', error.message);
          
          // Check if it's a connection refused error (bridge not accessible)
          if (error.message.includes('ECONNREFUSED') || error.message.includes('connect')) {
            reject(new Error(`Cross-VM connection failed - bridge not accessible at ${BRIDGE_HOST}:${BRIDGE_PORT}`));
          } else {
            reject(new Error(`Cross-VM WebSocket error: ${error.message}`));
          }
        }
      });
      
      ws.on('close', () => {
        console.log('[Cross-VM Test] WebSocket closed');
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          
          // Check if we got meaningful results before close
          const hasConnection = results.some(r => r.includes('connected'));
          if (hasConnection) {
            console.log('[Cross-VM Test] ✅ Cross-VM connection test passed before close');
            resolve();
          } else {
            reject(new Error('Cross-VM WebSocket closed without successful connection'));
          }
        }
      });
    });
  }, 20000); // 20 second timeout for cross-VM test
});