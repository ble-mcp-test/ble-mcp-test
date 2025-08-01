import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import { SharedState } from '../../src/shared-state.js';
import { WebSocket } from 'ws';

/**
 * Integration tests for the refactored session manager architecture
 * Tests the new session persistence without requiring real BLE hardware
 */
describe.sequential('Session Manager Refactor Integration Tests', () => {
  let basePort = 8090;
  let server: BridgeServer;
  let sharedState: SharedState;

  beforeEach(async () => {
    // Mock Noble to avoid real BLE hardware requirement
    const mockPeripheral = {
      id: 'mock-device-id',
      advertisement: { localName: 'mock-device' },
      connectAsync: vi.fn().mockResolvedValue(undefined),
      discoverServicesAsync: vi.fn().mockResolvedValue([{
        uuid: '1234',
        discoverCharacteristicsAsync: vi.fn().mockResolvedValue([
          {
            uuid: '5678',
            writeAsync: vi.fn().mockResolvedValue(undefined)
          },
          {
            uuid: '9012',
            on: vi.fn(),
            subscribeAsync: vi.fn().mockResolvedValue(undefined)
          }
        ])
      }]),
      once: vi.fn(),
      removeAllListeners: vi.fn()
    };

    vi.doMock('@stoprocent/noble', () => ({
      default: {
        state: 'poweredOn',
        on: vi.fn((event, callback) => {
          if (event === 'discover') {
            // Immediately discover our mock device
            setTimeout(() => callback(mockPeripheral), 100);
          }
        }),
        once: vi.fn(),
        removeListener: vi.fn(),
        removeAllListeners: vi.fn(),
        startScanningAsync: vi.fn().mockResolvedValue(undefined),
        stopScanningAsync: vi.fn().mockResolvedValue(undefined),
        waitForPoweredOnAsync: vi.fn().mockResolvedValue(undefined)
      }
    }));
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    vi.restoreAllMocks();
  });

  it('should refactor BridgeServer to ~100 lines with clean separation', async () => {
    console.log('\n📏 Testing refactored BridgeServer size and structure\n');
    
    // Read the source file to check line count
    const fs = await import('fs/promises');
    const bridgeServerContent = await fs.readFile('./src/bridge-server.ts', 'utf-8');
    const lineCount = bridgeServerContent.split('\n').length;
    
    console.log(`📊 BridgeServer line count: ${lineCount}`);
    expect(lineCount).toBeLessThan(110); // ~103 lines is acceptable
    
    // Verify it only imports what it needs
    expect(bridgeServerContent).toContain('SessionManager');
    expect(bridgeServerContent).not.toContain('NobleTransport'); // Should not directly use transport
    
    console.log('✅ BridgeServer successfully refactored to minimal size');
  });

  it('should maintain session across WebSocket reconnections', async () => {
    console.log('\n🔄 Testing session persistence with new architecture\n');
    
    const port = basePort++;
    sharedState = new SharedState(false);
    server = new BridgeServer('info', sharedState);
    await server.start(port);
    
    const sessionId = 'test-session-123';
    const wsUrl = `ws://localhost:${port}?device=mock&service=1234&write=5678&notify=9012&session=${sessionId}`;
    
    // First connection
    console.log('📱 Creating first WebSocket connection');
    const ws1 = new WebSocket(wsUrl);
    
    await new Promise<void>((resolve, reject) => {
      ws1.on('open', () => resolve());
      ws1.on('error', reject);
    });
    
    // Wait for connection message
    await new Promise<void>((resolve) => {
      ws1.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected' || msg.type === 'error') {
          resolve();
        }
      });
    });
    
    console.log('✅ First connection established');
    
    // Check that session manager has the session
    const sessions1 = server['sessionManager'].getAllSessions();
    expect(sessions1).toHaveLength(1);
    expect(sessions1[0].sessionId).toBe(sessionId);
    
    // Disconnect first WebSocket
    ws1.close();
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('🔌 First WebSocket disconnected');
    
    // Session should still exist (grace period)
    const sessions2 = server['sessionManager'].getAllSessions();
    expect(sessions2).toHaveLength(1);
    console.log('✅ Session persists after disconnect (grace period active)');
    
    // Second connection to same session
    console.log('📱 Creating second WebSocket connection to same session');
    const ws2 = new WebSocket(wsUrl);
    
    await new Promise<void>((resolve, reject) => {
      ws2.on('open', () => resolve());
      ws2.on('error', reject);
    });
    
    console.log('✅ Successfully reconnected to existing session');
    
    // Should still be just one session
    const sessions3 = server['sessionManager'].getAllSessions();
    expect(sessions3).toHaveLength(1);
    expect(sessions3[0].sessionId).toBe(sessionId);
    
    ws2.close();
  });

  it('should support multiple concurrent WebSockets per session', async () => {
    console.log('\n👥 Testing multiple WebSockets per session\n');
    
    const port = basePort++;
    sharedState = new SharedState(false);
    server = new BridgeServer('info', sharedState);
    await server.start(port);
    
    const sessionId = 'multi-ws-session';
    const wsUrl = `ws://localhost:${port}?device=mock&service=1234&write=5678&notify=9012&session=${sessionId}`;
    
    // Create two WebSocket connections
    console.log('📱 Creating first WebSocket');
    const ws1 = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws1.on('open', () => resolve());
      ws1.on('error', reject);
    });
    
    console.log('📱 Creating second WebSocket');
    const ws2 = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws2.on('open', () => resolve());
      ws2.on('error', reject);
    });
    
    // Check session has multiple WebSockets
    const sessions = server['sessionManager'].getAllSessions();
    expect(sessions).toHaveLength(1);
    
    const sessionStatus = sessions[0].getStatus();
    console.log(`📊 Session status: ${sessionStatus.activeWebSockets} active WebSockets`);
    expect(sessionStatus.activeWebSockets).toBe(2);
    
    // Close one WebSocket
    ws1.close();
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Session should still have one WebSocket
    const sessionStatus2 = sessions[0].getStatus();
    expect(sessionStatus2.activeWebSockets).toBe(1);
    console.log('✅ Session maintains connection when one WebSocket closes');
    
    ws2.close();
  });

  it('should auto-generate session ID when not provided', async () => {
    console.log('\n🆔 Testing auto-generated session IDs\n');
    
    const port = basePort++;
    sharedState = new SharedState(false);
    server = new BridgeServer('info', sharedState);
    await server.start(port);
    
    // Connect without session parameter
    const wsUrl = `ws://localhost:${port}?device=mock&service=1234&write=5678&notify=9012`;
    const ws = new WebSocket(wsUrl);
    
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    
    // Check that a session was created with auto-generated ID
    const sessions = server['sessionManager'].getAllSessions();
    expect(sessions).toHaveLength(1);
    
    const sessionId = sessions[0].sessionId;
    expect(sessionId).toBeDefined();
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    console.log('✅ Auto-generated session ID:', sessionId);
    
    ws.close();
  });

  it('should update SharedState with connection status', async () => {
    console.log('\n📊 Testing SharedState integration\n');
    
    const port = basePort++;
    sharedState = new SharedState(false);
    const setConnectionStateSpy = vi.spyOn(sharedState, 'setConnectionState');
    
    server = new BridgeServer('info', sharedState);
    await server.start(port);
    
    const wsUrl = `ws://localhost:${port}?device=mock&service=1234&write=5678&notify=9012`;
    const ws = new WebSocket(wsUrl);
    
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    
    // Wait a bit for connection handling
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // SharedState should be updated when session connects
    expect(setConnectionStateSpy).toHaveBeenCalled();
    console.log('✅ SharedState updated with connection status');
    
    ws.close();
  });

  it('should clean up sessions on server stop', async () => {
    console.log('\n🧹 Testing session cleanup on server stop\n');
    
    const port = basePort++;
    sharedState = new SharedState(false);
    server = new BridgeServer('info', sharedState);
    await server.start(port);
    
    // Create multiple sessions
    for (let i = 0; i < 3; i++) {
      const wsUrl = `ws://localhost:${port}?device=mock&service=1234&write=5678&notify=9012&session=session-${i}`;
      const ws = new WebSocket(wsUrl);
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });
    }
    
    const sessionsBefore = server['sessionManager'].getAllSessions();
    expect(sessionsBefore).toHaveLength(3);
    console.log(`📊 Created ${sessionsBefore.length} sessions`);
    
    // Stop server
    await server.stop();
    
    // All sessions should be cleaned up
    const sessionsAfter = server['sessionManager'].getAllSessions();
    expect(sessionsAfter).toHaveLength(0);
    console.log('✅ All sessions cleaned up on server stop');
  });
});