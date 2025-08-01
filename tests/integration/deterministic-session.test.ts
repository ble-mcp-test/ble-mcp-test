import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/bridge-server.js';
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';
import { setupTestServer, WS_URL } from '../test-config.js';

describe('Deterministic Session ID Integration Tests', () => {
  let server: BridgeServer | null;
  
  beforeAll(async () => {
    // Use the standard test server setup that handles ports properly
    server = await setupTestServer();
  });
  
  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });
  
  describe('Node.js Environment', () => {
    it('should use environment variable for session ID', async () => {
      // Set environment variable
      process.env.BLE_TEST_SESSION_ID = 'node-env-test-session';
      
      try {
        // This test verifies that the session ID from environment is accepted by the server
        // We're not testing device connection, just session acceptance
        const ws = new WebSocket(`${WS_URL}?device=TestDevice&service=1234&write=5678&notify=9012&session=${process.env.BLE_TEST_SESSION_ID}`);
        
        await new Promise<void>((resolve, reject) => {
          ws.on('open', () => {
            // Successfully opened WebSocket connection
            resolve();
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
      // Fix navigator - use Object.defineProperty for read-only property
      Object.defineProperty(global, 'navigator', {
        value: window.navigator,
        configurable: true
      });
      (global as any).location = window.location;
      (global as any).WebSocket = WebSocket;
      
      // Set Playwright environment
      process.env.PLAYWRIGHT_TEST_BASE_URL = 'http://localhost:3000';
      
      try {
        // Import mock bluetooth in this environment
        const { MockBluetooth } = await import('../../src/mock-bluetooth.js');
        
        const mock = new MockBluetooth(WS_URL);
        const device = await mock.requestDevice();
        
        // Should generate deterministic session ID (can be localhost or 127.0.0.1)
        expect(device.sessionId).toMatch(/^(localhost|127\.0\.0\.1)-/);
        expect(device.sessionId).not.toMatch(/-[A-Z0-9]{4}$/); // No random suffix
        
        // The session ID should contain test path info
        expect(device.sessionId).toContain('-tests');
      } finally {
        // Clean up
        delete (global as any).window;
        // Use Object.defineProperty to remove navigator
        Object.defineProperty(global, 'navigator', {
          value: undefined,
          configurable: true
        });
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
      // Fix navigator - use Object.defineProperty for read-only property
      Object.defineProperty(global, 'navigator', {
        value: window.navigator,
        configurable: true
      });
      (global as any).location = window.location;
      (global as any).WebSocket = WebSocket;
      
      // Set explicit test session ID
      window.BLE_TEST_SESSION_ID = 'explicit-integration-test';
      
      try {
        // Import mock bluetooth in this environment
        const { MockBluetooth } = await import('../../src/mock-bluetooth.js');
        
        const mock = new MockBluetooth(WS_URL);
        const device = await mock.requestDevice();
        
        // Should use explicit session ID
        expect(device.sessionId).toBe('explicit-integration-test');
      } finally {
        // Clean up
        delete (global as any).window;
        // Use Object.defineProperty to remove navigator
        Object.defineProperty(global, 'navigator', {
          value: undefined,
          configurable: true
        });
        delete (global as any).location;
        delete (global as any).WebSocket;
        dom.window.close();
      }
    });
  });
  
  describe('Session Priority', () => {
    it('should prioritize explicit ID over environment variable', async () => {
      const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'http://localhost',
        pretendToBeVisual: true,
        resources: 'usable'
      });
      
      const window = dom.window;
      
      // Set up globals
      (global as any).window = window;
      Object.defineProperty(global, 'navigator', {
        value: window.navigator,
        configurable: true
      });
      (global as any).location = window.location;
      (global as any).WebSocket = WebSocket;
      
      // Set both environment and explicit
      process.env.BLE_TEST_SESSION_ID = 'env-should-lose';
      window.BLE_TEST_SESSION_ID = 'explicit-should-win';
      
      try {
        // Import mock bluetooth in this environment
        const { MockBluetooth } = await import('../../src/mock-bluetooth.js');
        
        const mock = new MockBluetooth(WS_URL);
        const device = await mock.requestDevice();
        
        // Explicit should win
        expect(device.sessionId).toBe('explicit-should-win');
      } finally {
        // Clean up
        delete process.env.BLE_TEST_SESSION_ID;
        delete (global as any).window;
        Object.defineProperty(global, 'navigator', {
          value: undefined,
          configurable: true
        });
        delete (global as any).location;
        delete (global as any).WebSocket;
        dom.window.close();
      }
    });
  });
});