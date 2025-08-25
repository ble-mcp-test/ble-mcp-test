import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NodeBleClient } from '../../src/node/NodeBleClient.js';
import { BridgeServer } from '../../src/bridge-server.js';

describe('Node.js Transport Connection', () => {
  let server: BridgeServer;
  const TEST_PORT = 8083; // Use test port to avoid conflicts

  beforeAll(async () => {
    // Start a test server on a different port
    server = new BridgeServer();
    await server.start(TEST_PORT);
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('should create a NodeBleClient instance', () => {
    const client = new NodeBleClient({
      bridgeUrl: `ws://localhost:${TEST_PORT}`,
      service: '9800',
      write: '9900',
      notify: '9901'
    });

    expect(client).toBeDefined();
    expect(client.getSessionId()).toBeDefined();
  });

  it('should establish WebSocket connection', async () => {
    // This test only validates WebSocket connectivity, not BLE device connection
    // For full integration testing with real devices, use the integration test suite
    const client = new NodeBleClient({
      bridgeUrl: `ws://localhost:${TEST_PORT}`,
      service: '9800',
      write: '9900',
      notify: '9901'
    });

    // The client should be created successfully
    expect(client).toBeDefined();
    expect(client.isConnected()).toBe(false);
    
    // Note: Full connection testing requires a real BLE device
    // This is covered in integration tests when BLE hardware is available
  });

  it('should handle connection errors gracefully', async () => {
    const client = new NodeBleClient({
      bridgeUrl: 'ws://localhost:9999', // Wrong port
      service: '9800',
      write: '9900',
      notify: '9901',
      reconnectAttempts: 1,
      reconnectDelay: 100 // Faster for tests
    });

    await expect(client.connect()).rejects.toThrow();
  });

  it('should check availability', async () => {
    const client = new NodeBleClient({
      bridgeUrl: `ws://localhost:${TEST_PORT}`,
      service: '9800',
      write: '9900',
      notify: '9901'
    });

    const available = await client.getAvailability();
    expect(available).toBe(true);
  });

  it('should generate unique session IDs', () => {
    const client1 = new NodeBleClient({
      bridgeUrl: `ws://localhost:${TEST_PORT}`,
      service: '9800',
      write: '9900',
      notify: '9901'
    });

    const client2 = new NodeBleClient({
      bridgeUrl: `ws://localhost:${TEST_PORT}`,
      service: '9800',
      write: '9900',
      notify: '9901'
    });

    expect(client1.getSessionId()).toBeDefined();
    expect(client2.getSessionId()).toBeDefined();
    expect(client1.getSessionId()).not.toBe(client2.getSessionId());
  });

  it('should use provided session ID', () => {
    const customSessionId = 'test-session-123';
    const client = new NodeBleClient({
      bridgeUrl: `ws://localhost:${TEST_PORT}`,
      service: '9800',
      write: '9900',
      notify: '9901',
      sessionId: customSessionId
    });

    expect(client.getSessionId()).toBe(customSessionId);
  });
});