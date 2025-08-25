import { EventEmitter } from 'events';
import type { NodeBleService } from './NodeBleService.js';
import type { NodeBleDevice } from './NodeBleDevice.js';
import type { NodeBleClient } from './NodeBleClient.js';
import type { CharacteristicEvent } from './types.js';

export class NodeBleCharacteristic extends EventEmitter {
  private _value: DataView | null = null;
  private notificationHandlers: Array<(event: CharacteristicEvent) => void> = [];
  private notificationsStarted: boolean = false;

  constructor(
    public readonly service: NodeBleService,
    public readonly uuid: string,
    private device: NodeBleDevice,
    private client: NodeBleClient
  ) {
    super();
  }

  get value(): DataView | null {
    return this._value;
  }

  async readValue(): Promise<DataView> {
    if (!this.client.isConnected()) {
      throw new Error('Not connected');
    }

    // Send read request
    const response = await this.client.sendMessage({
      type: 'read',
      characteristic: this.uuid
    });

    if (response.type === 'error') {
      throw new Error(response.error || 'Read failed');
    }

    // Convert hex data to DataView
    if (response.data) {
      const bytes = this.hexToBytes(response.data);
      const buffer = new ArrayBuffer(bytes.length);
      const view = new DataView(buffer);
      bytes.forEach((byte, index) => {
        view.setUint8(index, byte);
      });
      this._value = view;
      return view;
    }

    throw new Error('No data received');
  }

  async writeValue(value: BufferSource): Promise<void> {
    if (!this.client.isConnected()) {
      throw new Error('Not connected');
    }

    const data = new Uint8Array(value as ArrayBuffer);
    this.client.sendData(data);
  }

  async writeValueWithResponse(value: BufferSource): Promise<void> {
    // For now, same as writeValue
    // In a real implementation, this would wait for acknowledgment
    return this.writeValue(value);
  }

  async writeValueWithoutResponse(value: BufferSource): Promise<void> {
    // Same as writeValue for our implementation
    return this.writeValue(value);
  }

  async startNotifications(): Promise<NodeBleCharacteristic> {
    if (!this.client.isConnected()) {
      throw new Error('Not connected');
    }

    if (this.notificationsStarted) {
      return this;
    }

    // Send subscribe request
    const response = await this.client.sendMessage({
      type: 'subscribe',
      characteristic: this.uuid
    });

    if (response.type === 'error') {
      throw new Error(response.error || 'Failed to start notifications');
    }

    this.notificationsStarted = true;
    return this;
  }

  async stopNotifications(): Promise<NodeBleCharacteristic> {
    if (!this.client.isConnected()) {
      throw new Error('Not connected');
    }

    if (!this.notificationsStarted) {
      return this;
    }

    // Send unsubscribe request
    const response = await this.client.sendMessage({
      type: 'unsubscribe',
      characteristic: this.uuid
    });

    if (response.type === 'error') {
      throw new Error(response.error || 'Failed to stop notifications');
    }

    this.notificationsStarted = false;
    return this;
  }

  addEventListener(event: string, handler: (event: CharacteristicEvent) => void): void {
    if (event === 'characteristicvaluechanged') {
      this.notificationHandlers.push(handler);
      // Also add to EventEmitter for Node.js compatibility
      this.on('characteristicvaluechanged', handler);
    }
  }

  removeEventListener(event: string, handler: (event: CharacteristicEvent) => void): void {
    if (event === 'characteristicvaluechanged') {
      const index = this.notificationHandlers.indexOf(handler);
      if (index > -1) {
        this.notificationHandlers.splice(index, 1);
      }
      // Also remove from EventEmitter
      this.off('characteristicvaluechanged', handler);
    }
  }

  // Called by the device when a notification is received
  handleNotification(data: Uint8Array): void {
    // Convert to DataView
    const buffer = new ArrayBuffer(data.length);
    const view = new DataView(buffer);
    data.forEach((byte, index) => {
      view.setUint8(index, byte);
    });
    
    this._value = view;

    // Create event object matching Web Bluetooth API
    const event: CharacteristicEvent = {
      target: {
        value: view
      }
    } as CharacteristicEvent;

    // Trigger all handlers
    this.notificationHandlers.forEach(handler => {
      handler(event);
    });

    // Also emit for EventEmitter compatibility
    this.emit('characteristicvaluechanged', event);
  }

  private hexToBytes(hex: string): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.substr(i, 2), 16));
    }
    return bytes;
  }
}