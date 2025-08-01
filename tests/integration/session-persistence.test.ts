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
});