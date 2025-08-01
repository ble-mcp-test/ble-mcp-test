import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebSocketHandler } from '../../src/ws-handler.js';
import { EventEmitter } from 'events';

// Mock WebSocket
class MockWebSocket extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  send = vi.fn();
  close = vi.fn();
}

// Mock BleSession
class MockBleSession extends EventEmitter {
  sessionId = 'test-session';
  addWebSocket = vi.fn();
  removeWebSocket = vi.fn();
  write = vi.fn().mockResolvedValue(undefined);
  forceCleanup = vi.fn().mockResolvedValue(undefined);
}

describe('WebSocketHandler', () => {
  let handler: WebSocketHandler;
  let mockWs: MockWebSocket;
  let mockSession: MockBleSession;
  let mockSharedState: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWs = new MockWebSocket();
    mockSession = new MockBleSession();
    mockSharedState = {
      logPacket: vi.fn(),
      setConnectionState: vi.fn()
    };
    
    handler = new WebSocketHandler(mockWs as any, mockSession as any, mockSharedState);
  });

  describe('initialization', () => {
    it('should add WebSocket to session on creation', () => {
      expect(mockSession.addWebSocket).toHaveBeenCalledWith(mockWs);
    });

    it('should set up WebSocket event listeners', () => {
      const onSpy = vi.spyOn(mockWs, 'on');
      new WebSocketHandler(mockWs as any, mockSession as any);
      
      expect(onSpy).toHaveBeenCalledWith('message', expect.any(Function));
      expect(onSpy).toHaveBeenCalledWith('close', expect.any(Function));
      expect(onSpy).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('message handling', () => {
    it('should forward data messages to BLE session', async () => {
      const testData = [0xA7, 0xB3, 0x01];
      const message = JSON.stringify({ type: 'data', data: testData });
      
      // Simulate receiving WebSocket message
      mockWs.emit('message', message);
      
      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 0));
      
      expect(mockSession.write).toHaveBeenCalledWith(new Uint8Array(testData));
      expect(mockSharedState.logPacket).toHaveBeenCalledWith('TX', new Uint8Array(testData));
    });

    it('should handle force_cleanup messages', async () => {
      const message = JSON.stringify({ type: 'force_cleanup' });
      
      mockWs.emit('message', message);
      await new Promise(resolve => setTimeout(resolve, 0));
      
      expect(mockSession.forceCleanup).toHaveBeenCalledWith('force cleanup command');
      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'force_cleanup_complete', message: 'Cleanup complete' })
      );
    });

    it('should handle invalid JSON messages gracefully', async () => {
      const invalidMessage = 'not valid json {]';
      
      mockWs.emit('message', invalidMessage);
      await new Promise(resolve => setTimeout(resolve, 0));
      
      expect(mockWs.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"error"')
      );
    });

    it('should ignore messages without data field', async () => {
      const message = JSON.stringify({ type: 'data' }); // Missing data field
      
      mockWs.emit('message', message);
      await new Promise(resolve => setTimeout(resolve, 0));
      
      expect(mockSession.write).not.toHaveBeenCalled();
    });
  });

  describe('BLE data forwarding', () => {
    it('should forward BLE data to WebSocket', () => {
      const testData = new Uint8Array([0x02, 0x01, 0xE2]);
      
      // Simulate BLE data event
      mockSession.emit('data', testData);
      
      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'data', data: [0x02, 0x01, 0xE2] })
      );
    });

    it('should not send data if WebSocket is closed', () => {
      mockWs.readyState = 3; // CLOSED state
      const testData = new Uint8Array([0x02, 0x01, 0xE2]);
      
      mockSession.emit('data', testData);
      
      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });

  describe('connection lifecycle', () => {
    it('should remove WebSocket from session on close', () => {
      mockWs.emit('close');
      
      expect(mockSession.removeWebSocket).toHaveBeenCalledWith(mockWs);
    });

    it('should emit close event when WebSocket closes', () => {
      const closeSpy = vi.fn();
      handler.on('close', closeSpy);
      
      mockWs.emit('close');
      
      expect(closeSpy).toHaveBeenCalled();
    });

    it('should handle WebSocket errors', () => {
      const errorSpy = vi.fn();
      handler.on('error', errorSpy);
      const testError = new Error('WebSocket error');
      
      mockWs.emit('error', testError);
      
      expect(mockSession.removeWebSocket).toHaveBeenCalledWith(mockWs);
      expect(errorSpy).toHaveBeenCalledWith(testError);
    });

    it('should clean up session event listeners on close', () => {
      const removeListenerSpy = vi.spyOn(mockSession, 'removeListener');
      
      handler.emit('close');
      
      expect(removeListenerSpy).toHaveBeenCalledWith('data', expect.any(Function));
    });
  });

  describe('status reporting', () => {
    it('should return connection status', () => {
      const status = handler.getStatus();
      
      expect(status).toEqual({
        connected: true,
        lastActivity: expect.any(Number),
        sessionId: 'test-session'
      });
    });

    it('should update last activity on message', async () => {
      const initialStatus = handler.getStatus();
      const initialActivity = initialStatus.lastActivity;
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Send a message
      mockWs.emit('message', JSON.stringify({ type: 'data', data: [1, 2, 3] }));
      
      const newStatus = handler.getStatus();
      expect(newStatus.lastActivity).toBeGreaterThan(initialActivity);
    });
  });

  describe('error handling', () => {
    it('should send error message when session write fails', async () => {
      const testError = new Error('Write failed');
      mockSession.write.mockRejectedValueOnce(testError);
      
      const message = JSON.stringify({ type: 'data', data: [1, 2, 3] });
      mockWs.emit('message', message);
      
      await new Promise(resolve => setTimeout(resolve, 0));
      
      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'error', error: 'Write failed' })
      );
    });

    it('should not send error if WebSocket is closed', async () => {
      mockWs.readyState = 3; // CLOSED
      const testError = new Error('Write failed');
      mockSession.write.mockRejectedValueOnce(testError);
      
      const message = JSON.stringify({ type: 'data', data: [1, 2, 3] });
      mockWs.emit('message', message);
      
      await new Promise(resolve => setTimeout(resolve, 0));
      
      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });
});