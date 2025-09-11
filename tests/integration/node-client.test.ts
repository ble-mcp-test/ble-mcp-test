import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import { NodeBleClient } from '../../src/node/NodeBleClient';

// Test configuration - EXACT same session ID as E2E tests to reuse cached session
const TEST_CONFIG = {
  sessionId: `ble-mcp-e2e-${os.hostname()}`,  // MUST match E2E exactly for session reuse
  bridgeUrl: process.env.BLE_MCP_WS_URL || 'ws://localhost:8080',
  service: process.env.BLE_MCP_SERVICE_UUID || '9800',
  write: process.env.BLE_MCP_WRITE_UUID || '9900',
  notify: process.env.BLE_MCP_NOTIFY_UUID || '9901',
  timeout: 30000
};

// Test if awaiting response is sufficient for command serialization
// No artificial delays - let the device response timing be natural

// Device-specific test command from E2E config
const TEST_COMMAND_BYTES = new Uint8Array([0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x01]);
const TEST_RESPONSE_VALIDATION = {
  expectedLength: 11,
  expectedBytes: { 8: 0xA0, 9: 0x01, 10: 0x00 }
};

/**
 * Test command helper adapted for NodeBleClient
 * Replicates the functionality of testCommandHelper from E2E tests
 */
async function testCommandHelper(client: NodeBleClient): Promise<boolean> {
  // Test: Just await the response, no artificial spacing
  return new Promise((resolve) => {
    let responseReceived = false;
    const timeout = setTimeout(() => {
      if (!responseReceived) {
        resolve(false);
      }
    }, 5000);

    // Set up notification handler
    client.onNotification((data: Uint8Array) => {
      if (responseReceived) return; // Prevent multiple responses
      responseReceived = true;
      clearTimeout(timeout);

      // Validate response structure: device may return success (11 bytes) or error (12 bytes)
      // Both indicate successful communication path
      if (data.length < 10 || data[0] !== 0xA7 || data[1] !== 0xB3) {
        resolve(false);
        return;
      }

      // Accept both success and error responses as valid communication
      resolve(true);
    });

    // Send test command
    client.writeValue(TEST_COMMAND_BYTES).catch(() => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
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
      expect(() => new NodeBleClient({
        // @ts-expect-error - Missing sessionId for test
        bridgeUrl: TEST_CONFIG.bridgeUrl,
        service: TEST_CONFIG.service,
        write: TEST_CONFIG.write,
        notify: TEST_CONFIG.notify
      })).toThrow('sessionId is required');
    });

    it('should require service/write/notify parameters', () => {
      expect(() => new NodeBleClient({
        sessionId: 'test',
        bridgeUrl: TEST_CONFIG.bridgeUrl
        // Missing service, write, notify
      })).toThrow('service, write, and notify parameters are required');
    });

    it('should accept optional deviceId and deviceName', () => {
      expect(() => new NodeBleClient({
        sessionId: 'test',
        bridgeUrl: TEST_CONFIG.bridgeUrl,
        service: TEST_CONFIG.service,
        write: TEST_CONFIG.write,
        notify: TEST_CONFIG.notify,
        deviceId: process.env.BLE_MCP_DEVICE_IDENTIFIER,
        deviceName: 'Test Device',
        debug: true
      })).not.toThrow();
    });
  });

  describe('service-based discovery', () => {
    it('should connect using service-only discovery (no device filtering)', async () => {
      client = new NodeBleClient({
        sessionId: TEST_CONFIG.sessionId,  // Use shared session
        bridgeUrl: TEST_CONFIG.bridgeUrl,
        service: TEST_CONFIG.service,
        write: TEST_CONFIG.write,
        notify: TEST_CONFIG.notify,
        debug: true
      });

      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Test command execution to verify full communication path
      const result = await testCommandHelper(client);
      expect(result).toBe(true);
    }, TEST_CONFIG.timeout);

    it('should handle optional device filtering with deviceId', async () => {
      const deviceId = process.env.BLE_MCP_DEVICE_IDENTIFIER;
      
      // Skip if no device ID specified
      if (!deviceId) {
        console.log('Skipping deviceId test - BLE_MCP_DEVICE_IDENTIFIER not set');
        return;
      }

      client = new NodeBleClient({
        sessionId: TEST_CONFIG.sessionId,  // Use shared session
        bridgeUrl: TEST_CONFIG.bridgeUrl,
        service: TEST_CONFIG.service,
        write: TEST_CONFIG.write,
        notify: TEST_CONFIG.notify,
        deviceId: deviceId,
        debug: true
      });

      await client.connect();
      expect(client.isConnected()).toBe(true);

      const result = await testCommandHelper(client);
      expect(result).toBe(true);
    }, TEST_CONFIG.timeout);

    it('should handle optional device filtering with deviceName', async () => {
      const deviceName = process.env.BLE_MCP_DEVICE_NAME;
      
      // Skip if no device name specified
      if (!deviceName) {
        console.log('Skipping deviceName test - BLE_MCP_DEVICE_NAME not set');
        return;
      }

      client = new NodeBleClient({
        sessionId: TEST_CONFIG.sessionId,  // Use shared session
        bridgeUrl: TEST_CONFIG.bridgeUrl,
        service: TEST_CONFIG.service,
        write: TEST_CONFIG.write,
        notify: TEST_CONFIG.notify,
        deviceName: deviceName,
        debug: true
      });

      await client.connect();
      expect(client.isConnected()).toBe(true);

      const result = await testCommandHelper(client);
      expect(result).toBe(true);
    }, TEST_CONFIG.timeout);
  });

  describe('error handling', () => {
    it('should handle bridge not running error', async () => {
      client = new NodeBleClient({
        sessionId: 'test-error-session',
        bridgeUrl: 'ws://localhost:9999', // Non-existent bridge
        service: TEST_CONFIG.service,
        write: TEST_CONFIG.write,
        notify: TEST_CONFIG.notify
      });

      await expect(client.connect()).rejects.toThrow();
    }, 10000);

    it('should handle writeValue when not connected', async () => {
      client = new NodeBleClient({
        sessionId: 'test-write-error',
        bridgeUrl: TEST_CONFIG.bridgeUrl,
        service: TEST_CONFIG.service,
        write: TEST_CONFIG.write,
        notify: TEST_CONFIG.notify
      });

      // Don't connect
      await expect(client.writeValue(new Uint8Array([1, 2, 3]))).rejects.toThrow('Client not connected to bridge');
    });
  });

  describe('session reuse', () => {
    it('should handle session reuse without characteristic staleness', async () => {
      
      // First client
      const client1 = new NodeBleClient({
        sessionId: TEST_CONFIG.sessionId,  // Use base session
        bridgeUrl: TEST_CONFIG.bridgeUrl,
        service: TEST_CONFIG.service,
        write: TEST_CONFIG.write,
        notify: TEST_CONFIG.notify,
        debug: true
      });

      await client1.connect();
      expect(client1.isConnected()).toBe(true);

      // Test command works
      const result1 = await testCommandHelper(client1);
      expect(result1).toBe(true);

      // Disconnect first client
      await client1.disconnect();
      expect(client1.isConnected()).toBe(false);

      // Second client reusing same session
      client = new NodeBleClient({
        sessionId: TEST_CONFIG.sessionId,  // Same session for reuse test
        bridgeUrl: TEST_CONFIG.bridgeUrl,
        service: TEST_CONFIG.service,
        write: TEST_CONFIG.write,
        notify: TEST_CONFIG.notify,
        debug: true
      });

      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Test command should still work (no stale characteristics)
      const result2 = await testCommandHelper(client);
      expect(result2).toBe(true);
    }, TEST_CONFIG.timeout);
  });

  describe('simplified API', () => {
    beforeEach(async () => {
      client = new NodeBleClient({
        sessionId: TEST_CONFIG.sessionId,  // Use shared session
        bridgeUrl: TEST_CONFIG.bridgeUrl,
        service: TEST_CONFIG.service,
        write: TEST_CONFIG.write,
        notify: TEST_CONFIG.notify,
        debug: true
      });
      await client.connect();
    });

    it('should support direct writeValue method', async () => {
      const testData = new Uint8Array([0x01, 0x02, 0x03]);
      
      // Should not throw - no response expected for this test command
      await expect(client.writeValue(testData)).resolves.not.toThrow();
    });

    it('should support direct onNotification method', async () => {
      let notificationReceived = false;
      let receivedData: Uint8Array | null = null;

      client.onNotification((data: Uint8Array) => {
        notificationReceived = true;
        receivedData = data;
      });

      // Send test command to trigger notification
      await client.writeValue(TEST_COMMAND_BYTES);

      // Wait for notification (reasonable timeout, not artificial spacing)
      await new Promise(resolve => setTimeout(resolve, 2000));

      expect(notificationReceived).toBe(true);
      expect(receivedData).not.toBeNull();
      if (receivedData) {
        // Validate we got a device response with correct protocol headers
        expect(receivedData.length).toBeGreaterThanOrEqual(10); // Reasonable response size
        expect(receivedData[0]).toBe(0xA7); // Protocol header byte 1
        expect(receivedData[1]).toBe(0xB3); // Protocol header byte 2  
        // This proves NodeBleClient → Bridge → Hardware → Bridge → NodeBleClient path works
      }
    });
  });
});