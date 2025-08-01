import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionManager } from '../../src/session-manager.js';
import { BleSession } from '../../src/ble-session.js';
import type { BleConfig } from '../../src/noble-transport.js';

// Mock the BleSession module
vi.mock('../../src/ble-session.js', () => {
  const EventEmitter = require('events');
  
  return {
    BleSession: vi.fn().mockImplementation((sessionId, config, sharedState) => {
      const session = new EventEmitter();
      session.sessionId = sessionId;
      session.connect = vi.fn().mockResolvedValue('MockDevice');
      session.getStatus = vi.fn().mockReturnValue({
        sessionId,
        connected: false,
        deviceName: null,
        activeWebSockets: 0,
        idleTime: 0,
        hasGracePeriod: false,
        hasIdleTimer: false
      });
      session.forceCleanup = vi.fn().mockResolvedValue(undefined);
      session.addWebSocket = vi.fn();
      session.removeWebSocket = vi.fn();
      return session;
    })
  };
});

describe('SessionManager', () => {
  let manager: SessionManager;
  const mockConfig: BleConfig = {
    devicePrefix: 'test',
    serviceUuid: '1234',
    writeUuid: '5678',
    notifyUuid: '9012'
  };
  
  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
  });

  describe('session creation and management', () => {
    it('should create new session for unknown session ID', () => {
      const session = manager.getOrCreateSession('test-session-1', mockConfig);
      
      expect(session.sessionId).toBe('test-session-1');
      expect(BleSession).toHaveBeenCalledWith('test-session-1', mockConfig, undefined);
      expect(manager.getAllSessions()).toHaveLength(1);
    });

    it('should reuse existing session for known session ID', () => {
      const session1 = manager.getOrCreateSession('test-session-2', mockConfig);
      const session2 = manager.getOrCreateSession('test-session-2', mockConfig);
      
      expect(session1).toBe(session2);
      expect(BleSession).toHaveBeenCalledTimes(1);
      expect(manager.getAllSessions()).toHaveLength(1);
    });

    it('should handle multiple concurrent sessions', () => {
      const session1 = manager.getOrCreateSession('session-1', mockConfig);
      const session2 = manager.getOrCreateSession('session-2', mockConfig);
      const session3 = manager.getOrCreateSession('session-3', mockConfig);
      
      expect(manager.getAllSessions()).toHaveLength(3);
      expect(session1).not.toBe(session2);
      expect(session2).not.toBe(session3);
    });

    it('should get session by ID', () => {
      const createdSession = manager.getOrCreateSession('test-session-3', mockConfig);
      const retrievedSession = manager.getSession('test-session-3');
      
      expect(retrievedSession).toBe(createdSession);
      expect(manager.getSession('non-existent')).toBeUndefined();
    });
  });

  describe('session cleanup', () => {
    it('should clean up expired sessions on cleanup event', () => {
      const session = manager.getOrCreateSession('test-session-cleanup', mockConfig);
      
      expect(manager.getAllSessions()).toHaveLength(1);
      
      // Simulate session cleanup event
      session.emit('cleanup', { sessionId: 'test-session-cleanup', reason: 'test' });
      
      expect(manager.getAllSessions()).toHaveLength(0);
      expect(manager.getSession('test-session-cleanup')).toBeUndefined();
    });

    it('should clean up all sessions on stop', async () => {
      const session1 = manager.getOrCreateSession('session-stop-1', mockConfig);
      const session2 = manager.getOrCreateSession('session-stop-2', mockConfig);
      const session3 = manager.getOrCreateSession('session-stop-3', mockConfig);
      
      expect(manager.getAllSessions()).toHaveLength(3);
      
      await manager.stop();
      
      expect(session1.forceCleanup).toHaveBeenCalledWith('manager stopping');
      expect(session2.forceCleanup).toHaveBeenCalledWith('manager stopping');
      expect(session3.forceCleanup).toHaveBeenCalledWith('manager stopping');
      expect(manager.getAllSessions()).toHaveLength(0);
    });
  });

  describe('WebSocket attachment', () => {
    it('should attach WebSocket to session', () => {
      const session = manager.getOrCreateSession('test-ws', mockConfig);
      const mockWs = { 
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
        OPEN: 1
      } as any;
      
      const handler = manager.attachWebSocket(session, mockWs);
      
      expect(handler).toBeDefined();
      expect(mockWs.on).toHaveBeenCalled();
    });
  });

  describe('shared state integration', () => {
    it('should update shared state when creating sessions', () => {
      const mockSharedState = {
        setConnectionState: vi.fn(),
        logPacket: vi.fn()
      };
      
      const managerWithState = new SessionManager(mockSharedState);
      
      // Create a session that returns connected status
      vi.mocked(BleSession).mockImplementationOnce((sessionId, config, sharedState) => {
        const EventEmitter = require('events');
        const session = new EventEmitter();
        session.sessionId = sessionId;
        session.connect = vi.fn().mockResolvedValue('MockDevice');
        session.getStatus = vi.fn().mockReturnValue({
          sessionId,
          connected: true,
          deviceName: 'TestDevice',
          activeWebSockets: 1,
          idleTime: 0,
          hasGracePeriod: false,
          hasIdleTimer: false
        });
        session.forceCleanup = vi.fn().mockResolvedValue(undefined);
        session.addWebSocket = vi.fn();
        session.removeWebSocket = vi.fn();
        return session;
      });
      
      const session = managerWithState.getOrCreateSession('state-test', mockConfig);
      
      // The updateSharedState is called when session is created
      // Since session is connected, it should update shared state
      expect(mockSharedState.setConnectionState).toHaveBeenCalledWith({ 
        connected: true, 
        deviceName: 'TestDevice' 
      });
    });
  });

  describe('cleanup timer', () => {
    it('should start cleanup timer on construction', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      
      new SessionManager();
      
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
    });

    it('should clear cleanup timer on stop', async () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      
      await manager.stop();
      
      expect(clearIntervalSpy).toHaveBeenCalled();
    });
  });
});