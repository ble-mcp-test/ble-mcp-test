● Node.js Transport Specification for ble-mcp-test

Overview

Add a Node.js transport client to ble-mcp-test that provides Web Bluetooth API compatibility for Node.js
environments, enabling integration testing against real hardware through the bridge server.

Package Structure

ble-mcp-test/
├── src/
│   ├── web/           # Existing web mock
│   └── node/          # New Node.js transport
│       ├── index.ts
│       ├── NodeBleClient.ts
│       ├── NodeBleDevice.ts
│       ├── NodeBleGATT.ts
│       ├── NodeBleService.ts
│       ├── NodeBleCharacteristic.ts
│       └── types.ts
├── dist/
│   ├── web/           # Existing web bundle
│   └── node/          # New Node.js bundle
└── tests/
└── node-transport/
├── connection.test.ts
├── data-flow.test.ts
├── error-handling.test.ts
└── protocol-validation.test.ts

Core API Design

1. NodeBleClient Class

import { EventEmitter } from 'events';
import WebSocket from 'ws';

export interface NodeBleClientOptions {
bridgeUrl: string;
device?: string;      // Default: 'CS108'
service?: string;     // Default: '9800'
write?: string;       // Default: '9900'
notify?: string;      // Default: '9901'
sessionId?: string;   // Optional session ID for deterministic testing
debug?: boolean;      // Enable debug logging
reconnectAttempts?: number;  // Max reconnection attempts (default: 3)
reconnectDelay?: number;     // Delay between reconnects in ms (default: 1000)
}

export class NodeBleClient extends EventEmitter {
private ws: WebSocket | null = null;
private options: Required<NodeBleClientOptions>;
private devices: Map<string, NodeBleDevice> = new Map();
private connected: boolean = false;
private reconnectCount: number = 0;

    constructor(options: NodeBleClientOptions);

    // Web Bluetooth API compatibility
    async getAvailability(): Promise<boolean>;
    async requestDevice(options?: RequestDeviceOptions): Promise<NodeBleDevice>;
    getDevices(): Promise<NodeBleDevice[]>;

    // Lifecycle management
    async connect(): Promise<void>;
    async disconnect(): Promise<void>;
    async destroy(): Promise<void>;

    // Internal bridge protocol
    private sendMessage(message: BridgeMessage): Promise<BridgeResponse>;
    private handleMessage(data: string | Buffer): void;
    private handleReconnection(): Promise<void>;
}

2. NodeBleDevice Class

export class NodeBleDevice extends EventEmitter {
readonly id: string;
readonly name: string | null;
readonly gatt: NodeBleGATT;

    constructor(client: NodeBleClient, deviceInfo: DeviceInfo);

    // Web Bluetooth Device API
    addEventListener(event: 'gattserverdisconnected', handler: () => void): void;
    removeEventListener(event: 'gattserverdisconnected', handler: () => void): void;

    // Alias for EventEmitter compatibility
    on(event: 'gattserverdisconnected', handler: () => void): this;
    off(event: 'gattserverdisconnected', handler: () => void): this;
}

3. NodeBleGATT Class

export class NodeBleGATT {
private device: NodeBleDevice;
private _connected: boolean = false;
private services: Map<string, NodeBleService> = new Map();

    get connected(): boolean;

    async connect(): Promise<NodeBleGATT>;
    async disconnect(): void;
    async getPrimaryService(serviceUuid: string): Promise<NodeBleService>;
    async getPrimaryServices(): Promise<NodeBleService[]>;
}

4. NodeBleCharacteristic Class

export class NodeBleCharacteristic extends EventEmitter {
readonly uuid: string;
readonly service: NodeBleService;
private _value: DataView | null = null;

    get value(): DataView | null;

    async readValue(): Promise<DataView>;
    async writeValue(value: BufferSource): Promise<void>;
    async writeValueWithResponse(value: BufferSource): Promise<void>;
    async writeValueWithoutResponse(value: BufferSource): Promise<void>;
    async startNotifications(): Promise<NodeBleCharacteristic>;
    async stopNotifications(): Promise<NodeBleCharacteristic>;

