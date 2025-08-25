import { EventEmitter } from 'events';
import { NodeBleGATT } from './NodeBleGATT.js';
import { NodeBleCharacteristic } from './NodeBleCharacteristic.js';
import type { NodeBleClient } from './NodeBleClient.js';

export class NodeBleDevice extends EventEmitter {
  public readonly gatt: NodeBleGATT;
  private characteristics: Map<string, NodeBleCharacteristic> = new Map();
  private disconnectHandlers: Array<() => void> = [];

  constructor(
    public readonly id: string,
    public readonly name: string | null,
    private client: NodeBleClient
  ) {
    super();
    this.gatt = new NodeBleGATT(this, client);
  }

  addEventListener(event: string, handler: any): void {
    if (event === 'gattserverdisconnected') {
      this.disconnectHandlers.push(handler);
      // Also add to EventEmitter for compatibility
      this.on('gattserverdisconnected', handler);
    }
  }

  removeEventListener(event: string, handler: any): void {
    if (event === 'gattserverdisconnected') {
      const index = this.disconnectHandlers.indexOf(handler);
      if (index > -1) {
        this.disconnectHandlers.splice(index, 1);
      }
      // Also remove from EventEmitter
      this.off('gattserverdisconnected', handler);
    }
  }

  // Register a characteristic for notifications
  registerCharacteristic(uuid: string, characteristic: NodeBleCharacteristic): void {
    this.characteristics.set(uuid, characteristic);
  }

  // Unregister a characteristic
  unregisterCharacteristic(uuid: string): void {
    this.characteristics.delete(uuid);
  }

  // Handle incoming notification from WebSocket
  handleNotification(characteristicUuid: string, hexData: string): void {
    // Convert hex string to Uint8Array
    const bytes: number[] = [];
    for (let i = 0; i < hexData.length; i += 2) {
      bytes.push(parseInt(hexData.substr(i, 2), 16));
    }
    const data = new Uint8Array(bytes);

    // Find the characteristic and forward the notification
    // Try exact match first
    let characteristic = this.characteristics.get(characteristicUuid);
    
    // If not found, try to find by partial match (in case UUIDs don't match exactly)
    if (!characteristic) {
      for (const [uuid, char] of this.characteristics) {
        if (uuid.includes(characteristicUuid) || characteristicUuid.includes(uuid)) {
          characteristic = char;
          break;
        }
      }
    }

    if (characteristic) {
      characteristic.handleNotification(data);
    }
  }

  // Handle disconnection
  handleDisconnect(): void {
    // Mark GATT as disconnected
    if (this.gatt.connected) {
      this.gatt.handleDisconnect();
    }

    // Notify all listeners
    this.disconnectHandlers.forEach(handler => handler());
    this.emit('gattserverdisconnected');
  }
}