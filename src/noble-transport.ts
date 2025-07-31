import { EventEmitter } from 'events';
import noble from '@stoprocent/noble';
import { translateBluetoothError } from './bluetooth-errors.js';

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
      // Wait for Noble to be ready with timeout
      if (noble.state !== 'poweredOn') {
        console.log(`[Noble] State: ${noble.state}, waiting for power on...`);
        await this.withInternalTimeout(
          noble.waitForPoweredOnAsync(),
          15000,
          'Bluetooth adapter timeout - check if Bluetooth is enabled'
        );
      }
      
      // Find device (handles complete scanning lifecycle)
      this.peripheral = await this.findDevice(config.devicePrefix);
      const deviceName = this.peripheral.advertisement.localName || this.peripheral.id;
      
      // Connect to peripheral with timeout
      console.log(`[Noble] Connecting to ${deviceName}...`);
      await this.withInternalTimeout(
        this.peripheral.connectAsync(),
        10000,
        'Device connection timeout'
      );
      
      // Discover services with timeout
      const services: any[] = await this.withInternalTimeout(
        this.peripheral.discoverServicesAsync(),
        10000,
        'Service discovery timeout'
      );
      
      const targetService = services.find((s: any) => 
        s.uuid === config.serviceUuid || 
        s.uuid === config.serviceUuid.toLowerCase().replace(/-/g, '')
      );
      
      if (!targetService) {
        throw new Error(`Service ${config.serviceUuid} not found`);
      }
      
      // Discover characteristics with timeout
      const characteristics: any[] = await this.withInternalTimeout(
        targetService.discoverCharacteristicsAsync(),
        10000,
        'Characteristic discovery timeout'
      );
      
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
      
      // Subscribe to notifications with timeout
      await this.withInternalTimeout(
        this.notifyChar.subscribeAsync(),
        5000,
        'Notification subscription timeout'
      );
      
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

  private findDeviceCleanup: (() => void) | null = null;

  private async findDevice(devicePrefix: string): Promise<any> {
    // Ensure any previous scan is cleaned up
    if (this.findDeviceCleanup) {
      this.findDeviceCleanup();
      this.findDeviceCleanup = null;
    }
    
    // Stop any existing scan (no-op if not scanning)
    await noble.stopScanningAsync();
    
    console.log(`[Noble] Starting BLE scan for ${devicePrefix}...`);
    
    // Start scanning
    await noble.startScanningAsync([], true); // allowDuplicates: true is critical for CS108 on Linux
    
    return new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = null;
      let onDiscover: ((device: any) => void) | null = null;
      
      // Cleanup function that always runs
      const cleanupScan = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        if (onDiscover) {
          noble.removeListener('discover', onDiscover);
          onDiscover = null;
        }
        // Always try to stop scanning, ignore errors
        noble.stopScanningAsync().catch(() => {});
        this.findDeviceCleanup = null;
      };
      
      // Store cleanup function so it can be called externally if needed
      this.findDeviceCleanup = cleanupScan;
      
      timeout = setTimeout(() => {
        cleanupScan();
        reject(new Error(`Device ${devicePrefix} not found`));
      }, 15000);
      
      onDiscover = async (device: any) => {
        const name = device.advertisement.localName || '';
        const id = device.id;
        
        if ((name && name.startsWith(devicePrefix)) || id === devicePrefix) {
          cleanupScan();
          console.log(`[Noble] Found device: ${name || id}`);
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

  /**
   * Internal timeout helper that just rejects - no cleanup
   * Cleanup is handled by the main try/catch in connect()
   */
  private async withInternalTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
      })
    ]);
  }

  async disconnect(): Promise<void> {
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    // Clean up any active device search
    if (this.findDeviceCleanup) {
      this.findDeviceCleanup();
      this.findDeviceCleanup = null;
    }
    
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
    
    // Remove all transport listeners
    this.removeAllListeners();
  }
}