    // Event: 'characteristicvaluechanged'
    addEventListener(event: 'characteristicvaluechanged', handler: (event: Event) => void): void;
    removeEventListener(event: 'characteristicvaluechanged', handler: (event: Event) => void): void;
}

Bridge Protocol Messages

// Client → Bridge messages
interface BridgeMessage {
type: 'connect' | 'disconnect' | 'scan' | 'write' | 'read' | 'subscribe' | 'unsubscribe';
id?: string;          // Request ID for response correlation
device?: string;      // Device name/ID
service?: string;     // Service UUID
characteristic?: string;  // Characteristic UUID
data?: string;        // Hex-encoded data for write operations
sessionId?: string;   // Session identifier
}

// Bridge → Client messages
interface BridgeResponse {
type: 'connected' | 'disconnected' | 'scan_result' | 'notification' | 'error' | 'ack';
id?: string;          // Correlates to request ID
device?: string;      // Device that sent notification
characteristic?: string;  // Source characteristic
data?: string;        // Hex-encoded data
error?: string;       // Error message if type === 'error'
devices?: DeviceInfo[];  // For scan_result
}

Usage Example

import { NodeBleClient } from 'ble-mcp-test/node';

// Create client
const client = new NodeBleClient({
bridgeUrl: 'ws://bt-sandbox.local:8080',
device: 'CS108',
service: '9800',
write: '9900',
notify: '9901',
debug: true
});

// Connect to bridge
await client.connect();

// Request device (mimics Web Bluetooth flow)
const device = await client.requestDevice({
filters: [{ name: 'CS108' }]
});

// Connect GATT
await device.gatt.connect();

// Get service and characteristics
const service = await device.gatt.getPrimaryService('9800');
const writeChar = await service.getCharacteristic('9900');
const notifyChar = await service.getCharacteristic('9901');

// Start notifications
await notifyChar.startNotifications();
notifyChar.addEventListener('characteristicvaluechanged', (event) => {
const value = event.target.value;
console.log('Received:', new Uint8Array(value.buffer));
});

// Write command
const command = new Uint8Array([0xA7, 0xB3, 0xC2, 0x00, 0x00, 0x11, 0x01, 0x00, 0x00, 0x00]);
await writeChar.writeValue(command);

// Cleanup
await device.gatt.disconnect();
await client.disconnect();

Test Suite Requirements

1. Connection Tests (connection.test.ts)

describe('NodeBleClient Connection', () => {
test('should connect to bridge server', async () => {
const client = new NodeBleClient({ bridgeUrl: 'ws://localhost:8080' });
await client.connect();
expect(client.isConnected()).toBe(true);
await client.disconnect();
});

    test('should handle connection failure gracefully', async () => {
      const client = new NodeBleClient({ bridgeUrl: 'ws://invalid:9999' });
      await expect(client.connect()).rejects.toThrow(/connection failed/i);
    });

    test('should reconnect on unexpected disconnect', async () => {
      const client = new NodeBleClient({
        bridgeUrl: 'ws://localhost:8080',
        reconnectAttempts: 2
      });
      await client.connect();

      // Simulate disconnect
      client['ws'].close();

      // Should auto-reconnect
      await new Promise(resolve => setTimeout(resolve, 2000));
      expect(client.isConnected()).toBe(true);
    });

    test('should respect sessionId for deterministic testing', async () => {
      const client1 = new NodeBleClient({
        bridgeUrl: 'ws://localhost:8080',
        sessionId: 'test-session-1'
      });
      const client2 = new NodeBleClient({
        bridgeUrl: 'ws://localhost:8080',
        sessionId: 'test-session-1'
      });

      await client1.connect();
      await client2.connect();

      // Should share same session/device
      const device1 = await client1.requestDevice();
      const device2 = await client2.requestDevice();
      expect(device1.id).toBe(device2.id);
    });
});

2. Data Flow Tests (data-flow.test.ts)

