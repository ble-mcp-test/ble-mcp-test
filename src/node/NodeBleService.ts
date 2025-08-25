import { NodeBleCharacteristic } from './NodeBleCharacteristic.js';
import type { NodeBleGATT } from './NodeBleGATT.js';
import type { NodeBleDevice } from './NodeBleDevice.js';
import type { NodeBleClient } from './NodeBleClient.js';

export class NodeBleService {
  private characteristics: Map<string, NodeBleCharacteristic> = new Map();

  constructor(
    private server: NodeBleGATT,
    public readonly uuid: string,
    private device: NodeBleDevice,
    private client: NodeBleClient
  ) {}

  async getCharacteristic(characteristicUuid: string): Promise<NodeBleCharacteristic> {
    if (!this.server.connected) {
      throw new Error('GATT Server not connected');
    }

    // Normalize UUID (remove dashes, lowercase)
    const normalizedUuid = characteristicUuid.toLowerCase().replace(/-/g, '');
    
    // Check if characteristic already exists
    let characteristic = this.characteristics.get(normalizedUuid);
    
    if (!characteristic) {
      // Create new characteristic
      characteristic = new NodeBleCharacteristic(
        this,
        normalizedUuid,
        this.device,
        this.client
      );
      this.characteristics.set(normalizedUuid, characteristic);
      
      // Register with device for notifications
      this.device.registerCharacteristic(normalizedUuid, characteristic);
    }

    return characteristic;
  }

  async getCharacteristics(): Promise<NodeBleCharacteristic[]> {
    if (!this.server.connected) {
      throw new Error('GATT Server not connected');
    }

    // Return all characteristics that have been requested
    // In a real implementation, this would query the device
    return Array.from(this.characteristics.values());
  }
}