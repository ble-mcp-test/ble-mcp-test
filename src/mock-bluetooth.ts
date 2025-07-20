/**
 * Mock Web Bluetooth API
 * 
 * Provides a mock implementation of the Web Bluetooth API that routes
 * all calls through the WebSocketTransport, bypassing all native dialogs
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
    await this.device.transport.connect(this.device.name);
    this.connected = true;
    return this;
  }

  async disconnect(): Promise<void> {
    await this.device.transport.disconnect();
    this.connected = false;
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
    // Use the namePrefix filter if provided, otherwise use default
    let deviceName = 'CS108Reader000000';
    
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
  
  // Replace navigator.bluetooth with our mock
  (window.navigator as any).bluetooth = new MockBluetooth(serverUrl);
}