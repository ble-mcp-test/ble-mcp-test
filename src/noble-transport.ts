import { EventEmitter } from 'events';
import noble from '@stoprocent/noble';
import { BLEConnectionError } from './constants.js';

// Constants
const DEFAULT_TIMEOUT_MS = 10000;
const CLEANUP_CHECK_INTERVAL_MS = 200;
const CLEANUP_MAX_WAIT_MS = 5000;

// Export config type for compatibility
export interface BleConfig {
  service: string;       // Primary service UUID
  write: string;         // Write characteristic UUID
  notify: string;        // Notify characteristic UUID
  deviceId?: string;     // Exact device ID/address for matching
  deviceName?: string;   // Device name filter (partial match)
  timeout?: number;      // Discovery timeout in milliseconds
}

/**
 * Noble BLE Transport - Clean Implementation
 * 
 * Handles BLE communication with proper cleanup and state management.
 * Uses Noble's async API exclusively with proper error handling.
 */
export class NobleTransport extends EventEmitter {
  private static initialized = false;
  
  /**
   * Initialize Noble (call once at startup)
   */
  static async initialize(timeoutMs: number = 5000): Promise<void> {
    if (this.initialized) return;
    
    // Increase max listeners to prevent warnings during test runs
    noble.setMaxListeners(15);
    
    // Use Noble's built-in method instead of checking internal state
    try {
      await Promise.race([
        noble.waitForPoweredOnAsync(),
        new Promise<void>((resolve) => {
          setTimeout(() => resolve(), timeoutMs); // Continue anyway on timeout
        })
      ]);
    } catch (error) {
      // Continue anyway on error - let connection attempts handle power issues
      console.warn('[Noble] Power on wait failed:', error);
    }
    
    this.initialized = true;
  }
  private peripheral: any = null;
  private writeChar: any = null;
  private notifyChar: any = null;
  private cleanupInProgress: boolean = false;
  
  constructor(private config: BleConfig) {
    super();
  }

  /**
   * Expand UUID to handle different formats
   * Supports both short (9800) and long (00009800-0000-1000-8000-00805f9b34fb) formats
   */
  private expandUuid(uuid: string): string[] {
    const normalized = uuid.toLowerCase().replace(/-/g, '');
    const variants: string[] = [];
    
    // Check if it's a standard Bluetooth long UUID (32 chars without dashes)
    // Format: 0000XXXX00001000800000805f9b34fb where XXXX is the short UUID
    if (normalized.length === 32 && normalized.endsWith('00001000800000805f9b34fb')) {
      // Extract the short UUID (characters 4-8)
      const shortUuid = normalized.slice(4, 8);
      
      // Add short UUID variants
      variants.push(shortUuid);  // e.g., "9800"
      
      // Add long UUID variants
      variants.push(normalized);  // Without dashes
      const withDashes = `${normalized.slice(0,8)}-${normalized.slice(8,12)}-${normalized.slice(12,16)}-${normalized.slice(16,20)}-${normalized.slice(20)}`;
      variants.push(withDashes);  // With dashes
    }
    // Handle short UUID (4 chars)
    else if (normalized.length === 4) {
      variants.push(normalized);  // e.g., "9800"
      
      // Create full UUID from short
      const fullUuid = `0000${normalized}00001000800000805f9b34fb`;
      variants.push(fullUuid);
      
      // Add with dashes
      const withDashes = `0000${normalized}-0000-1000-8000-00805f9b34fb`;
      variants.push(withDashes);
    }
    // Handle other formats as-is
    else {
      variants.push(normalized);
      
      // If it has the right length for a UUID with dashes removed, add dashed version
      if (normalized.length === 32) {
        const withDashes = `${normalized.slice(0,8)}-${normalized.slice(8,12)}-${normalized.slice(12,16)}-${normalized.slice(16,20)}-${normalized.slice(20)}`;
        variants.push(withDashes);
      }
    }
    
    // Remove duplicates
    return [...new Set(variants)];
  }

