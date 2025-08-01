import { EventEmitter } from 'events';
import noble from '@stoprocent/noble';

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

  async resetNobleStack(): Promise<void> {
    console.log('[Noble] Resetting BLE stack for error recovery');
    
    // Force stop scanning first
    try {
      await noble.stopScanningAsync();
    } catch {
      // Ignore stop scanning errors during reset
    }
    
    // Try software reset via rfkill (less aggressive than systemctl restart)
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      console.log('[Noble] Power cycling Bluetooth radio via rfkill');
      await execAsync('sudo rfkill block bluetooth');
      await new Promise(resolve => setTimeout(resolve, 1000));
      await execAsync('sudo rfkill unblock bluetooth');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (e) {
      console.log('[Noble] rfkill failed, trying Noble internal reset:', e);
    }
    
    // Wait for Noble to detect the power cycle
    console.log('[Noble] Waiting for Noble power state recovery...');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.log('[Noble] Power state recovery timeout - continuing anyway');
        resolve();
      }, 8000);
      
      const checkState = () => {
        if (noble.state === 'poweredOn') {
          clearTimeout(timeout);
          console.log('[Noble] Noble powered on successfully');
          resolve();
        } else {
          console.log(`[Noble] Current state: ${noble.state}, waiting...`);
          setTimeout(checkState, 1000);
        }
      };
      
      // Start checking immediately
      checkState();
    });
    
    console.log('[Noble] BLE stack reset complete');
  }

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
      
      // Subscribe to notifications with retry logic
      await this.subscribeWithRetry(this.notifyChar);
      
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
      
      // Start scanning
      console.log(`[Noble] Starting BLE scan for ${devicePrefix}...`);
      noble.startScanningAsync([], true).then(() => {
        // Scanning started successfully
      }).catch((error) => {
        cleanupScan();
        reject(error);
      });
      
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

  /**
   * Subscribe to notifications with retry logic
   * Common BLE issue - retry instead of going nuclear
   */
  private async subscribeWithRetry(notifyChar: any, maxRetries: number = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Noble] Notification subscription attempt ${attempt}/${maxRetries}`);
        
        await this.withInternalTimeout(
          notifyChar.subscribeAsync(),
          15000, // Increased from 5s to 15s
          `Notification subscription timeout (attempt ${attempt}/${maxRetries})`
        );
        
        console.log(`[Noble] Notification subscription successful`);
        return; // Success!
        
      } catch (error) {
        console.log(`[Noble] Subscription attempt ${attempt} failed: ${error}`);
        
        if (attempt === maxRetries) {
          throw new Error(`Notification subscription failed after ${maxRetries} attempts: ${error}`);
        }
        
        // Exponential backoff: 1s, 2s, 4s
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.log(`[Noble] Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.cleanup();
    } catch (e) {
      console.log(`[Noble] Disconnect failed:`, e);
      throw e;
    }
  }
  
  async forceCleanup(): Promise<void> {
    console.log('[Noble] Starting aggressive cleanup for error recovery');
    
    // Remove all listeners
    if (this.peripheral) {
      this.peripheral.removeAllListeners?.();
      
      if (this.notifyChar) {
        this.notifyChar.removeAllListeners?.();
      }
      
      // Force disconnect
      try {
        (this.peripheral as any)._peripheral?.disconnect?.();
      } catch (e) {
        console.log(`[Noble] Force disconnect failed: ${e}`);
      }
    }
    
    // Clear references
    this.peripheral = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.findDeviceCleanup = null;
    
    // Reset BLE stack
    await this.resetNobleStack();
    
    // Remove transport listeners
    this.removeAllListeners();
    
    console.log('[Noble] Aggressive cleanup complete');
  }

  private async cleanup(): Promise<void> {
    console.log('[Noble] Starting graceful cleanup');
    
    // Clean up any active device search
    if (this.findDeviceCleanup) {
      this.findDeviceCleanup();
      this.findDeviceCleanup = null;
    }
    
    // Stop scanning
    await noble.stopScanningAsync();
    
    // Graceful disconnect sequence
    if (this.peripheral) {
      // Remove listeners first to prevent event loops during cleanup
      this.peripheral.removeAllListeners?.();
      
      try {
        // Try graceful unsubscribe first
        if (this.notifyChar) {
          await Promise.race([
            this.notifyChar.unsubscribeAsync(),
            new Promise(resolve => setTimeout(resolve, 1000))
          ]);
        }
        
        // Try graceful disconnect
        await Promise.race([
          this.peripheral.disconnectAsync(),
          new Promise(resolve => setTimeout(resolve, 2000))
        ]);
      } catch (e) {
        console.log(`[Noble] Graceful disconnect failed: ${e}`);
        // Force disconnect as fallback
        try {
          (this.peripheral as any)._peripheral?.disconnect?.();
          await new Promise(resolve => setTimeout(resolve, 3000));
        } catch (forceError) {
          console.log(`[Noble] Force disconnect also failed: ${forceError}`);
        }
      }
    }
    
    // Clear notification handler after peripheral cleanup
    if (this.notifyChar) {
      this.notifyChar.removeAllListeners?.();
    }
    
    // Clear references
    this.peripheral = null;
    this.writeChar = null;
    this.notifyChar = null;
    
    // Remove all transport listeners
    this.removeAllListeners();
    
    console.log('[Noble] Graceful cleanup complete');
  }
}