import { EventEmitter } from 'events';
import noble from '@stoprocent/noble';
import { BLEConnectionError } from './constants.js';
import { logErrorWithStack } from './utils.js';

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
 * SIMPLIFIED Noble BLE Transport - v2.0
 * 
 * Complete rewrite with minimal complexity:
 * - try/catch/finally for all async operations
 * - Simple cleanup: just disconnectAsync() + noble.reset()
 * - No workarounds, no fallbacks, no complex state management
 * - If it fails, it fails cleanly
 */
let transportInstanceCount = 0;

export class NobleTransport extends EventEmitter {
  private peripheral: any = null;
  private writeChar: any = null;
  private notifyChar: any = null;
  private cleanupInProgress: boolean = false;
  private instanceId: number;
  
  constructor(private config: BleConfig) {
    super();
    this.instanceId = ++transportInstanceCount;
    console.log(`[Noble] Creating NobleTransport instance #${this.instanceId}`);
    
    // Log stack trace to see who's creating instances
    const stack = new Error().stack;
    if (stack) {
      const lines = stack.split('\n').slice(1, 3);
      console.log(`[Noble] Instance #${this.instanceId} created from:`);
      lines.forEach(line => console.log(`  ${line.trim()}`));
    }
  }
  
  /**
   * Diagnostic function to inspect Noble's internal state
   */
  private inspectNobleState(context: string): void {
    console.log(`[Noble] === State Inspection (${context}) ===`);
    
    // Noble's basic state
    console.log(`[Noble] State: ${noble.state}`);
    console.log(`[Noble] Address: ${noble.address || 'unknown'}`);
    
    // Check internal _state if available
    if ((noble as any)._state) {
      console.log(`[Noble] Internal _state: ${(noble as any)._state}`);
    }
    
    // Check scanning state
    if ((noble as any)._scanState) {
      console.log(`[Noble] Scan state: ${(noble as any)._scanState}`);
    }
    
    // Check peripherals map
    if ((noble as any)._peripherals) {
      const peripherals = (noble as any)._peripherals;
      if (peripherals instanceof Map) {
        console.log(`[Noble] Peripherals in map: ${peripherals.size}`);
        peripherals.forEach((peripheral: any, id: string) => {
          console.log(`[Noble]   - ${id}: state=${peripheral.state}, connected=${peripheral.state === 'connected'}`);
        });
      } else if (typeof peripherals === 'object') {
        const ids = Object.keys(peripherals);
        console.log(`[Noble] Peripherals in object: ${ids.length}`);
        ids.forEach(id => {
          const p = peripherals[id];
          console.log(`[Noble]   - ${id}: state=${p.state}, connected=${p.state === 'connected'}`);
        });
      }
    }
    
    // Check our own peripheral
    if (this.peripheral) {
      console.log(`[Noble] Our peripheral: ${this.peripheral.id || this.peripheral.uuid}, state=${this.peripheral.state}`);
    } else {
      console.log(`[Noble] Our peripheral: null`);
    }
    
    // Check bindings state if available
    if ((noble as any)._bindings) {
      const bindings = (noble as any)._bindings;
      if (bindings._state) {
        console.log(`[Noble] Bindings state: ${bindings._state}`);
      }
      if (bindings._peripherals) {
        console.log(`[Noble] Bindings peripherals: ${Object.keys(bindings._peripherals).length}`);
      }
      // Check for handles
      if (bindings._handles) {
        console.log(`[Noble] Bindings handles: ${Object.keys(bindings._handles).length}`);
      }
      if (bindings._gatts) {
        console.log(`[Noble] Bindings gatts: ${Object.keys(bindings._gatts).length}`);
      }
    }
    
    // Check event listeners on noble
    const listenerCounts = noble.eventNames().map(event => 
      `${String(event)}:${noble.listenerCount(event)}`
    ).join(', ');
    console.log(`[Noble] Event listeners: ${listenerCounts || 'none'}`);
    
    // Check for accumulated discovery filters
    if ((noble as any)._discoveredPeripheralUUids) {
      console.log(`[Noble] Discovered peripheral UUIDs: ${(noble as any)._discoveredPeripheralUUids.length}`);
    }
    
    console.log(`[Noble] === End State Inspection ===`);
  }