describe('NodeBleClient Data Flow', () => {
test('should write and receive notification', async () => {
const client = new NodeBleClient({ bridgeUrl: 'ws://localhost:8080' });
await client.connect();

      const device = await client.requestDevice();
      await device.gatt.connect();

      const service = await device.gatt.getPrimaryService('9800');
      const writeChar = await service.getCharacteristic('9900');
      const notifyChar = await service.getCharacteristic('9901');

      // Set up notification listener
      const notifications: Uint8Array[] = [];
      await notifyChar.startNotifications();
      notifyChar.on('characteristicvaluechanged', (event) => {
        notifications.push(new Uint8Array(event.target.value.buffer));
      });

      // Send battery voltage command
      const batteryCmd = new Uint8Array([0xA7, 0xB3, 0xC2, 0x00, 0x00, 0x11, 0x01, 0x00, 0x00, 0x00]);
      await writeChar.writeValue(batteryCmd);

      // Wait for response
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Should have received battery response
      expect(notifications.length).toBeGreaterThan(0);
      const response = notifications[0];
      expect(response[0]).toBe(0xB3); // Response prefix
      expect(response[1]).toBe(0xA7);
    });

    test('should handle binary data correctly', async () => {
      const client = new NodeBleClient({ bridgeUrl: 'ws://localhost:8080' });
      await client.connect();

      const device = await client.requestDevice();
      await device.gatt.connect();

      const service = await device.gatt.getPrimaryService('9800');
      const writeChar = await service.getCharacteristic('9900');

      // Test various data types
      const testData = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        testData[i] = i;
      }

      await writeChar.writeValue(testData);
      // Should not throw
    });
});

3. Error Handling Tests (error-handling.test.ts)

describe('NodeBleClient Error Handling', () => {
test('should handle bridge errors', async () => {
const client = new NodeBleClient({ bridgeUrl: 'ws://localhost:8080' });
await client.connect();

      // Try to connect to non-existent device
      await expect(client.requestDevice({
        filters: [{ name: 'NonExistentDevice' }]
      })).rejects.toThrow(/device not found/i);
    });

    test('should handle write errors gracefully', async () => {
      const client = new NodeBleClient({ bridgeUrl: 'ws://localhost:8080' });
      await client.connect();

      const device = await client.requestDevice();
      await device.gatt.connect();

      const service = await device.gatt.getPrimaryService('9800');
      const writeChar = await service.getCharacteristic('9900');

      // Disconnect device
      await device.gatt.disconnect();

      // Write should fail
      await expect(writeChar.writeValue(new Uint8Array([1, 2, 3])))
        .rejects.toThrow(/not connected/i);
    });

    test('should clean up resources on disconnect', async () => {
      const client = new NodeBleClient({ bridgeUrl: 'ws://localhost:8080' });
      await client.connect();

      const device = await client.requestDevice();
      await device.gatt.connect();

      let disconnectEvent = false;
      device.on('gattserverdisconnected', () => {
        disconnectEvent = true;
      });

      await client.disconnect();

      expect(disconnectEvent).toBe(true);
      expect(device.gatt.connected).toBe(false);
    });
});

4. Protocol Validation Tests (protocol-validation.test.ts)

