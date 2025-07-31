import { EventEmitter } from 'events';
import noble from '@stoprocent/noble';
import { translateBluetoothError } from './bluetooth-errors.js';
import { cleanupNoble, withTimeout } from './utils.js';

/**
 * Noble BLE Transport
 * 
 * Handles all BLE device communication.
 * No state management, just pure BLE operations.
 * 
 * Events:
 * - 'data': (data: Uint8Array) - Notification received from device
 * - 'disconnect': () - Device disconnected
 * - 'error': (error: any) - Transport error occurred
 */

export interface BleConfig {
  devicePrefix: string;
  serviceUuid: string;
  writeUuid: string;
  notifyUuid: string;
}

export class NobleTransport extends EventEmitter {
  private peripheral: any = null;
  private writeChar: any = null;
  private notifyChar: any = null;

  async connect(config: BleConfig): Promise<string> {
    try {
      // Wait for Noble to be ready
      if (noble.state !== 'poweredOn') {
        console.log(`[Noble] State: ${noble.state}, waiting for power on...`);
        await noble.waitForPoweredOnAsync();
      }
      
      // Stop any existing scan (no-op if not scanning)
      await noble.stopScanningAsync();
      
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
        this.emit('data', new Uint8Array(data));
      });
      
      await this.notifyChar.subscribeAsync();
      
      // Handle unexpected disconnect
      this.peripheral.once('disconnect', () => {
        console.log(`[Noble] Device disconnected`);
        this.emit('disconnect');
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
    // Stop scanning (no-op if not scanning)
    await noble.stopScanningAsync();
    
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
    
    // Remove all listeners
    this.removeAllListeners();
    
    // Clean up Noble
    await cleanupNoble();
  }
}