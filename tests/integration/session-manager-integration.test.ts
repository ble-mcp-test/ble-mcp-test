import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import { SharedState } from '../../src/shared-state.js';
import { WebSocketTransport } from '../../src/ws-transport.js';

/**
 * Integration tests for session manager refactoring
 * Uses WebSocketTransport directly to test session persistence
 */
describe.sequential('Session Manager Integration Tests', () => {
  let server: BridgeServer;
  let sharedState: SharedState;
  const basePort = 8095;
  
  // Real device configuration from .env.local
  const REAL_CONFIG = {
    device: '6c79b82603a7',
    service: '9800',
    write: '9900',
    notify: '9901'
  };
  
  beforeAll(async () => {
    console.log('\n🚀 Starting Session Manager Integration Tests\n');
    sharedState = new SharedState(false);
    server = new BridgeServer('info', sharedState);
    await server.start(basePort);
    console.log(`✅ Test server started on port ${basePort}`);
  });
  
  afterAll(async () => {
    if (server) {
      await server.stop();
      console.log('🛑 Test server stopped');
    }
  });

  it('should persist BLE session across WebSocket disconnections', async () => {
    console.log('\n📱 Test: Session persistence across WebSocket reconnections\n');
    
    const sessionId = `test-session-${Date.now()}`;
    const wsUrl = `ws://localhost:${basePort}`;
    
    // First connection with explicit session ID
    console.log(`1️⃣ Creating first connection with session: ${sessionId}`);
    const transport1 = new WebSocketTransport(wsUrl);
    
    try {
      await transport1.connect({
        ...REAL_CONFIG,
        session: sessionId
      });
    } catch (error) {
      console.log('⚠️ Connection failed (expected with mock device):', error.message);
    }
    
    // Check that session was created
    const sessions1 = server['sessionManager'].getAllSessions();
    expect(sessions1).toHaveLength(1);
    expect(sessions1[0].sessionId).toBe(sessionId);
    console.log('✅ Session created successfully');
    
    // Disconnect WebSocket
    transport1.disconnect();
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log('🔌 WebSocket disconnected');
    
    // Session should persist (grace period)
    const sessions2 = server['sessionManager'].getAllSessions();
    expect(sessions2).toHaveLength(1);
    expect(sessions2[0].sessionId).toBe(sessionId);
    console.log('✅ Session persists during grace period');
    
    // Reconnect to same session
    console.log(`2️⃣ Reconnecting to existing session: ${sessionId}`);
    const transport2 = new WebSocketTransport(wsUrl);
    
    try {
      await transport2.connect({
        ...REAL_CONFIG,
        session: sessionId
      });
    } catch (error) {
      console.log('⚠️ Reconnection failed (expected with mock device):', error.message);
    }
    
    // Should still be same session
    const sessions3 = server['sessionManager'].getAllSessions();
    expect(sessions3).toHaveLength(1);
    expect(sessions3[0].sessionId).toBe(sessionId);
    console.log('✅ Successfully reused existing session');
    
    transport2.disconnect();
  }, 15000);

  it('should auto-generate session ID when not provided', async () => {
    console.log('\n🆔 Test: Auto-generated session IDs\n');
    
    const wsUrl = `ws://localhost:${basePort}`;
    const transport = new WebSocketTransport(wsUrl);
    
    try {
      await transport.connect(REAL_CONFIG);
    } catch (error) {
      console.log('⚠️ Connection failed (expected with mock device):', error.message);
    }
    
    // Check that session was created with auto-generated ID
    const sessions = server['sessionManager'].getAllSessions();
    const newSession = sessions.find(s => !s.sessionId.includes('test-session'));
    
    expect(newSession).toBeDefined();
    expect(newSession.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    console.log('✅ Auto-generated session ID:', newSession.sessionId);
    
    transport.disconnect();
  }, 10000);

  it('should support multiple WebSockets per session', async () => {
    console.log('\n👥 Test: Multiple WebSockets per session\n');
    
    const sessionId = `multi-ws-${Date.now()}`;
    const wsUrl = `ws://localhost:${basePort}`;
    
    // Create first connection
    const transport1 = new WebSocketTransport(wsUrl);
    try {
      await transport1.connect({
        ...REAL_CONFIG,
        session: sessionId
      });
    } catch (error) {
      console.log('⚠️ First connection failed (expected):', error.message);
    }
    
    // Create second connection to same session
    const transport2 = new WebSocketTransport(wsUrl);
    try {
      await transport2.connect({
        ...REAL_CONFIG,
        session: sessionId
      });
    } catch (error) {
      console.log('⚠️ Second connection failed (expected):', error.message);
    }
    
    // Should have one session with multiple WebSockets
    const sessions = server['sessionManager'].getAllSessions();
    const targetSession = sessions.find(s => s.sessionId === sessionId);
    
    expect(targetSession).toBeDefined();
    const status = targetSession.getStatus();
    expect(status.activeWebSockets).toBe(2);
    console.log(`✅ Session has ${status.activeWebSockets} active WebSockets`);
    
    // Disconnect one
    transport1.disconnect();
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Session should still exist with one WebSocket
    const status2 = targetSession.getStatus();
    expect(status2.activeWebSockets).toBe(1);
    console.log('✅ Session maintained with remaining WebSocket');
    
    transport2.disconnect();
  }, 15000);

  it('should update SharedState when sessions change', async () => {
    console.log('\n📊 Test: SharedState integration\n');
    
    // Spy on SharedState
    const setConnectionStateSpy = vi.spyOn(sharedState, 'setConnectionState');
    
    const wsUrl = `ws://localhost:${basePort}`;
    const transport = new WebSocketTransport(wsUrl);
    
    try {
      await transport.connect(REAL_CONFIG);
    } catch (error) {
      console.log('⚠️ Connection failed (expected):', error.message);
    }
    
    // SharedState should be called during connection attempts
    expect(setConnectionStateSpy).toHaveBeenCalled();
    console.log('✅ SharedState updated during connection lifecycle');
    
    transport.disconnect();
    setConnectionStateSpy.mockRestore();
  }, 10000);

  it('should clean up all sessions on server stop', async () => {
    console.log('\n🧹 Test: Session cleanup on server stop\n');
    
    // Create a new server instance for this test
    const testPort = basePort + 1;
    const testSharedState = new SharedState(false);
    const testServer = new BridgeServer('info', testSharedState);
    await testServer.start(testPort);
    
    const wsUrl = `ws://localhost:${testPort}`;
    
    // Create multiple sessions
    for (let i = 0; i < 3; i++) {
      const transport = new WebSocketTransport(wsUrl);
      try {
        await transport.connect({
          ...REAL_CONFIG,
          session: `cleanup-test-${i}`
        });
      } catch (error) {
        // Expected to fail with mock device
      }
    }
    
    // Verify sessions were created
    const sessionsBefore = testServer['sessionManager'].getAllSessions();
    expect(sessionsBefore.length).toBeGreaterThan(0);
    console.log(`📊 Created ${sessionsBefore.length} sessions`);
    
    // Stop server
    await testServer.stop();
    
    // All sessions should be cleaned up
    const sessionsAfter = testServer['sessionManager'].getAllSessions();
    expect(sessionsAfter).toHaveLength(0);
    console.log('✅ All sessions cleaned up on server stop');
  }, 15000);

  it('should validate refactored architecture line counts', async () => {
    console.log('\n📏 Test: Architecture refactoring validation\n');
    
    const fs = await import('fs/promises');
    
    // Check BridgeServer is properly refactored
    const bridgeServerContent = await fs.readFile('./src/bridge-server.ts', 'utf-8');
    const bridgeLines = bridgeServerContent.split('\n').length;
    console.log(`📊 bridge-server.ts: ${bridgeLines} lines`);
    expect(bridgeLines).toBeLessThan(110);
    
    // Check SessionManager exists and is reasonable size
    const sessionManagerContent = await fs.readFile('./src/session-manager.ts', 'utf-8');
    const sessionLines = sessionManagerContent.split('\n').length;
    console.log(`📊 session-manager.ts: ${sessionLines} lines`);
    expect(sessionLines).toBeLessThan(150);
    
    // Check WebSocketHandler exists and is reasonable size
    const wsHandlerContent = await fs.readFile('./src/ws-handler.ts', 'utf-8');
    const wsLines = wsHandlerContent.split('\n').length;
    console.log(`📊 ws-handler.ts: ${wsLines} lines`);
    expect(wsLines).toBeLessThan(140);
    
    console.log('✅ All components properly sized and separated');
  });
});