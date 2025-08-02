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

export interface NobleResourceState {
  peripheralCount: number;
  listenerCounts: Record<string, number>;
  scanningActive: boolean;
  hciConnections: number;
  cacheSize: number;
}

export class NobleTransport extends EventEmitter {
  private peripheral: any = null;
  private writeChar: any = null;
  private notifyChar: any = null;

  /**
   * Get current Noble resource state for monitoring
   */
  static async getResourceState(): Promise<NobleResourceState> {
    return {
      peripheralCount: Object.keys((noble as any)._peripherals || {}).length,
      listenerCounts: {
        discover: noble.listenerCount('discover'),
        scanStop: noble.listenerCount('scanStop'),
        stateChange: noble.listenerCount('stateChange'),
        warning: noble.listenerCount('warning')
      },
      scanningActive: (noble as any)._discovering || false,
      hciConnections: (noble as any)._bindings?.listenerCount?.('warning') || 0,
      cacheSize: Object.keys((noble as any)._services || {}).length + Object.keys((noble as any)._characteristics || {}).length
    };
  }

  /**
   * Force cleanup of Noble resources with leak detection
   */
  static async forceCleanupResources(deviceId?: string): Promise<void> {
    console.log(`[Noble] Force cleaning Noble resources${deviceId ? ` for device ${deviceId}` : ''}`);
    
    const initialState = await NobleTransport.getResourceState();
    console.log('[Noble] Initial resource state:', initialState);

    // Clean up scanStop listeners (critical leak source per docs/NOBLE-DISCOVERASYNC-LEAK.md)
    if (initialState.listenerCounts.scanStop > 90) {
      console.log('[Noble] Cleaning up scanStop listener leak (count > 90)');
      noble.removeAllListeners('scanStop');
    }

    // Clean up discover listeners
    if (initialState.listenerCounts.discover > 10) {
      console.log('[Noble] Cleaning up discover listener leak (count > 10)');
      noble.removeAllListeners('discover');
    }

    // Force stop scanning
    try {
      await noble.stopScanningAsync();
    } catch (e) {
      console.log('[Noble] Force stop scanning failed:', e);
    }

    // Clear peripheral cache if excessive
    if (initialState.peripheralCount > 50) {
      console.log('[Noble] Clearing excessive peripheral cache');
      const peripherals = (noble as any)._peripherals || {};
      Object.keys(peripherals).forEach(key => {
        try {
          peripherals[key]?.removeAllListeners?.();
        } catch {
          // Ignore cleanup errors
        }
      });
      (noble as any)._peripherals = {};
    }

    const finalState = await NobleTransport.getResourceState();
    console.log('[Noble] Final resource state:', finalState);
    
    const listenersFreed = (initialState.listenerCounts.scanStop + initialState.listenerCounts.discover) - 
                          (finalState.listenerCounts.scanStop + finalState.listenerCounts.discover);
    console.log(`[Noble] Resource cleanup complete - freed ${listenersFreed} listeners, ${initialState.peripheralCount - finalState.peripheralCount} peripherals`);
  }

  /**
   * Scan for device availability (based on check-device-available.js pattern)
   */
  static async scanDeviceAvailability(devicePrefix: string, timeoutMs: number = 5000): Promise<boolean> {
    if (noble.state !== 'poweredOn') {
      try {
        await noble.waitForPoweredOnAsync();
      } catch (e) {
        console.log(`[Noble] Device availability check failed - Bluetooth not powered on: ${e}`);
        return false;
      }
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        noble.removeAllListeners('discover');
        noble.stopScanningAsync().catch(() => {});
        resolve(false);
      }, timeoutMs);

      noble.on('discover', (peripheral) => {
        const id = peripheral.id;
        const name = peripheral.advertisement.localName || '';
        
        if (id.startsWith(devicePrefix) || name.startsWith(devicePrefix)) {
          clearTimeout(timeout);
          noble.removeAllListeners('discover');
          noble.stopScanningAsync().catch(() => {});
          console.log(`[Noble] Device availability confirmed: ${name || 'Unknown'} [${id}]`);
          resolve(true);
        }
      });

