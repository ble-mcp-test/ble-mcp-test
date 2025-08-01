import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

describe('MockBluetooth Session ID Generation', () => {
  let dom: JSDOM;
  let window: any;
  let localStorage: any;
  let originalProcess: any;
  
  beforeEach(() => {
    // Create a new JSDOM instance for each test
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost',
      pretendToBeVisual: true,
      resources: 'usable'
    });
    
    window = dom.window;
    localStorage = window.localStorage;
    
    // Store original process.env
    originalProcess = process.env;
    
    // Set up globals
    (global as any).window = window;
    (global as any).localStorage = localStorage;
    // Fix navigator - use Object.defineProperty for read-only property
    Object.defineProperty(global, 'navigator', {
      value: window.navigator,
      configurable: true
    });
    (global as any).location = window.location;
  });
  
  afterEach(() => {
    // Clean up globals
    delete (global as any).window;
    delete (global as any).localStorage;
    delete (global as any).navigator;
    delete (global as any).location;
    
    // Clean up any test environment variables
    delete process.env.BLE_TEST_SESSION_ID;
    delete process.env.PLAYWRIGHT_TEST_BASE_URL;
    
    // Clean up JSDOM
    dom.window.close();
    
    // Reset module cache to avoid state leakage
    vi.resetModules();
  });
  
  describe('Hierarchical Session ID Strategy', () => {
    it('should use window.BLE_TEST_SESSION_ID when available', async () => {
      // Set explicit test session ID
      window.BLE_TEST_SESSION_ID = 'explicit-test-session';
      
      // Import after setting up environment
      const { MockBluetooth } = await import('../../src/mock-bluetooth.js');
      
      const mock = new MockBluetooth('ws://localhost:8080');
      const device = await mock.requestDevice();
      
      // The session ID should be the explicit one
      expect(device.sessionId).toBe('explicit-test-session');
    });
    
    it('should use process.env.BLE_TEST_SESSION_ID when no window override', async () => {
      // Set environment variable
      process.env.BLE_TEST_SESSION_ID = 'env-test-session';
      
      // Import after setting up environment
      const { MockBluetooth } = await import('../../src/mock-bluetooth.js');
      
      const mock = new MockBluetooth('ws://localhost:8080');
      const device = await mock.requestDevice();
      
      // The session ID should be from environment
      expect(device.sessionId).toBe('env-test-session');
    });
    
    it('should generate deterministic ID for Playwright environment', async () => {
      // Simulate Playwright environment
      process.env.PLAYWRIGHT_TEST_BASE_URL = 'http://localhost:3000';
      
      // Mock user agent to include Playwright
      Object.defineProperty(window.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 Playwright/1.0',
        configurable: true
      });
      
      // Import after setting up environment
      const { MockBluetooth } = await import('../../src/mock-bluetooth.js');
      
      const mock = new MockBluetooth('ws://localhost:8080');
      const device = await mock.requestDevice();
      
      // The session ID should have deterministic format (IP or localhost)
      expect(device.sessionId).toMatch(/^(localhost|127\.0\.0\.1)-/);
      expect(device.sessionId).not.toMatch(/-[A-Z0-9]{4}$/); // Should not have random suffix
      
      // Should contain test path info (may be partial due to stack trace limitations)
      expect(device.sessionId).toContain('-tests');
    });
    
    it('should fall back to random generation for interactive use', async () => {
      // Clear any localStorage
      localStorage.clear();
      
      // Import after setting up environment
      const { MockBluetooth } = await import('../../src/mock-bluetooth.js');
      
      const mock = new MockBluetooth('ws://localhost:8080');
      const device = await mock.requestDevice();
      
      // The session ID should have standard format with random suffix
      expect(device.sessionId).toMatch(/^[\d.]+-(chrome|firefox|safari|edge|browser)-[A-Z0-9]{4}$/);
    });
    
    it('should persist session ID in localStorage for interactive use', async () => {
      // Clear any localStorage
      localStorage.clear();
      
      // Import after setting up environment
      const { MockBluetooth } = await import('../../src/mock-bluetooth.js');
      
      const mock1 = new MockBluetooth('ws://localhost:8080');
      const device1 = await mock1.requestDevice();
      const sessionId1 = device1.sessionId;
      
      // Create a second instance
      const mock2 = new MockBluetooth('ws://localhost:8080');
      const device2 = await mock2.requestDevice();
      const sessionId2 = device2.sessionId;
      
      // Should reuse the same session ID
      expect(sessionId2).toBe(sessionId1);
      
      // Should be stored in localStorage
      expect(localStorage.getItem('ble-mock-session-id')).toBe(sessionId1);
    });
    
    it('should prioritize explicit ID over environment variable', async () => {
      // Set both
      window.BLE_TEST_SESSION_ID = 'explicit-wins';
      process.env.BLE_TEST_SESSION_ID = 'env-loses';
      
      // Import after setting up environment
      const { MockBluetooth } = await import('../../src/mock-bluetooth.js');
      
      const mock = new MockBluetooth('ws://localhost:8080');
      const device = await mock.requestDevice();
      
      // Explicit should win
      expect(device.sessionId).toBe('explicit-wins');
    });
  });
  
  describe('Test Path Extraction', () => {
    it('should extract test path from stack trace', async () => {
      // This test is running, so it should detect its own path
      process.env.PLAYWRIGHT_TEST_BASE_URL = 'http://localhost:3000';
      
      // Import after setting up environment
      const { MockBluetooth } = await import('../../src/mock-bluetooth.js');
      
      const mock = new MockBluetooth('ws://localhost:8080');
      const device = await mock.requestDevice();
      
      // Should include test path info (may be partial due to stack trace limitations)
      expect(device.sessionId).toMatch(/-(tests|unit|mock-bluetooth)/);
      
      // Verify it's deterministic format
      expect(device.sessionId).not.toMatch(/-[A-Z0-9]{4}$/);
    });
  });
  
  describe('Utility Functions', () => {
    it('should set test session ID via setTestSessionId', async () => {
      // Import after setting up environment
      const { MockBluetooth, setTestSessionId } = await import('../../src/mock-bluetooth.js');
      
      setTestSessionId('utility-test-session');
      
      const mock = new MockBluetooth('ws://localhost:8080');
      const device = await mock.requestDevice();
      
      expect(device.sessionId).toBe('utility-test-session');
    });
    
    it('should clear stored session via clearStoredSession', async () => {
      // Import after setting up environment
      const { MockBluetooth, clearStoredSession } = await import('../../src/mock-bluetooth.js');
      
      // First create a session
      const mock1 = new MockBluetooth('ws://localhost:8080');
      await mock1.requestDevice();
      
      // Verify it's stored
      expect(localStorage.getItem('ble-mock-session-id')).toBeTruthy();
      
      // Clear it
      clearStoredSession();
      
      // Verify it's gone
      expect(localStorage.getItem('ble-mock-session-id')).toBeNull();
    });
  });
});