describe('Bridge Protocol Validation', () => {
test('should send correct connect message', async () => {
// Spy on WebSocket to verify protocol
const messages: any[] = [];
const originalSend = WebSocket.prototype.send;
WebSocket.prototype.send = function(data) {
messages.push(JSON.parse(data));
return originalSend.call(this, data);
};

      const client = new NodeBleClient({
        bridgeUrl: 'ws://localhost:8080',
        device: 'CS108'
      });
      await client.connect();

      const device = await client.requestDevice();
      await device.gatt.connect();

      // Verify connect message format
      const connectMsg = messages.find(m => m.type === 'connect');
      expect(connectMsg).toMatchObject({
        type: 'connect',
        device: 'CS108'
      });

      WebSocket.prototype.send = originalSend;
    });

    test('should handle notification messages correctly', async () => {
      const client = new NodeBleClient({ bridgeUrl: 'ws://localhost:8080' });
      await client.connect();

      const device = await client.requestDevice();
      await device.gatt.connect();

      const service = await device.gatt.getPrimaryService('9800');
      const notifyChar = await service.getCharacteristic('9901');

      await notifyChar.startNotifications();

      // Simulate incoming notification from bridge
      const mockNotification = {
        type: 'notification',
        characteristic: '9901',
        data: 'B3A7C200001101000000' // Hex string
      };

      const receivedData = new Promise(resolve => {
        notifyChar.once('characteristicvaluechanged', (event) => {
          resolve(new Uint8Array(event.target.value.buffer));
        });
      });

      // Inject mock message
      client['handleMessage'](JSON.stringify(mockNotification));

      const data = await receivedData;
      expect(data).toEqual(new Uint8Array([0xB3, 0xA7, 0xC2, 0x00, 0x00, 0x11, 0x01, 0x00, 0x00, 0x00]));
    });
});

Export Configuration

Package.json exports

{
"name": "ble-mcp-test",
"exports": {
".": "./dist/index.js",
"./web": "./dist/web/index.js",
"./node": {
"types": "./dist/node/index.d.ts",
"require": "./dist/node/index.cjs",
"import": "./dist/node/index.js"
}
},
"scripts": {
"build:node": "tsup src/node/index.ts --format cjs,esm --dts --outDir dist/node",
"test:node": "vitest run tests/node-transport"
}
}

Validation Checklist for ble-mcp-test

Before deploying, ble-mcp-test should validate:

1. ✅ Connection Management
   - Connects to bridge server successfully
   - Handles reconnection on disconnect
   - Cleans up resources properly
   - Supports multiple concurrent clients
2. ✅ Web Bluetooth API Compatibility
   - requestDevice() returns correct device
   - gatt.connect() establishes connection
   - getPrimaryService() returns service
   - getCharacteristic() returns characteristic
   - writeValue() sends data correctly
   - startNotifications() receives data
3. ✅ Data Integrity
   - Binary data preserved correctly
   - Hex encoding/decoding works
   - Large packets handled (>20 bytes)
   - Fragmented responses reassembled
4. ✅ Error Handling
   - Connection failures reported properly
   - Write failures when disconnected
   - Invalid UUID errors
   - Timeout handling
5. ✅ Protocol Compliance
   - Messages match bridge protocol
   - Session ID support works
   - Device filtering works
   - Characteristic UUID mapping correct
6. ✅ Performance
   - No memory leaks
   - Handles rapid writes
   - Notification throughput adequate
   - Cleanup prevents resource exhaustion

Integration Test Example (for this project)

Once deployed, this project would use it like:

// packages/tests/integration/bridge-battery-test.ts
import { NodeBleClient } from 'ble-mcp-test/node';
import { CS108Device } from '@/packages/cs108/src/workers/CS108Device';

describe('CS108 Battery via Bridge', () => {
let client: NodeBleClient;
let transport: MessagePort;
let device: CS108Device;

    beforeEach(async () => {
      // Create bridge client
      client = new NodeBleClient({
        bridgeUrl: 'ws://bt-sandbox.local:8080',
        device: 'CS108'
      });
      await client.connect();

      // Get Web Bluetooth-like device
      const bleDevice = await client.requestDevice();
      await bleDevice.gatt.connect();

      // Create MessageChannel for worker communication
      const channel = new MessageChannel();
      transport = channel.port1;

      // Create CS108 device with transport
      device = new CS108Device();
      await device.connect(channel.port2);
    });

    test('should read battery voltage', async () => {
      const state = await device.getBatteryVoltage();
      expect(state.batteryVoltage).toBeGreaterThan(3000);
      expect(state.batteryVoltage).toBeLessThan(5000);
    });
});

This specification provides everything needed to implement the Node.js transport in ble-mcp-test. The key is
maintaining Web Bluetooth API compatibility while handling the bridge protocol correctly.