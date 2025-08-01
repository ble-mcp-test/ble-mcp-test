import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/bridge-server.js';
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';

describe('Deterministic Session ID Integration Tests', () => {
  let server: BridgeServer;
  let serverUrl: string;
  
  beforeAll(async () => {
    // Start the bridge server
    server = new BridgeServer();
    const port = await server.start(0); // Random port
    serverUrl = `ws://localhost:${port}`;
  });
  
  afterAll(async () => {
    await server.stop();
  });
  
  describe('Node.js Environment', () => {
    it('should use environment variable for session ID', async () => {
      // Set environment variable
      process.env.BLE_TEST_SESSION_ID = 'node-env-test-session';
      
      try {
        // Connect with session from environment
        const ws = new WebSocket(`${serverUrl}?session=${process.env.BLE_TEST_SESSION_ID}`);
        
        await new Promise<void>((resolve, reject) => {
          ws.on('open', () => {
            ws.on('message', (data) => {
              const msg = JSON.parse(data.toString());
              if (msg.type === 'connected') {
                resolve();
              } else if (msg.type === 'error') {
                reject(new Error(msg.error));
              }
            });
          });
          ws.on('error', reject);
        });
        
        // Verify connection succeeded
        expect(ws.readyState).toBe(WebSocket.OPEN);
        
        // Close connection
        ws.close();
        await new Promise(resolve => ws.on('close', resolve));
      } finally {
        delete process.env.BLE_TEST_SESSION_ID;
      }
    });
    
    it('should allow multiple connections with same deterministic session', async () => {
      const sessionId = 'integration-test-session';
      
      // First connection
      const ws1 = new WebSocket(`${serverUrl}?session=${sessionId}`);
      await new Promise<void>((resolve, reject) => {
        ws1.on('open', () => {
          ws1.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'connected') resolve();
            else if (msg.type === 'error') reject(new Error(msg.error));
          });
        });
        ws1.on('error', reject);
      });
      
      // Close first connection
      ws1.close();
      await new Promise(resolve => ws1.on('close', resolve));
      
      // Wait for server to process disconnection
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Second connection with same session ID should succeed
      const ws2 = new WebSocket(`${serverUrl}?session=${sessionId}`);
      await new Promise<void>((resolve, reject) => {
        ws2.on('open', () => {
          ws2.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'connected') resolve();
            else if (msg.type === 'error') reject(new Error(msg.error));
          });
        });
        ws2.on('error', reject);
      });
      
      expect(ws2.readyState).toBe(WebSocket.OPEN);
      
      // Cleanup
      ws2.close();
      await new Promise(resolve => ws2.on('close', resolve));
    });
  });
  
  describe('Browser Environment Simulation', () => {
    it('should generate deterministic ID in simulated Playwright environment', async () => {
      // Create JSDOM with Playwright user agent
      const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'http://localhost',
        pretendToBeVisual: true,
        resources: 'usable',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 Playwright/1.0'
      });
      
      const window = dom.window;
      
      // Set up globals
      (global as any).window = window;
      (global as any).navigator = window.navigator;
      (global as any).location = window.location;
      (global as any).WebSocket = WebSocket;
      
      // Set Playwright environment
      process.env.PLAYWRIGHT_TEST_BASE_URL = 'http://localhost:3000';
      
      try {
        // Import mock bluetooth in this environment
        const { MockBluetooth } = await import('../../src/mock-bluetooth.js');
        
        const mock = new MockBluetooth(serverUrl);
        const device = await mock.requestDevice();
        
        // Should generate deterministic session ID
        expect(device.sessionId).toMatch(/^localhost-/);
        expect(device.sessionId).not.toMatch(/-[A-Z0-9]{4}$/); // No random suffix
        
        // Connect to verify it works
        await device.gatt.connect();
        expect(device.gatt.connected).toBe(true);
        
        // Disconnect
        await device.gatt.disconnect();
      } finally {
        // Clean up
        delete (global as any).window;
        delete (global as any).navigator;
        delete (global as any).location;
        delete (global as any).WebSocket;
        delete process.env.PLAYWRIGHT_TEST_BASE_URL;
        dom.window.close();
      }
    });
    
    it('should allow explicit session ID override', async () => {
      const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'http://localhost',
        pretendToBeVisual: true,
        resources: 'usable'
      });
      
      const window = dom.window;
      
      // Set up globals
      (global as any).window = window;
      (global as any).navigator = window.navigator;
      (global as any).location = window.location;
      (global as any).WebSocket = WebSocket;
      
      // Set explicit test session ID
      window.BLE_TEST_SESSION_ID = 'explicit-integration-test';
      
      try {
        // Import mock bluetooth in this environment
        const { MockBluetooth } = await import('../../src/mock-bluetooth.js');
        
        const mock = new MockBluetooth(serverUrl);
        const device = await mock.requestDevice();
        
        // Should use explicit session ID
        expect(device.sessionId).toBe('explicit-integration-test');
        
        // Connect to verify it works
        await device.gatt.connect();
        expect(device.gatt.connected).toBe(true);
        
        // Disconnect
        await device.gatt.disconnect();
      } finally {
        // Clean up
        delete (global as any).window;
        delete (global as any).navigator;
        delete (global as any).location;
        delete (global as any).WebSocket;
        dom.window.close();
      }
    });
  });
  
  describe('Session Conflict Resolution', () => {
    it('should handle different sessions for different tests', async () => {
      // Simulate two different test files
      const session1 = 'localhost-tests/integration/test1';
      const session2 = 'localhost-tests/integration/test2';
      
      // Connect with first session
      const ws1 = new WebSocket(`${serverUrl}?session=${session1}`);
      await new Promise<void>((resolve, reject) => {
        ws1.on('open', () => {
          ws1.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'connected') resolve();
            else if (msg.type === 'error') reject(new Error(msg.error));
          });
        });
        ws1.on('error', reject);
      });
      
      // Try to connect with second session while first is active
      const ws2 = new WebSocket(`${serverUrl}?session=${session2}`);
      await new Promise<void>((resolve, reject) => {
        ws2.on('open', () => {
          ws2.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'error' && msg.error?.includes('busy with another session')) {
              // This is expected - different sessions should conflict
              resolve();
            } else if (msg.type === 'connected') {
              reject(new Error('Should not connect with different session'));
            }
          });
        });
        ws2.on('error', () => resolve()); // WebSocket error is also acceptable
      });
      
      // Clean up
      ws1.close();
      await new Promise(resolve => ws1.on('close', resolve));
    });
  });
});