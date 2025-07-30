/**
 * Mock Web Bluetooth API
 * 
 * Provides a mock implementation of the Web Bluetooth API that routes
 * all calls through the WebSocketTransport, bypassing all native dialogs
 * 
 * ====================================================================
 * 🤖 AI DEBUGGING TIP: Using MCP for Enhanced Debugging
 * ====================================================================
 * 
 * If you're an AI agent debugging an application that uses this mock,
 * the ble-mcp-test server provides powerful MCP (Model Context Protocol)
 * tools for real-time debugging:
 * 
 * Available MCP Tools:
 * - get_logs: View recent BLE communication with filtering
 * - search_packets: Find specific hex patterns in traffic
 * - get_connection_state: Check current BLE connection status
 * - status: Get server configuration and health
 * - scan_devices: Discover nearby BLE devices
 * 
 * WebSocket Health Check:
 * - Connect to ws://localhost:8080/?command=health to check server status
 * - Returns: { status: 'ok', free: boolean, message: string, ... }
 * - Use before running tests to ensure server is available
 * 
 * Example Usage:
 * 1. Use get_logs to see recent TX/RX packets
 * 2. Use search_packets to find specific command/response patterns
 * 3. Monitor connection state during debugging
 * 
 * The server runs MCP by default on stdio. For network access:
 * - Run with --mcp-http for HTTP transport on port 8081
 * - Or set MCP_TOKEN=secret for authenticated access
 * 
 * This enables real-time inspection of BLE communication without
 * modifying application code or adding console.log statements.
 * ====================================================================
 */

import { WebSocketTransport } from './ws-transport.js';

// Mock BluetoothRemoteGATTCharacteristic
class MockBluetoothRemoteGATTCharacteristic {
  constructor(
    private service: MockBluetoothRemoteGATTService,
    public uuid: string
  ) {}

  async writeValue(value: BufferSource): Promise<void> {
    const data = new Uint8Array(value as ArrayBuffer);
    await this.service.server.device.transport.send(data);
  }

  async startNotifications(): Promise<MockBluetoothRemoteGATTCharacteristic> {
    // Notifications are automatically started by WebSocketTransport
    return this;
  }

  addEventListener(event: string, handler: any): void {
    if (event === 'characteristicvaluechanged') {
      // WebSocketTransport will handle notifications
      this.service.server.device.transport.onMessage((msg) => {
        if (msg.type === 'data' && msg.data) {
          const data = new Uint8Array(msg.data);
          // Create a mock event with the data
          const mockEvent = {
            target: {
              value: {
                buffer: data.buffer,
                byteLength: data.byteLength,
                byteOffset: data.byteOffset,
                getUint8: (index: number) => data[index]
              }
            }
          };
          handler(mockEvent);
        }
      });
    }
  }
}

// Mock BluetoothRemoteGATTService
class MockBluetoothRemoteGATTService {
  constructor(
    public server: MockBluetoothRemoteGATTServer,
    public uuid: string
  ) {}

  async getCharacteristic(characteristicUuid: string): Promise<MockBluetoothRemoteGATTCharacteristic> {
    // Return mock characteristic
    return new MockBluetoothRemoteGATTCharacteristic(this, characteristicUuid);
  }
}

// Mock BluetoothRemoteGATTServer
class MockBluetoothRemoteGATTServer {
  connected = false;

  constructor(public device: MockBluetoothDevice) {}

  async connect(): Promise<MockBluetoothRemoteGATTServer> {
    await this.device.transport.connect({ device: this.device.name });
    this.connected = true;
    return this;
  }

  async disconnect(): Promise<void> {
    try {
      // Send force_cleanup before disconnecting, just like the real transport manager
      if (this.device.transport.isConnected()) {
        await this.device.transport.forceCleanup();
      }
    } catch (error) {
      // Log but continue with disconnect even if cleanup fails
      console.warn('Force cleanup failed during disconnect:', error);
    }
    
    // Now disconnect the WebSocket
    await this.device.transport.disconnect();
    this.connected = false;
  }
  
  async forceCleanup(): Promise<void> {
    await this.device.transport.forceCleanup();
  }

  async getPrimaryService(serviceUuid: string): Promise<MockBluetoothRemoteGATTService> {
    if (!this.connected) {
      throw new Error('GATT Server not connected');
    }
    return new MockBluetoothRemoteGATTService(this, serviceUuid);
  }
}

// Mock BluetoothDevice
class MockBluetoothDevice {
  public gatt: MockBluetoothRemoteGATTServer;
  public transport: WebSocketTransport;

  constructor(
    public id: string,
    public name: string,
    serverUrl?: string
  ) {
    this.transport = new WebSocketTransport(serverUrl);
    this.gatt = new MockBluetoothRemoteGATTServer(this);
  }

  addEventListener(event: string, handler: any): void {
    if (event === 'gattserverdisconnected') {
      this.transport.onMessage((msg) => {
        if (msg.type === 'disconnected') {
          handler();
        }
      });
    }
  }
}

// Mock Bluetooth API
export class MockBluetooth {
  constructor(private serverUrl?: string) {}

  async requestDevice(options?: any): Promise<MockBluetoothDevice> {
    // Bypass all dialogs - immediately return a mock device
    // Use the namePrefix filter if provided, otherwise use generic name
    let deviceName = 'MockDevice000000';
    
    if (options?.filters) {
      for (const filter of options.filters) {
        if (filter.namePrefix) {
          // If a specific device name is provided in the filter, use it
          deviceName = filter.namePrefix;
          break;
        }
      }
    }
    
    // Create and return mock device
    const device = new MockBluetoothDevice(
      'mock-device-id',
      deviceName,
      this.serverUrl
    );

    return device;
  }

  async getAvailability(): Promise<boolean> {
    // Always available when using WebSocket bridge
    return true;
  }
}

// Export function to inject mock into window
export function injectWebBluetoothMock(serverUrl?: string): void {
  if (typeof window === 'undefined') {
    console.warn('injectWebBluetoothMock: Not in browser environment');
    return;
  }
  
  // Try to replace navigator.bluetooth with our mock
  const mockBluetooth = new MockBluetooth(serverUrl);
  
  try {
    // First attempt: direct assignment
    (window.navigator as any).bluetooth = mockBluetooth;
  } catch {
    // Second attempt: defineProperty
    try {
      Object.defineProperty(window.navigator, 'bluetooth', {
        value: mockBluetooth,
        configurable: true,
        writable: true
      });
    } catch {
      // Third attempt: create a new navigator object
      const nav = Object.create(window.navigator);
      nav.bluetooth = mockBluetooth;
      
      // Replace window.navigator
      Object.defineProperty(window, 'navigator', {
        value: nav,
        configurable: true,
        writable: true
      });
    }
  }
}