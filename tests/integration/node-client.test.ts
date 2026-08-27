import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NodeBleClient } from '../../src/node/NodeBleClient';
import {
  TEST_COMMAND_BYTES,
  TEST_RESPONSE_VALIDATION,
  SHARED_TEST_CONFIG,
  createNodeClientConfig,
  isValidTestResponse,
  isValidDeviceResponse,
  formatResponseHex
} from '../shared/index.js';

/**
 * Test command helper adapted for NodeBleClient
 * Uses the new sendCommandAsync method for simplified command/response pattern
 */
async function testCommandHelper(client: NodeBleClient): Promise<boolean> {
  try {
    const response = await client.sendCommandAsync(TEST_COMMAND_BYTES);
    
    // Validate response using shared validation logic
    if (isValidTestResponse(response)) {
      return true; // Perfect test response
    }
    
    // Still accept any valid device response as proof of communication
    return isValidDeviceResponse(response);
  } catch (error) {
    return false;
  }
}

describe('NodeBleClient integration', () => {
  let client: NodeBleClient;

  afterEach(async () => {
    if (client && client.isConnected()) {
      await client.disconnect();
    }
  });

  describe('constructor validation', () => {
    it('should require sessionId in constructor', () => {
      // @ts-expect-error - Missing sessionId for test
      expect(() => new NodeBleClient({
        bridgeUrl: SHARED_TEST_CONFIG.wsUrl,
        service: SHARED_TEST_CONFIG.service,
        write: SHARED_TEST_CONFIG.write,
        notify: SHARED_TEST_CONFIG.notify
      })).toThrow('sessionId is required');
    });

    it('should require service/write/notify parameters', () => {
      // @ts-expect-error - Missing service, write and notify for test
      expect(() => new NodeBleClient({
        sessionId: 'test',
        bridgeUrl: SHARED_TEST_CONFIG.wsUrl
        // Missing service, write, notify
      })).toThrow('service, write, and notify parameters are required');
    });

    it('should accept optional deviceId and deviceName', () => {
      expect(() => new NodeBleClient({
        sessionId: 'test',
        bridgeUrl: SHARED_TEST_CONFIG.wsUrl,
        service: SHARED_TEST_CONFIG.service,
        write: SHARED_TEST_CONFIG.write,
        notify: SHARED_TEST_CONFIG.notify,
        deviceId: process.env.BLE_MCP_DEVICE_IDENTIFIER,
        deviceName: 'Test Device',
        debug: true
      })).not.toThrow();
    });
  });

  describe('service-based discovery', () => {
    it('should connect using service-only discovery (no device filtering)', async () => {
      client = new NodeBleClient(createNodeClientConfig({ debug: true }));

      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Test command execution to verify full communication path
      const result = await testCommandHelper(client);
      expect(result).toBe(true);
    }, SHARED_TEST_CONFIG.timeout);

    it('should handle optional device filtering with deviceId', async () => {
      const deviceId = process.env.BLE_MCP_DEVICE_IDENTIFIER;
      
      // Skip if no device ID specified
      if (!deviceId) {
        console.log('Skipping deviceId test - BLE_MCP_DEVICE_IDENTIFIER not set');
        return;
      }

      client = new NodeBleClient(createNodeClientConfig({ 
        deviceId: deviceId,
        debug: true
      }));

      await client.connect();
      expect(client.isConnected()).toBe(true);

      const result = await testCommandHelper(client);
      expect(result).toBe(true);
    }, SHARED_TEST_CONFIG.timeout);

    it('should handle optional device filtering with deviceName', async () => {
      const deviceName = process.env.BLE_MCP_DEVICE_NAME;
      
      // Skip if no device name specified
      if (!deviceName) {
        console.log('Skipping deviceName test - BLE_MCP_DEVICE_NAME not set');
        return;
      }

      client = new NodeBleClient(createNodeClientConfig({ 
        deviceName: deviceName,
        debug: true
      }));

      await client.connect();
      expect(client.isConnected()).toBe(true);

      const result = await testCommandHelper(client);
      expect(result).toBe(true);
    }, SHARED_TEST_CONFIG.timeout);
  });

  describe('error handling', () => {
    it('should handle bridge not running error', async () => {
      client = new NodeBleClient(createNodeClientConfig({
        sessionId: 'test-error-session',
        bridgeUrl: 'ws://localhost:9999' // Non-existent bridge
      }));

      await expect(client.connect()).rejects.toThrow();
    }, 10000);

    it('should handle writeValue when not connected', async () => {
      client = new NodeBleClient(createNodeClientConfig({
        sessionId: 'test-write-error'
      }));

      // Don't connect
      await expect(client.writeValue(new Uint8Array([1, 2, 3]))).rejects.toThrow('Client not connected to bridge');
    });
  });

  describe('session reuse', () => {
    it('should handle session reuse without characteristic staleness', async () => {
      
      // First client
      const client1 = new NodeBleClient(createNodeClientConfig({ debug: true }));

      await client1.connect();
      expect(client1.isConnected()).toBe(true);

      // Test command works
      const result1 = await testCommandHelper(client1);
      expect(result1).toBe(true);

      // Disconnect first client
      await client1.disconnect();
      expect(client1.isConnected()).toBe(false);

      // Second client reusing same session
      client = new NodeBleClient(createNodeClientConfig({ debug: true }));

      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Test command should still work (no stale characteristics)
      const result2 = await testCommandHelper(client);
      expect(result2).toBe(true);
    }, SHARED_TEST_CONFIG.timeout);
  });

  describe('simplified API', () => {
    beforeEach(async () => {
      client = new NodeBleClient(createNodeClientConfig({ debug: true }));
      await client.connect();
    });

    it('should support direct writeValue method', async () => {
      const testData = new Uint8Array([0x01, 0x02, 0x03]);
      
      // Should not throw - no response expected for this test command
      await expect(client.writeValue(testData)).resolves.not.toThrow();
    });

    it('should support sendCommandAsync method for request/response pattern', async () => {
      // Use the new sendCommandAsync method
      const receivedData = await client.sendCommandAsync(TEST_COMMAND_BYTES);

      expect(receivedData).not.toBeNull();
      // Validate we got a device response with correct protocol headers
      expect(receivedData.length).toBeGreaterThanOrEqual(10); // Reasonable response size
      expect(receivedData[0]).toBe(0xA7); // Protocol header byte 1
      expect(receivedData[1]).toBe(0xB3); // Protocol header byte 2  
      // This proves NodeBleClient → Bridge → Hardware → Bridge → NodeBleClient path works
    });
  });
});