      noble.startScanningAsync([], true).catch(() => resolve(false));
    });
  }

  /**
   * Verify Noble resource cleanup after disconnect
   */
  static async verifyResourceCleanup(deviceName?: string): Promise<NobleResourceState> {
    console.log(`[Noble] Verifying resource cleanup${deviceName ? ` for ${deviceName}` : ''}`);
    
    // Small delay to allow async cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const state = await NobleTransport.getResourceState();
    
    // Check for resource leaks
    const leakWarnings = [];
    if (state.listenerCounts.scanStop > 90) {
      leakWarnings.push(`scanStop listeners: ${state.listenerCounts.scanStop} (threshold: 90)`);
    }
    if (state.listenerCounts.discover > 10) {
      leakWarnings.push(`discover listeners: ${state.listenerCounts.discover} (threshold: 10)`);
    }
    if (state.peripheralCount > 100) {
      leakWarnings.push(`peripheral cache: ${state.peripheralCount} (threshold: 100)`);
    }
    
    if (leakWarnings.length > 0) {
      console.log(`[Noble] Resource leak detected: ${leakWarnings.join(', ')}`);
      // Trigger force cleanup if leaks detected
      await NobleTransport.forceCleanupResources(deviceName);
      return await NobleTransport.getResourceState();
    }
    
    console.log('[Noble] Resource verification passed - no leaks detected');
    return state;
  }

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

  /**
   * Unified cleanup method with configurable options
   * @param options - Cleanup configuration
   * @param options.force - Use aggressive cleanup (default: false)
   * @param options.resetStack - Reset BLE stack after cleanup (default: false for graceful, true for force)
   * @param options.verifyResources - Verify and clean Noble resources after cleanup (default: true)
   * @param options.deviceName - Device name for resource verification
   */
  async cleanup(options: {
    force?: boolean;
    resetStack?: boolean;
    verifyResources?: boolean;
    deviceName?: string;
  } = {}): Promise<void> {
    const { 
      force = false, 
      resetStack = force,
      verifyResources = true,
      deviceName
    } = options;

    console.log(`[Noble] Starting ${force ? 'aggressive' : 'graceful'} cleanup`);
    
    // Clean up any active device search
    if (this.findDeviceCleanup) {
      this.findDeviceCleanup();
      this.findDeviceCleanup = null;
    }
    
    // Stop scanning
    try {
      await noble.stopScanningAsync();
    } catch {
      // Ignore scan stop errors
    }
    
    // Handle peripheral cleanup
    if (this.peripheral) {
      // Remove listeners first
      this.peripheral.removeAllListeners?.();
      
      if (this.notifyChar) {
        this.notifyChar.removeAllListeners?.();
      }
      
      if (!force) {
        // Graceful cleanup
        try {
          // Try graceful unsubscribe
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
      } else {
        // Aggressive cleanup - skip graceful attempts
        try {
          (this.peripheral as any)._peripheral?.disconnect?.();
        } catch (e) {
          console.log(`[Noble] Force disconnect failed: ${e}`);
        }
      }
    }
    
    // Clear references
    this.peripheral = null;
    this.writeChar = null;
    this.notifyChar = null;
    
    // Remove all transport listeners
    this.removeAllListeners();
    
    // Reset BLE stack if requested
    if (resetStack) {
      await this.resetNobleStack();
    }
    
    // Verify and clean resources if requested
    if (verifyResources) {
      await NobleTransport.verifyResourceCleanup(deviceName);
    }
    
    console.log(`[Noble] ${force ? 'Aggressive' : 'Graceful'} cleanup complete`);
  }

  async disconnect(): Promise<void> {
    await this.cleanup({ force: false, verifyResources: true });
  }
  
  async forceCleanup(): Promise<void> {
    await this.cleanup({ force: true, resetStack: true, verifyResources: true });
  }
}