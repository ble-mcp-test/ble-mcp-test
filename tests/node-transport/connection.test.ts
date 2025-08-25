import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NodeBleClient } from '../../src/node/NodeBleClient.js';
import { setupTestServer } from '../test-config.js';

describe('Node.js Transport Connection', () => {
  let server: any;

  beforeAll(async () => {
    server = await setupTestServer();
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('should create a NodeBleClient instance', () => {
    const client = new NodeBleClient({
      bridgeUrl: 'ws://localhost:8080',
      service: '9800',
      write: '9900',
      notify: '9901'
    });

    expect(client).toBeDefined();
    expect(client.getSessionId()).toBeDefined();
  });

  it('should connect to bridge server', async () => {
    const client = new NodeBleClient({
      bridgeUrl: 'ws://localhost:8080',
      service: '9800',
      write: '9900',
      notify: '9901'
    });

    try {
      await client.connect();
      expect(client.isConnected()).toBe(true);
      
      await client.disconnect();
      expect(client.isConnected()).toBe(false);
    } finally {
      await client.destroy();
    }
  });

  it('should handle connection errors gracefully', async () => {
    const client = new NodeBleClient({
      bridgeUrl: 'ws://localhost:9999', // Wrong port
      service: '9800',
      write: '9900',
      notify: '9901',
      reconnectAttempts: 1
    });

    await expect(client.connect()).rejects.toThrow();
  });

  it('should check availability', async () => {
    const client = new NodeBleClient({
      bridgeUrl: 'ws://localhost:8080',
      service: '9800',
      write: '9900',
      notify: '9901'
    });

    const available = await client.getAvailability();
    expect(available).toBe(true);
  });
});