  /**
   * Expand UUID to handle different formats
   */
  private expandUuid(uuid: string): string[] {
    const base = uuid.toLowerCase().replace(/-/g, '');
    const variants = [base];
    
    // Add full UUID format for 4-char UUIDs
    if (base.length === 4) {
      variants.push(`0000${base}00001000800000805f9b34fb`);
    }
    // Add format with dashes
    if (base.length === 32) {
      const withDashes = `${base.slice(0,8)}-${base.slice(8,12)}-${base.slice(12,16)}-${base.slice(16,20)}-${base.slice(20)}`;
      variants.push(withDashes);
    }
    
    return variants;
  }

  /**
   * Find a device - scanning with proper cleanup in finally
   * Supports both exact deviceId matching and deviceName filtering
   */
  private async findDevice(): Promise<any> {
    const timeoutMs = this.config.timeout || 10000;
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
          // If neither specified, any device with the service matches (already filtered by startScanningAsync)
          
          if (deviceMatch) {
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
      console.log(`[Noble] Found device: ${name} (${id})`);
      
      // Connect to peripheral
      await this.peripheral.connectAsync();
      console.log(`[Noble] Connected to ${name} (${id})`);
      
      // Discover services
      const serviceVariants = this.expandUuid(this.config.service);
      console.log(`[Noble] Discovering services: ${serviceVariants.join(', ')}`);
      const services = await this.peripheral.discoverServicesAsync(serviceVariants);
      
      if (!services || services.length === 0) {
        // Also try discovering ALL services to see what's available
        console.log(`[Noble] Service ${this.config.service} not found, discovering all services for debugging...`);
        const allServices = await this.peripheral.discoverServicesAsync([]);
        console.log(`[Noble] Available services: ${allServices?.map((s: any) => s.uuid).join(', ') || 'none'}`);
        throw new BLEConnectionError('SERVICE_NOT_FOUND', `Service ${this.config.service} not found on device`);
      }
      console.log(`[Noble] Found service: ${services[0].uuid}`);
      
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
      console.log(`[Noble] Subscribed to notifications`);
      
      // Handle unexpected disconnect
      this.peripheral.once('disconnect', async () => {
        console.log(`[Noble] Device disconnected - cleaning up transport`);
        // Clean up our own state when device disconnects
        await this.cleanup();
        // Let session know we're disconnected (for status updates)
        this.emit('disconnect');
      });
      
      console.log(`[Noble] Successfully connected to ${name} (${id})`);
      return { name, id };
      
    } catch (error: any) {
      logErrorWithStack('[Noble] Connection failed', error);
      
      // Inspect Noble state on specific errors
      if (error === 22 || error === 62 || error.message?.includes('22') || error.message?.includes('62')) {
        console.log(`[Noble] Error ${error} detected - inspecting Noble state...`);
        this.inspectNobleState(`Error ${error}`);
      }
      
      // Clean up on error
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
   * SIMPLE CLEANUP
   * Just disconnect, clear state, and reset Noble
   */
  async cleanup(): Promise<void> {
    // Guard against concurrent cleanup
    if (this.cleanupInProgress) {
      console.log(`[Noble] Instance #${this.instanceId} - ⚠️ Cleanup already in progress, skipping duplicate call`);
      // Log stack trace to understand who's calling cleanup twice
      const stack = new Error().stack;
      if (stack) {
        const lines = stack.split('\n').slice(1, 4);
        console.log(`[Noble] Instance #${this.instanceId} - Duplicate cleanup called from:`);
        lines.forEach(line => console.log(`  ${line.trim()}`));
      }
      return;
    }
    
    this.cleanupInProgress = true;
    console.log(`[Noble] Instance #${this.instanceId} - Starting cleanup`);
    
    // Log stack trace for debugging double cleanup
    const stack = new Error().stack;
    if (stack) {
      const lines = stack.split('\n').slice(1, 4);
      console.log('[Noble] Cleanup initiated from:');
      lines.forEach(line => console.log(`  ${line.trim()}`));
    }
    
    // Inspect state before cleanup
    if (process.env.BLE_MCP_LOG_LEVEL === 'debug') {
      this.inspectNobleState('Before cleanup');
    }
    
    try {
      // Stop any active scanning
      try {
        await noble.stopScanningAsync();
      } catch {
        // Ignore scanning errors
      }
    
    // CRITICAL: Disconnect ALL connected peripherals in Noble's map
    // This handles zombie connections from failed discoveries
    if ((noble as any)._peripherals) {
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
          console.log(`[Noble] Disconnecting peripheral: ${p.id || p.uuid}, state=${p.state}`);
          p.removeAllListeners();
          await p.disconnectAsync();
        } catch (error) {
          console.log(`[Noble] Error disconnecting peripheral ${p.id || p.uuid}:`, error);
        }
      }
    }
    
      // Clear references
      this.peripheral = null;
      this.writeChar = null;
      this.notifyChar = null;
      
      // Clear our own listeners
      this.removeAllListeners();
      
      // Reset Noble's HCI interface
      // This should clear any hardware-level zombie connections
      try {
        // Inspect before reset to see what's stuck
        if (process.env.BLE_MCP_LOG_LEVEL === 'debug') {
          this.inspectNobleState('Before noble.reset()');
        }
        
        console.log('[Noble] Resetting HCI interface');
        (noble as any).reset();

        // Dynamic settling delay - wait only as long as needed for peripherals to disconnect
        const checkInterval = 200; // Check every 200ms
        const maxWaitTime = 5000;  // Maximum 5 seconds
        let totalWaitTime = 0;
        
        console.log('[Noble] Checking for remaining peripherals...');
        
        while (totalWaitTime < maxWaitTime) {
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
            console.log(`[Noble] All peripherals settled after ${totalWaitTime}ms`);
            break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          totalWaitTime += checkInterval;
          
          // Log progress every second
          if (totalWaitTime % 1000 === 0) {
            console.log(`[Noble] Still waiting for peripherals to disconnect... (${totalWaitTime}ms elapsed)`);
            if (process.env.BLE_MCP_LOG_LEVEL === 'debug') {
              this.inspectNobleState(`After ${totalWaitTime}ms settling`);
            }
          }
        }
        
        if (totalWaitTime >= maxWaitTime) {
          console.warn(`[Noble] Timeout waiting for peripherals to settle after ${maxWaitTime}ms`);
          if (process.env.BLE_MCP_LOG_LEVEL === 'debug') {
            this.inspectNobleState('After timeout - peripherals may still be connected');
          }
        }

        // WORKAROUND: Noble doesn't clear its state properly on reset
        // We must clear it manually to prevent zombie connections and discovery issues
        
        // Clear peripherals map
        if ((noble as any)._peripherals) {
          const peripherals = (noble as any)._peripherals;
          const size = peripherals instanceof Map ? peripherals.size : Object.keys(peripherals).length;
          if (size > 0) {
            console.log(`[Noble] WARNING: ${size} peripherals still in map after reset!`);
            
            // Clear all peripherals from the map
            if (peripherals instanceof Map) {
              peripherals.clear();
            } else {
              Object.keys(peripherals).forEach(key => delete peripherals[key]);
            }
            console.log(`[Noble] Cleared peripherals map`);
          }
        }
        
        // Clear discovered peripheral UUIDs array
        if ((noble as any)._discoveredPeripheralUUids && (noble as any)._discoveredPeripheralUUids.length > 0) {
          console.log(`[Noble] Clearing ${(noble as any)._discoveredPeripheralUUids.length} discovered peripheral UUIDs`);
          (noble as any)._discoveredPeripheralUUids = [];
        }
        
        // Clear any allowDuplicates flag that might affect discovery
        if ((noble as any)._allowDuplicates) {
          console.log(`[Noble] Resetting allowDuplicates flag`);
          (noble as any)._allowDuplicates = false;
        }
      } catch (error) {
        console.log('[Noble] Reset error (ignoring):', error);
      }
      
      console.log(`[Noble] Instance #${this.instanceId} - Cleanup complete`);
    } finally {
      // Always reset the flag
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
