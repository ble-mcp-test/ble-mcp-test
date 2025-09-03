import { EventEmitter } from 'events';
import noble from '@stoprocent/noble';
import { expandUuidVariants } from './utils.js';

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
  devicePrefix?: string;  // Optional - for specific device targeting
  serviceUuid: string;     // Single service UUID (will be expanded internally)
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
  private connectInProgress = false;
  
  // Static flags to prevent connections during cleanup
  private static cleanupInProgress = false;
  private static cleanupStartTime: number | null = null;

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
   * Clean up Noble global resources (static helper for cleanup method)
   */
  private static async cleanupGlobalResources(): Promise<void> {
    const state = await NobleTransport.getResourceState();

    // Clean up scanStop listeners (critical leak source per docs/NOBLE-DISCOVERASYNC-LEAK.md)
    if (state.listenerCounts.scanStop > 90) {
      console.log('[Noble] Cleaning up scanStop listener leak (count > 90)');
      noble.removeAllListeners('scanStop');
    }

    // Clean up discover listeners
    if (state.listenerCounts.discover > 10) {
      console.log('[Noble] Cleaning up discover listener leak (count > 10)');
      noble.removeAllListeners('discover');
    }

    // Force stop scanning
    try {
      await noble.stopScanningAsync();
    } catch {
      // Ignore stop scanning errors
    }

    // Clear peripheral cache if excessive
    if (state.peripheralCount > 50) {
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


  async resetNobleStack(): Promise<void> {
    console.log('[Noble] WARNING: Skipping BLE stack reset to prevent crashes');
    console.log('[Noble] rfkill operations can crash Noble if done during active operations');
    console.log('[Noble] If BLE is truly stuck, manually run: sudo systemctl restart bluetooth');
    
    // Force stop scanning first (safe operation)
    try {
      await noble.stopScanningAsync();
    } catch {
      // Ignore stop scanning errors during reset
    }
    
    // DO NOT use rfkill here - it crashes Noble if there are active handles
    // Only wait for Noble state recovery
    
    // Wait for Noble to stabilize (all platforms)
    console.log('[Noble] Waiting for Noble state to stabilize...');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.log('[Noble] State stabilization timeout - continuing anyway');
        resolve();
      }, 3000);
      
      const checkState = () => {
        if (noble.state === 'poweredOn') {
          clearTimeout(timeout);
          console.log('[Noble] Noble is powered on');
          resolve();
        } else {
          console.log(`[Noble] Current state: ${noble.state}, waiting...`);
          setTimeout(checkState, 500);
        }
      };
      
      // Start checking immediately
      checkState();
    });
    
    console.log('[Noble] Noble state check complete');
  }

  async connect(config: BleConfig): Promise<string> {
    // Block connection if cleanup is in progress
    if (NobleTransport.cleanupInProgress) {
      const cleanupTime = NobleTransport.cleanupStartTime ? 
        Math.ceil((Date.now() - NobleTransport.cleanupStartTime) / 1000) : 0;
      const remainingTime = Math.max(1, 15 - cleanupTime); // Assume max 15s cleanup
      throw new Error(`BLE stack recovering, please try again in ${remainingTime} seconds`);
    }
    
    this.connectInProgress = true;
    
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
      
      // Find device using UUID variants for scanning
      this.peripheral = await this.findDevice(config.serviceUuid, config.devicePrefix);
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
      
      // Find the service and discover what UUID format the device actually uses
      let targetService: any = null;
      let actualServiceUuid: string = '';
      
      for (const service of services) {
        const sUuid = service.uuid.toLowerCase().replace(/-/g, '');
        const configUuidVariants = expandUuidVariants(config.serviceUuid);
        if (configUuidVariants.some(variant => sUuid === variant)) {
          targetService = service;
          actualServiceUuid = sUuid; // Remember the format the device actually uses
          console.log(`[Noble] Found service using UUID format: ${actualServiceUuid}`);
          break;
        }
      }
      
      if (!targetService) {
        throw new Error(`Service ${config.serviceUuid} not found`);
      }
      
      // Discover characteristics with timeout
      const characteristics: any[] = await this.withInternalTimeout(
        targetService.discoverCharacteristicsAsync(),
        10000,
        'Characteristic discovery timeout'
      );
      
      // Find characteristics using all possible UUID variants
      // Each characteristic might use different format (standard vs custom)
      console.log(`[Noble] Looking for characteristics (any format):`);
      console.log(`[Noble]   Write variants: [${expandUuidVariants(config.writeUuid).join(', ')}]`);
      console.log(`[Noble]   Notify variants: [${expandUuidVariants(config.notifyUuid).join(', ')}]`);
      
      this.writeChar = characteristics.find((c: any) => {
        const cUuid = c.uuid.toLowerCase().replace(/-/g, '');
        const writeVariants = expandUuidVariants(config.writeUuid);
        return writeVariants.some(variant => cUuid === variant);
      });
      
      this.notifyChar = characteristics.find((c: any) => {
        const cUuid = c.uuid.toLowerCase().replace(/-/g, '');
        const notifyVariants = expandUuidVariants(config.notifyUuid);
        return notifyVariants.some(variant => cUuid === variant);
      });
      
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
      this.connectInProgress = false;
      return deviceName;
      
    } catch (error: any) {
      this.connectInProgress = false;
      
      console.log(`[Noble] Connection failed: ${error}`);
      
      // For connection errors, we MUST do full cleanup
      // Incomplete connections leave the BLE stack in a bad state
      if (this.peripheral) {
        console.log(`[Noble] Performing full cleanup after connection error`);
        try {
          // Try graceful disconnect first
          if (this.peripheral.state === 'connected' || this.peripheral.state === 'connecting') {
            console.log(`[Noble] ERROR RECOVERY: Peripheral state: ${this.peripheral.state} - attempting disconnect`);
            const disconnectStart = Date.now();
            const result = await Promise.race([
              this.peripheral.disconnectAsync().then(() => 'completed'),
              new Promise(resolve => setTimeout(() => resolve('timeout'), 5000)) // 5s timeout
            ]);
            const disconnectTime = Date.now() - disconnectStart;
            
            if (result === 'timeout') {
              console.warn(`[Noble] ⚠️ ERROR RECOVERY DISCONNECT TIMEOUT after ${disconnectTime}ms (5s limit) - possible zombie connection!`);
            } else {
              console.log(`[Noble] ERROR RECOVERY: Disconnect completed successfully in ${disconnectTime}ms`);
            }
          }
          
          // Remove all listeners
          this.peripheral.removeAllListeners?.();
        } catch (cleanupError) {
          console.log(`[Noble] Cleanup after connection error failed: ${cleanupError}`);
        }
      }
      
      // Clear our references
      this.peripheral = null;
      this.writeChar = null;
      this.notifyChar = null;
      
      // Clear device search cleanup if it exists
      if (this.findDeviceCleanup) {
        this.findDeviceCleanup();
        this.findDeviceCleanup = null;
      }
      
      // Always add recovery delay after connection errors
      console.log(`[Noble] Adding 3s recovery delay after connection error`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      throw error;
    }
  }

  private findDeviceCleanup: (() => void) | null = null;

  private async findDevice(serviceUuid: string, devicePrefix?: string): Promise<any> {
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
      
      // Expand UUID into all possible variants (short, long) for scanning
      // This handles both client formats and platform differences
      const serviceUuidVariants = expandUuidVariants(serviceUuid);
      
      // Start scanning with all UUID variants
      const scanMessage = devicePrefix 
        ? `[Noble] Starting BLE scan for service variants [${serviceUuidVariants.join(', ')}] with device filter: ${devicePrefix}...`
        : `[Noble] Starting BLE scan for any device with service variants [${serviceUuidVariants.join(', ')}]...`;
      console.log(scanMessage);
      noble.startScanningAsync(serviceUuidVariants, true).then(() => {
        // Scanning started successfully
      }).catch((error) => {
        cleanupScan();
        reject(error);
      });
      
      timeout = setTimeout(() => {
        cleanupScan();
        const errorMsg = devicePrefix 
          ? `Device ${devicePrefix} with service variants [${serviceUuidVariants.join(', ')}] not found`
          : `No devices found with service variants [${serviceUuidVariants.join(', ')}]`;
        reject(new Error(errorMsg));
      }, 15000);
      
      onDiscover = async (device: any) => {
        const name = device.advertisement.localName || '';
        const id = device.id;
        console.log(`[Noble] Discovered device: ${name || 'Unknown'} [${id}], checking against filter: ${devicePrefix || 'none'}`);
        
        // If device filter provided, check it
        if (devicePrefix) {
          // Try to match by name or ID
          if ((name && name.startsWith(devicePrefix)) || id === devicePrefix) {
            cleanupScan();
            console.log(`[Noble] Found matching device: ${name || id} (service: ${serviceUuid})`);
            resolve(device);
          } else if (devicePrefix === 'CS108') {
            // Special case for CS108 - accept any device with the right service UUID
            // since CS108 devices often don't advertise their name
            cleanupScan();
            console.log(`[Noble] Found CS108-compatible device: ${name || id} (service: ${serviceUuid})`);
            resolve(device);
          }
        } else {
          // No device filter - take first device with matching service
          cleanupScan();
          console.log(`[Noble] Found device with service variants [${serviceUuidVariants.join(', ')}]: ${name || id}`);
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
      verifyResources = true
    } = options;

    // SAFETY: Never run cleanup during active connection
    if (this.connectInProgress) {
      console.log(`[Noble] WARNING: Cleanup requested during active connection - skipping to prevent crash`);
      return;
    }

    console.log(`[Noble] Starting ${force ? 'aggressive' : 'graceful'} cleanup`);
    
    // Set cleanup flag to block new connections
    NobleTransport.cleanupInProgress = true;
    NobleTransport.cleanupStartTime = Date.now();
    
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
          
          // Try graceful disconnect with longer timeout
          console.log(`[Noble] NORMAL DISCONNECT: Attempting graceful disconnect...`);
          const disconnectStart = Date.now();
          const result = await Promise.race([
            this.peripheral.disconnectAsync().then(() => 'completed'),
            new Promise(resolve => setTimeout(() => resolve('timeout'), 10000)) // Increased from 2s to 10s
          ]);
          const disconnectTime = Date.now() - disconnectStart;
          
          if (result === 'timeout') {
            console.warn(`[Noble] ⚠️ NORMAL DISCONNECT TIMEOUT after ${disconnectTime}ms (10s limit) - likely zombie!`);
            throw new Error('Disconnect timeout - zombie connection likely');
          } else {
            console.log(`[Noble] NORMAL DISCONNECT: Completed successfully in ${disconnectTime}ms`);
          }
        } catch (e) {
          console.log(`[Noble] Graceful disconnect failed: ${e}`);
          // Force disconnect as fallback
          try {
            console.log(`[Noble] Attempting force disconnect...`);
            (this.peripheral as any)._peripheral?.disconnect?.();
            await new Promise(resolve => setTimeout(resolve, 3000));
          } catch (forceError) {
            console.log(`[Noble] Force disconnect also failed: ${forceError}`);
          }
        }
        
        // Verify disconnect actually worked
        try {
          const state = this.peripheral.state;
          if (state === 'connected') {
            console.error(`[Noble] WARNING: Peripheral still shows connected after disconnect attempts`);
            
            // Last resort: OS-level disconnect if we have the address
            if (this.peripheral.address && process.platform === 'linux') {
              await this.osLevelDisconnect(this.peripheral.address);
            }
          } else {
            console.log(`[Noble] Disconnect verified - peripheral state: ${state}`);
          }
        } catch (e) {
          console.log(`[Noble] Could not verify disconnect state: ${e}`);
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
      // Small delay to allow async cleanup to complete
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const state = await NobleTransport.getResourceState();
      
      // Check for resource leaks and clean if needed
      if (state.listenerCounts.scanStop > 90 || 
          state.listenerCounts.discover > 10 || 
          state.peripheralCount > 100) {
        console.log('[Noble] Resource leak detected - cleaning global resources');
        await NobleTransport.cleanupGlobalResources();
      }
    }
    
    console.log(`[Noble] ${force ? 'Aggressive' : 'Graceful'} cleanup complete`);
    
    // Clear cleanup flag
    NobleTransport.cleanupInProgress = false;
    NobleTransport.cleanupStartTime = null;
  }
  
  /**
   * OS-level disconnect as last resort
   */
  private async osLevelDisconnect(address: string): Promise<void> {
    // Only supported on Linux currently
    if (process.platform !== 'linux') {
      console.log(`[Noble] OS-level disconnect not available on ${process.platform}`);
      return;
    }
    
    console.log(`[Noble] Attempting OS-level disconnect for ${address} (Linux)`);
    
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    try {
      // Format address for hcitool (uppercase with colons)
      const formattedAddress = address.toUpperCase();
      
      // Try hcitool disconnect (Linux only)
      await execAsync(`sudo hcitool ledc ${formattedAddress}`);
      console.log(`[Noble] OS-level disconnect successful`);
      
      // Give it a moment to take effect
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (e: any) {
      console.error(`[Noble] OS-level disconnect failed: ${e}`);
      
      // Check if it's an I/O error which indicates BLE stack corruption
      if (e.message?.includes('Input/output error')) {
        console.error(`[Noble] CRITICAL: BLE stack appears corrupted (I/O error)`);
        console.log(`[Noble] Attempting rfkill recovery to reset BLE hardware...`);
        
        try {
          // Try rfkill block/unblock to reset the BLE hardware (Linux only)
          await execAsync('sudo rfkill block bluetooth');
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          await execAsync('sudo rfkill unblock bluetooth');
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          console.log(`[Noble] rfkill recovery completed - BLE hardware reset`);
          
          // Wait for Noble to detect the power cycle
          console.log('[Noble] Waiting for Noble to detect BLE power cycle...');
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              console.log('[Noble] Power state recovery timeout - continuing anyway');
              resolve();
            }, 5000);
            
            const checkState = () => {
              if (noble.state === 'poweredOn') {
                clearTimeout(timeout);
                console.log('[Noble] Noble detected BLE power on');
                resolve();
              } else {
                setTimeout(checkState, 500);
              }
            };
            
            checkState();
          });
        } catch (rfkillError) {
          console.error(`[Noble] rfkill recovery failed: ${rfkillError}`);
          console.error(`[Noble] MANUAL INTERVENTION REQUIRED: The BLE stack is corrupted.`);
          console.error(`[Noble] On Linux: Run 'sudo systemctl restart bluetooth' to recover.`);
        }
      }
      // For other errors, we already logged them - not fatal
    }
  }

  async disconnect(): Promise<void> {
    await this.cleanup({ force: false, verifyResources: true });
  }
  
  async forceCleanup(): Promise<void> {
    await this.cleanup({ force: true, resetStack: true, verifyResources: true });
  }

  /**
   * Check if the peripheral is actually connected
   * Used to verify Noble's disconnect events aren't spurious
   */
  async isConnected(): Promise<boolean> {
    if (!this.peripheral) {
      return false;
    }
    
    try {
      // Check Noble's reported state
      const state = this.peripheral.state;
      console.log(`[Noble] Connection state check: ${state}`);
      
      if (state !== 'connected') {
        return false;
      }
      
      // Double-check by trying to read a characteristic (if we have one)
      if (this.notifyChar) {
        try {
          // Try to read the characteristic to verify connection is alive
          await this.notifyChar.readAsync();
          console.log(`[Noble] Connection verified - can still read from device`);
          return true;
        } catch (readError) {
          console.log(`[Noble] Connection check failed - cannot read: ${readError}`);
          return false;
        }
      }
      
      // If we can't verify with a read, trust Noble's state
      return state === 'connected';
    } catch (e) {
      console.error(`[Noble] Error checking connection state: ${e}`);
      return false;
    }
  }
}