  /**
   * Find a device by scanning
   */
  private async findDevice(): Promise<any> {
    console.log(`[Noble] Scanning for device...`);
    const timeoutMs = this.config.timeout || DEFAULT_TIMEOUT_MS;
    await noble.waitForPoweredOnAsync();
    
    const serviceVariants = this.expandUuid(this.config.service);
    
    // Set up timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new BLEConnectionError('HARDWARE_NOT_FOUND', 'Device discovery timeout')), timeoutMs);
    });
    
    // Set up discovery promise
    const discoveryPromise = (async () => {
      try {
        // Start scanning with service filter
        await noble.startScanningAsync(serviceVariants, true);
        
        // Use async generator for discovery
        for await (const peripheral of noble.discoverAsync()) {
          const name = peripheral.advertisement?.localName || '';
          const address = peripheral.address || peripheral.id;
          
          // Check device match
          let deviceMatch = true;
          
          if (this.config.deviceId) {
            // Exact ID match
            deviceMatch = address ? address.toLowerCase() === this.config.deviceId.toLowerCase() : false;
          } else if (this.config.deviceName) {
            // Partial name match
            deviceMatch = name.toLowerCase().includes(this.config.deviceName.toLowerCase());
          }
          // If neither specified, any device with the service matches
          
          if (deviceMatch) {
            console.log(`[Noble] Found device: ${name || 'Unknown'} [${address}]`);
            return peripheral;
          }
        }
      } finally {
        // Always stop scanning
        try {
          await noble.stopScanningAsync();
        } catch {
          // Ignore stop scanning errors
        }
      }
    })();
    
    // Race between timeout and discovery
    return Promise.race([timeoutPromise, discoveryPromise]);
  }

  /**
   * Connect to device
   */
  async connect(): Promise<{ name: string; id: string }> {
    // Check if cleanup is in progress - fail immediately if true
    if (this.cleanupInProgress) {
      throw new BLEConnectionError('CLEANUP_IN_PROGRESS', 'Cannot connect while cleanup is in progress');
    }
    
    try {
      // Find the device
      this.peripheral = await this.findDevice();
      
      if (!this.peripheral) {
        throw new BLEConnectionError('HARDWARE_NOT_FOUND', 'Device discovery returned no device');
      }
      
      const name = this.peripheral.advertisement?.localName || 'Unknown';
      const id = this.peripheral.address || this.peripheral.id;
      
      console.log(`[Noble] Connecting to GATT server...`);
      // Connect to peripheral
      await this.peripheral.connectAsync();
      console.log(`[Noble] Connected to GATT server`);
      
      // Discover services
      const serviceVariants = this.expandUuid(this.config.service);
      const services = await this.peripheral.discoverServicesAsync(serviceVariants);
      
      if (!services || services.length === 0) {
        throw new BLEConnectionError('SERVICE_NOT_FOUND', `Service ${this.config.service} not found on device`);
      }
      
      // Discover characteristics
      const service = services[0];
      const characteristics = await service.discoverCharacteristicsAsync();
      
      // Find write and notify characteristics
      const writeVariants = this.expandUuid(this.config.write);
      const notifyVariants = this.expandUuid(this.config.notify);
      
      this.writeChar = characteristics.find((c: any) => {
        const uuid = c.uuid.toLowerCase().replace(/-/g, '');
        return writeVariants.includes(uuid);
      });
      
      this.notifyChar = characteristics.find((c: any) => {
        const uuid = c.uuid.toLowerCase().replace(/-/g, '');
        return notifyVariants.includes(uuid);
      });
      
      if (!this.writeChar || !this.notifyChar) {
        throw new BLEConnectionError('CHARACTERISTICS_NOT_FOUND', 
          `Required characteristics not found (write: ${this.config.write}, notify: ${this.config.notify})`);
      }
      
      // Set up notifications
      this.notifyChar.on('data', (data: Buffer) => {
        this.emit('data', new Uint8Array(data));
      });
      
      await this.notifyChar.subscribeAsync();
      
      // Handle unexpected disconnect
      this.peripheral.once('disconnect', async () => {
        console.log(`[Noble] Device disconnected unexpectedly`);
        // Clean up our own state when device disconnects
        await this.cleanup();
        // Let session know we're disconnected (for status updates)
        this.emit('disconnect');
      });
      
      return { name, id };
      
    } catch (error: any) {
      // Clean up on error
      console.error(`[Noble] Connection error:`, error.message || error);
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Write data to device
   */
  async write(data: Uint8Array): Promise<void> {
    if (!this.writeChar) {
      throw new Error('Not connected');
    }
    await this.writeChar.writeAsync(Buffer.from(data), false);
  }

  /**
   * Disconnect all peripherals in Noble's map
   */
  private async disconnectAllPeripherals(): Promise<void> {
    if (!(noble as any)._peripherals) return;
    
    const peripherals = (noble as any)._peripherals;
    const connectedPeripherals: any[] = [];
    
    if (peripherals instanceof Map) {
      peripherals.forEach((p: any) => {
        if (p.state === 'connected' || p.state === 'connecting' || p.state === 'disconnecting') {
          connectedPeripherals.push(p);
        }
      });
    } else if (typeof peripherals === 'object') {
      Object.values(peripherals).forEach((p: any) => {
        if (p.state === 'connected' || p.state === 'connecting' || p.state === 'disconnecting') {
          connectedPeripherals.push(p);
        }
      });
    }
    
    // Disconnect all connected peripherals
    for (const p of connectedPeripherals) {
      try {
        p.removeAllListeners();
        await p.disconnectAsync();
      } catch {
        // Ignore disconnect errors
      }
    }
  }

  /**
   * Wait for peripherals to settle after reset
   */
  private async waitForPeripheralsToSettle(): Promise<void> {
    let totalWaitTime = 0;
    
    while (totalWaitTime < CLEANUP_MAX_WAIT_MS) {
      // Check if all peripherals are disconnected
      let hasConnectedPeripherals = false;
      
      if ((noble as any)._peripherals) {
        const peripherals = (noble as any)._peripherals;
        
        if (peripherals instanceof Map) {
          peripherals.forEach((p: any) => {
            if (p.state === 'connected' || p.state === 'connecting' || p.state === 'disconnecting') {
              hasConnectedPeripherals = true;
            }
          });
        } else if (typeof peripherals === 'object') {
          Object.values(peripherals).forEach((p: any) => {
            if (p.state === 'connected' || p.state === 'connecting' || p.state === 'disconnecting') {
              hasConnectedPeripherals = true;
            }
          });
        }
      }
      
      // If all peripherals are disconnected, we're done
      if (!hasConnectedPeripherals) {
        break;
      }
      
      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, CLEANUP_CHECK_INTERVAL_MS));
      totalWaitTime += CLEANUP_CHECK_INTERVAL_MS;
    }
  }

  /**
   * Clear Noble's internal state (workaround for Noble bug)
   */
  private clearNobleInternalState(): void {
    // Clear peripherals map
    if ((noble as any)._peripherals) {
      const peripherals = (noble as any)._peripherals;
      if (peripherals instanceof Map) {
        peripherals.clear();
      } else {
        Object.keys(peripherals).forEach(key => delete peripherals[key]);
      }
    }
    
    // Clear discovered peripheral UUIDs array
    if ((noble as any)._discoveredPeripheralUUids) {
      (noble as any)._discoveredPeripheralUUids = [];
    }
    
    // Clear any allowDuplicates flag
    if ((noble as any)._allowDuplicates) {
      (noble as any)._allowDuplicates = false;
    }
  }

  /**
   * Clean up all resources
   */
  async cleanup(): Promise<void> {
    // Guard against concurrent cleanup
    if (this.cleanupInProgress) {
      return;
    }
    
    this.cleanupInProgress = true;
    
    try {
      // Stop any active scanning
      try {
        await noble.stopScanningAsync();
      } catch {
        // Ignore scanning errors
      }
    
      // Disconnect all connected peripherals in Noble's map
      await this.disconnectAllPeripherals();
      
      // Clear references
      this.peripheral = null;
      this.writeChar = null;
      this.notifyChar = null;
      
      // Clear our own listeners
      this.removeAllListeners();
      
      // Reset Noble's HCI interface
      try {
        (noble as any).reset();
        
        // Wait for peripherals to settle
        await this.waitForPeripheralsToSettle();
        
        // Clear Noble's internal state (workaround for Noble bug)
        this.clearNobleInternalState();
      } catch {
        // Ignore reset errors
      }
    } finally {
      this.cleanupInProgress = false;
    }
  }


  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.peripheral && this.peripheral.state === 'connected';
  }
}

export default NobleTransport;