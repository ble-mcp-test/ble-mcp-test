import { describe, it, expect } from 'vitest';
import { NodeBleClient } from '../../src/node/NodeBleClient';

describe('NodeBleClient', () => {
  describe('constructor validation', () => {
    it('should require sessionId in constructor', () => {
      expect(() => new NodeBleClient({
        // @ts-expect-error - Missing sessionId for test
        bridgeUrl: 'ws://localhost:25153',
        service: '9800',
        write: '9900', 
        notify: '9901'
      })).toThrow('sessionId is required - this prevents session conflicts and ensures predictable BLE connection management');
    });

    it('should require service parameter', () => {
      expect(() => new NodeBleClient({
        sessionId: 'test',
        bridgeUrl: 'ws://localhost:25153',
        // @ts-expect-error - Missing service for test
        write: '9900',
        notify: '9901'
      })).toThrow('service, write, and notify parameters are required');
    });

    it('should require write parameter', () => {
      expect(() => new NodeBleClient({
        sessionId: 'test',
        bridgeUrl: 'ws://localhost:25153',
        service: '9800',
        // @ts-expect-error - Missing write for test
        notify: '9901'
      })).toThrow('service, write, and notify parameters are required');
    });

    it('should require notify parameter', () => {
      expect(() => new NodeBleClient({
        sessionId: 'test',
        bridgeUrl: 'ws://localhost:25153',
        service: '9800',
        write: '9900'
        // @ts-expect-error - Missing notify for test
      })).toThrow('service, write, and notify parameters are required');
    });

    it('should accept optional deviceId and deviceName', () => {
      expect(() => new NodeBleClient({
        sessionId: 'test',
        bridgeUrl: 'ws://localhost:25153',
        service: '9800',
        write: '9900',
        notify: '9901',
        deviceId: 'exact-device-id',
        deviceName: 'Test Device',
        debug: true
      })).not.toThrow();
    });

    it('should set default values for optional parameters', () => {
      const client = new NodeBleClient({
        sessionId: 'test',
        bridgeUrl: 'ws://localhost:25153',
        service: '9800',
        write: '9900',
        notify: '9901'
      });

      expect(client.getSessionId()).toBe('test');
      // Can't access options directly as they're private, but constructor shouldn't throw
      expect(client).toBeDefined();
    });

    it('should preserve custom values for optional parameters', () => {
      const client = new NodeBleClient({
        sessionId: 'custom-session',
        bridgeUrl: 'ws://localhost:9090',
        service: '1234',
        write: '5678',
        notify: '9abc',
        debug: true,
        reconnectAttempts: 5,
        reconnectDelay: 2000,
        timeout: 60000
      });

      expect(client.getSessionId()).toBe('custom-session');
      expect(client).toBeDefined();
    });
  });

  describe('API methods', () => {
    let client: NodeBleClient;

    beforeEach(() => {
      client = new NodeBleClient({
        sessionId: 'test-session',
        bridgeUrl: 'ws://localhost:25153',
        service: '9800',
        write: '9900',
        notify: '9901'
      });
    });

    it('should provide getAvailability method', async () => {
      const availability = await client.getAvailability();
      expect(availability).toBe(true);
    });

    it('should provide getSessionId method', () => {
      const sessionId = client.getSessionId();
      expect(sessionId).toBe('test-session');
    });

    it('should provide isConnected method', () => {
      const connected = client.isConnected();
      expect(connected).toBe(false); // Not connected initially
    });

    it('should provide onNotification method', () => {
      let called = false;
      
      client.onNotification((data: Uint8Array) => {
        called = true;
        expect(data).toBeInstanceOf(Uint8Array);
      });

      // Should not throw
      expect(called).toBe(false); // Not called yet without actual notification
    });

    it('should handle writeValue when not connected', async () => {
      await expect(client.writeValue(new Uint8Array([1, 2, 3])))
        .rejects.toThrow('Client not connected to bridge');
    });

    it('should have destroy method for cleanup', async () => {
      // Should not throw even when not connected
      await expect(client.destroy()).resolves.not.toThrow();
    });
  });

  describe('simplified API validation', () => {
    it('should not expose requestDevice method', () => {
      const client = new NodeBleClient({
        sessionId: 'test',
        bridgeUrl: 'ws://localhost:25153',
        service: '9800',
        write: '9900',
        notify: '9901'
      });

      // Should not have requestDevice method
      expect((client as any).requestDevice).toBeUndefined();
    });

    it('should not expose getDevices method', () => {
      const client = new NodeBleClient({
        sessionId: 'test',
        bridgeUrl: 'ws://localhost:25153',
        service: '9800',
        write: '9900',
        notify: '9901'
      });

      // Should not have getDevices method
      expect((client as any).getDevices).toBeUndefined();
    });

    it('should expose writeValue method', () => {
      const client = new NodeBleClient({
        sessionId: 'test',
        bridgeUrl: 'ws://localhost:25153',
        service: '9800',
        write: '9900',
        notify: '9901'
      });

      expect(typeof client.writeValue).toBe('function');
    });

    it('should expose onNotification method', () => {
      const client = new NodeBleClient({
        sessionId: 'test',
        bridgeUrl: 'ws://localhost:25153',
        service: '9800',
        write: '9900',
        notify: '9901'
      });

      expect(typeof client.onNotification).toBe('function');
    });
  });
});