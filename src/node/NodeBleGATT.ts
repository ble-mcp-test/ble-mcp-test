import { NodeBleService } from './NodeBleService.js';
import type { NodeBleDevice } from './NodeBleDevice.js';
import type { NodeBleClient } from './NodeBleClient.js';

export class NodeBleGATT {
  private _connected: boolean = false;
  private services: Map<string, NodeBleService> = new Map();

  constructor(
    private device: NodeBleDevice,
    private client: NodeBleClient
  ) {}

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<NodeBleGATT> {
    if (this._connected) {
      return this;
    }

    if (!this.client.isConnected()) {
      throw new Error('Client not connected to bridge');
    }

    // The WebSocket connection is already established via the client
    // Just mark as connected
    this._connected = true;
    
    return this;
  }

  async disconnect(): Promise<void> {
    if (!this._connected) {
      return;
    }

    // Clean up services
    this.services.clear();
    
    // Mark as disconnected
    this._connected = false;
    
    // Trigger disconnect event on device
    this.device.handleDisconnect();
  }

  async getPrimaryService(serviceUuid: string): Promise<NodeBleService> {
    if (!this._connected) {
      throw new Error('GATT Server not connected');
    }

    // Normalize UUID (remove dashes, lowercase)
    const normalizedUuid = serviceUuid.toLowerCase().replace(/-/g, '');
    
    // Check if service already exists
    let service = this.services.get(normalizedUuid);
    
    if (!service) {
      // Create new service
      service = new NodeBleService(this, normalizedUuid, this.device, this.client);
      this.services.set(normalizedUuid, service);
    }

    return service;
  }

  async getPrimaryServices(): Promise<NodeBleService[]> {
    if (!this._connected) {
      throw new Error('GATT Server not connected');
    }

    // For simplicity, return services that have been requested
    // In a real implementation, this would query the device
    return Array.from(this.services.values());
  }

  // Internal method called when connection is lost
  handleDisconnect(): void {
    this._connected = false;
    this.services.clear();
  }
}