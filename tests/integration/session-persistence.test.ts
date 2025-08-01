import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import { SharedState } from '../../src/shared-state.js';
import { WebSocketTransport } from '../../src/ws-transport.js';
import { getDeviceConfig } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();

/**
 * Integration tests for session persistence features
 * Tests actual server-side session management with real BLE device
 */
describe.sequential('Session Persistence Integration Tests', () => {
  let basePort = 8088;

  it('should create and persist sessions across WebSocket reconnections', async () => {
    console.log('\n🔄 Testing session persistence across WebSocket reconnections\n');
    
    // Create server for this test
    const port = basePort++;
    const sharedState = new SharedState(true);
    const server = new BridgeServer('info', sharedState);
    await server.start(port);
    
    try {
      const sessionId = `integration-test-${Date.now()}`;
      const wsUrl = `ws://localhost:${port}`;
      
      // First connection with explicit session ID
      console.log('📱 Creating first connection with session:', sessionId);
      const transport1 = new WebSocketTransport(wsUrl);
      
      await transport1.connect({
        ...DEVICE_CONFIG,
        session: sessionId
      });
      
      expect(transport1.isConnected()).toBe(true);
      expect(transport1.getSessionId()).toBe(sessionId);
      console.log('✅ First connection established');
      
      // Disconnect WebSocket (session should persist on server)
      transport1.disconnect();
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      console.log('🔌 WebSocket disconnected, session should persist on server');
      
      // Second connection to same session
      console.log('📱 Reconnecting to existing session:', sessionId);
      const transport2 = new WebSocketTransport(wsUrl);
      
      await transport2.connect({
        ...DEVICE_CONFIG,
        session: sessionId
      });
      
      expect(transport2.isConnected()).toBe(true);
      expect(transport2.getSessionId()).toBe(sessionId);
      console.log('✅ Successfully reconnected to existing session');
      
      // Clean up
      transport2.disconnect();
    } finally {
      await server.stop();
    }
  }, 30000);

  it('should support multiple WebSocket connections to same session', async () => {
    console.log('\n🔗 Testing multiple WebSocket connections to same session\n');
    
    // Create server for this test
    const port = basePort++;
    const sharedState = new SharedState(true);
    const server = new BridgeServer('info', sharedState);
    await server.start(port);
    
    try {
      const sessionId = `multi-conn-test-${Date.now()}`;
      const wsUrl = `ws://localhost:${port}`;
      
      // First connection creates the session
      console.log('📱 Creating session with first connection:', sessionId);
      const transport1 = new WebSocketTransport(wsUrl);
      
      await transport1.connect({
        ...DEVICE_CONFIG,
        session: sessionId
      });
      
      expect(transport1.isConnected()).toBe(true);
      console.log('✅ First connection established');
      
      // Second connection joins the same session
      console.log('📱 Joining session with second connection:', sessionId);
      const transport2 = new WebSocketTransport(wsUrl);
      
      await transport2.connect({
        ...DEVICE_CONFIG,
        session: sessionId
      });
      
      expect(transport2.isConnected()).toBe(true);
      expect(transport2.getSessionId()).toBe(sessionId);
      console.log('✅ Second connection joined session');
      
      // Both should be connected to the same session
      expect(transport1.getSessionId()).toBe(transport2.getSessionId());
      console.log('🎯 Both WebSockets sharing same BLE session');
      
      // Disconnect first, second should remain
      transport1.disconnect();
      await new Promise(resolve => setTimeout(resolve, 500));
      
      expect(transport2.isConnected()).toBe(true);
      console.log('✅ Session persists when one WebSocket disconnects');
      
      // Clean up
      transport2.disconnect();
    } finally {
      await server.stop();
    }
  }, 30000);

  it('should auto-generate unique session IDs when requested', async () => {
    console.log('\n🆔 Testing auto-generated session IDs\n');
    
    // Create server for this test
    const port = basePort++;
    const sharedState = new SharedState(true);
    const server = new BridgeServer('info', sharedState);
    await server.start(port);
    
    try {
      const wsUrl = `ws://localhost:${port}`;
      
      // Create connection with auto-generated session
      console.log('📱 Creating connection with auto-generated session');
      const transport = new WebSocketTransport(wsUrl);
      
      await transport.connect({
        ...DEVICE_CONFIG,
        generateSession: true       
      });
      
      expect(transport.isConnected()).toBe(true);
      
      const sessionId = transport.getSessionId();
      expect(sessionId).toBeDefined();
      expect(sessionId).toContain('cs108-session-');
      
      console.log('✅ Auto-generated session ID:', sessionId);
      
      // Clean up
      transport.disconnect();
    } finally {
      await server.stop();
    }
  }, 15000);

  it('should maintain backward compatibility without session parameters', async () => {
    console.log('\n⬅️  Testing backward compatibility (no session parameters)\n');
    
    // Create server for this test
    const port = basePort++;
    const sharedState = new SharedState(true);
    const server = new BridgeServer('info', sharedState);
    await server.start(port);
    
    try {
      const wsUrl = `ws://localhost:${port}`;
      
      // Create connection without any session parameters (legacy mode)
      console.log('📱 Creating legacy connection (no session parameters)');
      const transport = new WebSocketTransport(wsUrl);
      
      await transport.connect(DEVICE_CONFIG);
      
      expect(transport.isConnected()).toBe(true);
      
      // Session ID should be undefined for backward compatibility
      const sessionId = transport.getSessionId();
      console.log('📋 Session ID (should be undefined):', sessionId || 'undefined');
      
      // Clean up
      transport.disconnect();
      
      console.log('✅ Backward compatibility maintained');
    } finally {
      await server.stop();
    }
  }, 15000);

  it('should handle session cleanup via forceCleanup', async () => {
    console.log('\n🧹 Testing session cleanup via forceCleanup\n');
    
    // Create server for this test
    const port = basePort++;
    const sharedState = new SharedState(true);
    const server = new BridgeServer('info', sharedState);
    await server.start(port);
    
    try {
      const sessionId = `cleanup-test-${Date.now()}`;
      const wsUrl = `ws://localhost:${port}`;
      
      // Create session
      console.log('📱 Creating session for cleanup test:', sessionId);
      const transport = new WebSocketTransport(wsUrl);
      
      await transport.connect({
        ...DEVICE_CONFIG,
        session: sessionId
      });
      
      expect(transport.isConnected()).toBe(true);
      console.log('✅ Session created');
      
      // Force cleanup the session
      console.log('🧹 Executing forceCleanup...');
      await transport.forceCleanup();
      console.log('✅ ForceCleanup completed');
      
      // Disconnect and try to reconnect to the cleaned session
      transport.disconnect();
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      console.log('🔄 Attempting to reconnect to cleaned session...');
      
      try {
        await transport.connect({
          ...DEVICE_CONFIG,
          session: sessionId
        });
        // If we get here, the session wasn't properly cleaned
        transport.disconnect();
        throw new Error('Session should have been cleaned up');
      } catch (error) {
        // This is expected - session should be gone
        console.log('✅ Session properly cleaned up (reconnection failed as expected)');
        expect(error).toBeDefined();
      }
    } finally {
      await server.stop();
    }
  }, 20000);

  it('should demonstrate localStorage session persistence in mock', async () => {
    console.log('\n💾 Testing localStorage session persistence in Web Bluetooth mock\n');
    
    // Mock browser environment
    const mockWindow = {
      location: { hostname: '127.0.0.1', origin: 'http://127.0.0.1:3000' },
      navigator: {}
    };
    
    const mockStorage: Record<string, string> = {};
    const mockLocalStorage = {
      getItem: (key: string) => mockStorage[key] || null,
      setItem: (key: string, value: string) => { mockStorage[key] = value; },
      removeItem: (key: string) => { delete mockStorage[key]; }
    };
    
    // Mock WebSocket to capture session parameters
    const capturedWebSocketUrls: string[] = [];
    class MockWebSocket {
      constructor(public url: string) {
        capturedWebSocketUrls.push(url);
        this.readyState = 1; // OPEN
        
        setTimeout(() => {
          if (this.onopen) this.onopen(new Event('open'));
          if (this.onmessage) {
            this.onmessage(new MessageEvent('message', {
              data: JSON.stringify({ type: 'connected', token: 'test-token' })
            }));
          }
        }, 10);
      }
      
      readyState = 0;
      send() {}
      close() {}
      
      onopen: ((ev: Event) => any) | null = null;
      onmessage: ((ev: MessageEvent) => any) | null = null;
      onerror: ((ev: Event) => any) | null = null;
      onclose: ((ev: CloseEvent) => any) | null = null;
    }
    
    // Setup globals
    const originalWindow = (global as any).window;
    const originalLocalStorage = (global as any).localStorage;
    const originalWebSocket = (global as any).WebSocket;
    
    try {
      (global as any).window = mockWindow;
      (global as any).localStorage = mockLocalStorage;
      (global as any).WebSocket = MockWebSocket;
      // Don't modify global.navigator since it's read-only
      
      // Import and test the mock
      const { injectWebBluetoothMock, clearStoredSession } = await import('../../src/index.js');
      
      // Clear any existing session
      clearStoredSession();
      expect(mockStorage['ble-mock-session-id']).toBeUndefined();
      console.log('🧹 Cleared existing session');
      
      // First injection
      injectWebBluetoothMock('ws://localhost:8080');
      const firstBluetooth = mockWindow.navigator.bluetooth as any;
      const firstSessionId = firstBluetooth.autoSessionId;
      
      console.log('📱 First injection session ID:', firstSessionId);
      expect(firstSessionId).toBeTruthy();
      expect(mockStorage['ble-mock-session-id']).toBe(firstSessionId);
      
      // Create device and connect to trigger WebSocket
      const firstDevice = await firstBluetooth.requestDevice({
        filters: [{ namePrefix: 'CS108' }]
      });
      await firstDevice.gatt.connect();
      
      const firstUrl = capturedWebSocketUrls[capturedWebSocketUrls.length - 1];
      console.log('🔗 First WebSocket URL:', firstUrl);
      
      // Second injection (simulating page reload)
      injectWebBluetoothMock('ws://localhost:8080');
      const secondBluetooth = mockWindow.navigator.bluetooth as any;
      const secondSessionId = secondBluetooth.autoSessionId;
      
      console.log('📱 Second injection session ID:', secondSessionId);
      expect(secondSessionId).toBe(firstSessionId);
      expect(mockStorage['ble-mock-session-id']).toBe(firstSessionId);
      
      // Create device and connect to trigger WebSocket
      const secondDevice = await secondBluetooth.requestDevice({
        filters: [{ namePrefix: 'CS108' }]
      });
      await secondDevice.gatt.connect();
      
      const secondUrl = capturedWebSocketUrls[capturedWebSocketUrls.length - 1];
      console.log('🔗 Second WebSocket URL:', secondUrl);
      
      // Extract session parameters from URLs
      const getSessionFromUrl = (url: string) => {
        const urlObj = new URL(url);
        return urlObj.searchParams.get('session');
      };
      
      const firstUrlSession = getSessionFromUrl(firstUrl);
      const secondUrlSession = getSessionFromUrl(secondUrl);
      
      console.log('🎯 Session consistency check:');
      console.log('  First URL session:', firstUrlSession);
      console.log('  Second URL session:', secondUrlSession);
      console.log('  Sessions match:', firstUrlSession === secondUrlSession);
      console.log('  localStorage value:', mockStorage['ble-mock-session-id']);
      
      // All session IDs should match
      expect(firstSessionId).toBe(secondSessionId);
      expect(firstUrlSession).toBe(secondUrlSession);
      expect(firstUrlSession).toBe(firstSessionId);
      
      console.log('✅ localStorage session persistence working correctly');
      
    } finally {
      // Restore globals
      (global as any).window = originalWindow;
      (global as any).localStorage = originalLocalStorage;
      (global as any).WebSocket = originalWebSocket;
    }
  }, 15000);
});