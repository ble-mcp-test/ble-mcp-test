import noble from '@stoprocent/noble';
import { translateBluetoothError } from './bluetooth-errors.js';
import { cleanupNoble, withTimeout } from './utils.js';

/**
 * Noble BLE Transport
 * 
 * Handles all BLE device communication.
 * No state management, just pure BLE operations.
 */

export interface BleConfig {
  devicePrefix: string;
  serviceUuid: string;
  writeUuid: string;
  notifyUuid: string;
}

export interface BleCallbacks {
  onData: (data: Uint8Array) => void;
  onDisconnect: () => void;
  onError: (error: any) => void;
}

export class NobleTransport {
  private peripheral: any = null;
  private writeChar: any = null;
  private notifyChar: any = null;
  private callbacks: BleCallbacks | null = null;

  async connect(config: BleConfig, callbacks: BleCallbacks): Promise<string> {
    this.callbacks = callbacks;
    
    try {
      // Wait for Noble to be ready
      if (noble.state !== 'poweredOn') {
        console.log(`[Noble] State: ${noble.state}, waiting for power on...`);
        await noble.waitForPoweredOnAsync();
      }
      
      // Always stop any existing scan first
      console.log(`[Noble] Ensuring clean scan state...`);
      await noble.stopScanningAsync().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 500)); // Let it settle
      
      // Scan for device
      console.log(`[Noble] Starting BLE scan for ${config.devicePrefix}...`);
      await noble.startScanningAsync([], true); // allowDuplicates: true is critical for CS108 on Linux
      
      this.peripheral = await this.findDevice(config.devicePrefix);
      const deviceName = this.peripheral.advertisement.localName || this.peripheral.id;
      
      // Connect to peripheral
      console.log(`[Noble] Connecting to ${deviceName}...`);
      await this.peripheral.connectAsync();
      
      // Find service and characteristics
      const services = await this.peripheral.discoverServicesAsync();
      const targetService = services.find((s: any) => 
        s.uuid === config.serviceUuid || 
        s.uuid === config.serviceUuid.toLowerCase().replace(/-/g, '')
      );
      
      if (!targetService) {
        throw new Error(`Service ${config.serviceUuid} not found`);
      }
      
      const characteristics = await targetService.discoverCharacteristicsAsync();
      
      this.writeChar = characteristics.find((c: any) => 
        c.uuid === config.writeUuid || 
        c.uuid === config.writeUuid.toLowerCase().replace(/-/g, '')
      );
      
      this.notifyChar = characteristics.find((c: any) => 
        c.uuid === config.notifyUuid || 
        c.uuid === config.notifyUuid.toLowerCase().replace(/-/g, '')
      );
      
      if (!this.writeChar || !this.notifyChar) {
        throw new Error('Required characteristics not found');
      }
      
      // Subscribe to notifications
      this.notifyChar.on('data', (data: Buffer) => {
        if (this.callbacks) {
          this.callbacks.onData(new Uint8Array(data));
        }
      });
      
      await this.notifyChar.subscribeAsync();
      
      // Handle unexpected disconnect
      this.peripheral.once('disconnect', () => {
        console.log(`[Noble] Device disconnected`);
        if (this.callbacks) {
          this.callbacks.onDisconnect();
        }
      });
      
      console.log(`[Noble] Connected successfully to ${deviceName}`);
      return deviceName;
      
    } catch (error) {
      // Clean up on error
      await this.cleanup();
      throw error;
    }
  }

  private async findDevice(devicePrefix: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        noble.removeListener('discover', onDiscover);
        noble.stopScanningAsync();
        reject(new Error(`Device ${devicePrefix} not found`));
      }, 15000);
      
      const onDiscover = (device: any) => {
        const name = device.advertisement.localName || '';
        const id = device.id;
        
        if ((name && name.startsWith(devicePrefix)) || id === devicePrefix) {
          clearTimeout(timeout);
          noble.removeListener('discover', onDiscover);
          noble.stopScanningAsync();
          resolve(device);
        }
      };
      
      noble.on('discover', onDiscover);
    });
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writeChar) {
      throw new Error('Not connected');
    }
    await this.writeChar.writeAsync(Buffer.from(data), false);
  }

  async disconnect(): Promise<void> {
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    // Stop scanning
    await noble.stopScanningAsync().catch(() => {});
    
    // Unsubscribe and disconnect
    if (this.notifyChar) {
      await this.notifyChar.unsubscribeAsync().catch(() => {});
      this.notifyChar.removeAllListeners();
    }
    
    if (this.peripheral) {
      await this.peripheral.disconnectAsync().catch(() => {});
      this.peripheral.removeAllListeners();
    }
    
    // Clear references
    this.peripheral = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.callbacks = null;
    
    // Clean up Noble
    await cleanupNoble();
  }
}