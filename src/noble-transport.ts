import noble from '@stoprocent/noble';
import { LogLevel } from './utils.js';

// Increase max listeners to prevent warnings during rapid connections
noble.setMaxListeners(20);

// Global cleanup to ensure Noble doesn't keep process alive
export async function cleanupNoble(): Promise<void> {
  try {
    // Stop any ongoing scanning
    try {
      await noble.stopScanningAsync();
    } catch (e) {
      // Ignore errors if not scanning
    }
    
    // Remove all event listeners from Noble and its internal components
    noble.removeAllListeners();
    
    // Access internal bindings to remove their listeners too
    const bindings = (noble as any)._bindings;
    if (bindings) {
      bindings.removeAllListeners?.();
      
      // For HCI socket bindings, close the socket
      if (bindings._hci) {
        bindings._hci.removeAllListeners?.();
        bindings._hci._socket?.close?.();
      }
      
      // Clear any internal timers
      if (bindings._scanTimer) {
        clearTimeout(bindings._scanTimer);
        bindings._scanTimer = null;
      }
    }
    
    // Clear any peripherals
    const peripherals = (noble as any)._peripherals;
    if (peripherals) {
      Object.values(peripherals).forEach((peripheral: any) => {
        peripheral.removeAllListeners?.();
      });
    }
    
    console.log('[NobleTransport] Global Noble cleanup complete');
  } catch (error) {
    console.error('[NobleTransport] Error during global cleanup:', error);
  }
}

interface Callbacks {
  onData: (data: Uint8Array) => void;
  onDisconnected: () => void;
}

interface BLEConfig {
  devicePrefix: string;
  serviceUuid: string;
  writeUuid: string;
  notifyUuid: string;
}

export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTING = 'disconnecting'
}

// Platform-aware UUID normalization for Noble.js
// macOS Noble expects short UUIDs (4 chars)
// Linux Noble expects long UUIDs without dashes (32 hex chars)
export function normalizeUuid(uuid: string): string {
  const isLinux = process.platform === 'linux';
  
  // Remove dashes and convert to lowercase
  const cleaned = uuid.toLowerCase().replace(/-/g, '');
  
  if (isLinux) {
    // Linux: Always convert to full 128-bit UUID without dashes
    
    // If already 32 chars (full UUID without dashes), return as-is
    if (cleaned.length === 32) return cleaned;
    
    // If 4-char short UUID, expand to full 128-bit without dashes
    if (cleaned.length === 4) {
      return `0000${cleaned}00001000800000805f9b34fb`;
    }
    
    // Handle other lengths by padding and taking last 4 chars
    const shortId = cleaned.padStart(4, '0').slice(-4);
    return `0000${shortId}00001000800000805f9b34fb`;
  } else {
    // macOS (and others): Always convert to short UUID
    
    // If it's a 4-char UUID already, return it
    if (cleaned.length === 4) return cleaned;
    
    // If it's a full UUID (32 chars), extract the short UUID part
    if (cleaned.length === 32) {
      // Extract characters 4-8 (the short UUID portion)
      return cleaned.substring(4, 8);
    }
    
    // For other lengths, try to extract something sensible
    // Take the last 4 chars, or pad if too short
    return cleaned.padStart(4, '0').slice(-4);
  }
}

// Extract short UUID from a normalized long UUID for comparison
function extractShortUuid(uuid: string): string {
  const cleaned = uuid.toLowerCase().replace(/-/g, '');
  if (cleaned.length === 32) {
    // Extract the 4-char short UUID from positions 4-8
    return cleaned.substring(4, 8);
  }
  return cleaned.padStart(4, '0').slice(-4);
}

export class NobleTransport {
  private peripheral: any = null;
  private peripheralId: string = '';
  private writeChar: any = null;
  private notifyChar: any = null;
  private deviceName = '';
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private isScanning = false;
  private logLevel: LogLevel;
  
  constructor(logLevel: LogLevel = 'debug') {
    this.logLevel = logLevel;
  }
  
  // Scanner recovery delay management
  private static lastScannerDestroyTime = 0;
  private static SCANNER_RECOVERY_DELAY = 1000; // 1 second buffer
  
  // Service discovery timeout
  private static SERVICE_DISCOVERY_TIMEOUT = 60000; // 60 seconds - generous timeout
  
  // Connection retry management
  private static needsReset = false;
  
  // Platform-aware timing configuration
  private static readonly TIMINGS = (() => {
    switch (process.platform) {
      case 'darwin':
        return {
          // macOS timings - optimized for faster operations
          CONNECTION_STABILITY: 0,       // 0s - CS108 disconnects with any delay
          PRE_DISCOVERY_DELAY: 0,        // 0s - CS108 needs immediate discovery
          NOBLE_RESET_DELAY: 1000,       // 1s
          SCAN_TIMEOUT: 15000,           // 15s
          CONNECTION_TIMEOUT: 15000,     // 15s
          DISCONNECT_COOLDOWN: 1000,     // 1s - macOS handles BLE cleanup quickly
        };
      
      case 'win32':
        return {
          // Windows timings - moderate delays for stability
          CONNECTION_STABILITY: 0,       // 0s - CS108 disconnects with any delay
          PRE_DISCOVERY_DELAY: 0,        // 0s - CS108 needs immediate discovery
          NOBLE_RESET_DELAY: 2000,       // 2s - Windows BLE is moderately stable
          SCAN_TIMEOUT: 15000,           // 15s
          CONNECTION_TIMEOUT: 15000,     // 15s
          DISCONNECT_COOLDOWN: 3000,     // 3s - Windows needs some cooldown
        };
      
      default:  // linux, freebsd, etc.
        return {
          // Linux/Pi timings - needs longer delays for stability
          CONNECTION_STABILITY: 0,       // 0s - CS108 disconnects with any delay
          PRE_DISCOVERY_DELAY: 0,        // 0s - CS108 needs immediate discovery
          NOBLE_RESET_DELAY: 5000,       // 5s - Pi needs more recovery time
          SCAN_TIMEOUT: 15000,           // 15s
          CONNECTION_TIMEOUT: 15000,     // 15s
          DISCONNECT_COOLDOWN: 10000,    // 10s - Linux BLE stack needs longer cooldown
        };
    }
  })();

  getState(): ConnectionState {
    return this.state;
  }

  // Atomically check and claim connection
  tryClaimConnection(): boolean {
    if (this.state !== ConnectionState.DISCONNECTED) {
      return false;
    }
    this.state = ConnectionState.CONNECTING;
    return true;
  }

  async connect(config: BLEConfig, callbacks: Callbacks): Promise<void> {
    // State should already be CONNECTING from tryClaimConnection
    if (this.state !== ConnectionState.CONNECTING) {
      throw new Error(`Invalid state for connect: ${this.state}`);
    }
    
    try {
      console.log(`[NobleTransport] Starting scan for device prefix: ${config.devicePrefix}`);
      
      // Reset Noble if needed before starting
      if (NobleTransport.needsReset) {
        console.log('[NobleTransport] Performing scheduled Noble reset');
        try {
          (noble as any).reset();
          NobleTransport.needsReset = false;
          await new Promise(resolve => setTimeout(resolve, NobleTransport.TIMINGS.NOBLE_RESET_DELAY));
        } catch (err) {
          console.log('[NobleTransport] Warning: Noble reset failed:', err);
        }
      }
      
      // Ensure Noble is ready with timeout
      if (noble.state !== 'poweredOn') {
        console.log(`[NobleTransport] Waiting for Bluetooth to power on (current state: ${noble.state})`);
        
        // Add timeout to prevent hanging
        const poweredOnPromise = noble.waitForPoweredOnAsync();
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Timeout waiting for Noble to be powered on')), 10000);
        });
        
        try {
          await Promise.race([poweredOnPromise, timeoutPromise]);
          console.log('[NobleTransport] Bluetooth powered on');
        } catch (error: any) {
          console.error('[NobleTransport] Error:', error?.message || error);
          throw error;
        }
      }
      
      // Additional safety check - if Noble is in a bad state after waiting, fail fast
      if (noble.state === 'unsupported') {
        throw new Error(`Noble is in unusable state: ${noble.state}`);
      }
      
      // Scan for device with atomic guard
      const peripheral = await this.scanForDevice(config.devicePrefix);
      if (!peripheral) {
        throw new Error(`No device found with prefix: ${config.devicePrefix}`);
      }
    
    this.peripheral = peripheral;
    this.peripheralId = peripheral.id;
    this.deviceName = peripheral.advertisement.localName || 'Unknown';
    
    console.log(`[NobleTransport] Peripheral ID: ${this.peripheralId}`);
    
    // Connect with event-based confirmation
    console.log(`[NobleTransport] Connecting to ${this.deviceName}...`);
    
    // Set up early disconnect handler to debug
    peripheral.once('disconnect', () => {
      console.log('[NobleTransport] EARLY DISCONNECT detected during connection!');
      console.log(`[NobleTransport] Peripheral state: ${peripheral.state}`);
    });
    
    // Set up connection promise with event listener
    const connectPromise = new Promise<void>((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        peripheral.removeAllListeners('connect');
        reject(new Error('Connection timeout'));
      }, NobleTransport.TIMINGS.CONNECTION_TIMEOUT);
      
      peripheral.once('connect', () => {
        clearTimeout(connectTimeout);
        console.log('[NobleTransport] Connected event received');
        resolve();
      });
      
      // Start the connection
      peripheral.connectAsync().catch((err: any) => {
        clearTimeout(connectTimeout);
        peripheral.removeAllListeners('connect');
        reject(err);
      });
    });
    
    await connectPromise;
    console.log('[NobleTransport] Connected to BLE device (confirmed by event)');
    console.log(`[NobleTransport] Peripheral state after connect: ${peripheral.state}`);
    
    // Normalize UUIDs for Noble.js
    const serviceUuid = normalizeUuid(config.serviceUuid);
    const writeUuid = normalizeUuid(config.writeUuid);
    const notifyUuid = normalizeUuid(config.notifyUuid);
    
    // Discover services and characteristics
    console.log('[NobleTransport] Discovering services and characteristics...');
    console.log(`[NobleTransport]   Service UUID: ${config.serviceUuid} -> ${serviceUuid}`);
    console.log(`[NobleTransport]   Write UUID: ${config.writeUuid} -> ${writeUuid}`);
    console.log(`[NobleTransport]   Notify UUID: ${config.notifyUuid} -> ${notifyUuid}`);
    
    // Wait for connection stability if needed
    const stabilityDelay = NobleTransport.TIMINGS.CONNECTION_STABILITY;
    if (stabilityDelay > 0) {
      console.log(`[NobleTransport] Waiting ${stabilityDelay/1000} seconds for connection stability...`);
      await new Promise(resolve => setTimeout(resolve, stabilityDelay));
    } else {
      console.log('[NobleTransport] Skipping stability delay - proceeding immediately to service discovery');
    }
    
    // Validate peripheral is still connected before service discovery
    if (peripheral.state !== 'connected') {
      throw new Error(`Peripheral disconnected during stability wait. State: ${peripheral.state}`);
    }
    
    // Double-check using our stored reference
    if (this.peripheral.state !== 'connected') {
      console.log('[NobleTransport] WARNING: Stored peripheral shows disconnected');
      console.log(`[NobleTransport] Original peripheral state: ${peripheral.state}`);
      console.log(`[NobleTransport] Stored peripheral state: ${this.peripheral.state}`);
      // Use the passed peripheral if it's still connected
      if (peripheral.state === 'connected') {
        console.log('[NobleTransport] Using passed peripheral reference');
      } else {
        throw new Error('Lost peripheral connection before service discovery');
      }
    }
    
    let services;
    let targetService;
    
    // Add service discovery with timeout
    const serviceDiscoveryWithTimeout = async () => {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Service discovery timeout')), NobleTransport.SERVICE_DISCOVERY_TIMEOUT);
      });
      
      return Promise.race([
        peripheral.discoverServicesAsync(),
        timeoutPromise
      ]);
    };
    
    try {
      console.log('[NobleTransport] Discovering ALL services (no filter)...');
      console.log(`[NobleTransport] Peripheral state before discovery: ${peripheral.state}`);
      console.log(`[NobleTransport] Peripheral ID for discovery: ${this.peripheralId}`);
      console.log(`[NobleTransport] Peripheral address: ${peripheral.address || 'unknown'}`);
      
      // One more check before discovery
      if (peripheral.state !== 'connected') {
        throw new Error(`Peripheral not connected before service discovery. State: ${peripheral.state}`);
      }
      
      // Additional delay before service discovery
      const preDiscoveryDelay = NobleTransport.TIMINGS.PRE_DISCOVERY_DELAY;
      console.log(`[NobleTransport] Waiting ${preDiscoveryDelay/1000} seconds before service discovery...`);
      await new Promise(resolve => setTimeout(resolve, preDiscoveryDelay));
      
      const allServices = await serviceDiscoveryWithTimeout();
      console.log(`[NobleTransport] Found ${allServices.length} services total`);
      
      for (const srv of allServices) {
        console.log(`[NobleTransport]   Service: ${srv.uuid}`);
        // On Linux, Noble returns short UUIDs from discovery
        // Compare the raw UUID with the short version of our target
        const shortServiceUuid = extractShortUuid(serviceUuid);
        if (srv.uuid === shortServiceUuid || srv.uuid === serviceUuid) {
          targetService = srv;
          console.log(`[NobleTransport]   ^ This is our target service!`);
        }
      }
      
      if (!targetService) {
        throw new Error(`Service ${serviceUuid} not found among ${allServices.length} services`);
      }
      
      console.log(`[NobleTransport] Using target service: ${targetService.uuid}`);
      
      // Discover characteristics for the service
      console.log('[NobleTransport] Discovering characteristics...');
      const characteristics = await targetService.discoverCharacteristicsAsync();
      console.log(`[NobleTransport] Found ${characteristics.length} characteristics`);
      
      // Find our characteristics
      for (const char of characteristics) {
        const uuid = char.uuid;
        console.log(`[NobleTransport]   Characteristic: ${uuid}`);
        // On Linux, Noble returns short UUIDs from discovery
        // Compare with both short and long versions
        const shortWriteUuid = extractShortUuid(writeUuid);
        const shortNotifyUuid = extractShortUuid(notifyUuid);
        
        if (uuid === shortWriteUuid || uuid === writeUuid) {
          this.writeChar = char;
          console.log('[NobleTransport]   -> This is the WRITE characteristic');
        } else if (uuid === shortNotifyUuid || uuid === notifyUuid) {
          this.notifyChar = char;
          console.log('[NobleTransport]   -> This is the NOTIFY characteristic');
        }
      }
    } catch (error: any) {
      console.log(`[NobleTransport] Service discovery error:`, error);
      
      // Check for "unknown peripheral" error in message or stdout
      const errorStr = error.toString();
      if (errorStr.toLowerCase().includes('unknown peripheral') || 
          (error.message && error.message.toLowerCase().includes('unknown peripheral'))) {
        console.log('[NobleTransport] Unknown peripheral error detected - marking for reset');
        console.log(`[NobleTransport] Error details: ${errorStr}`);
        console.log(`[NobleTransport] Peripheral ID was: ${this.peripheralId}`);
        NobleTransport.needsReset = true;
        throw new Error('Service discovery failed: Unknown peripheral. Device may have changed address or Noble state is corrupted.');
      }
      
      // Map numeric error codes to meaningful messages
      if (error.message === '8' || error.toString() === '8' || error === 8) {
        throw new Error('Service discovery failed: Connection terminated (error 8). This may indicate the device is busy or needs more time.');
      } else if (error.message === '62' || error.toString() === '62' || error === 62) {
        throw new Error('Service discovery failed: Connection timeout (error 62). The device may have disconnected.');
      } else if (error.message && error.message.includes('timeout')) {
        throw new Error('Service discovery failed: Operation timed out. The device may not be responding.');
      }
      throw error;
    }
    
    if (!this.writeChar || !this.notifyChar) {
      throw new Error('Required characteristics not found');
    }
    
    console.log('[NobleTransport] Found required characteristics');
    
    // Subscribe to notifications
    this.notifyChar.on('data', (data: Buffer) => {
      console.log(`[NobleTransport] Received data: ${data.length} bytes`);
      callbacks.onData(new Uint8Array(data));
    });
    await this.notifyChar.subscribeAsync();
    console.log('[NobleTransport] Subscribed to notifications');
    
    // Handle unexpected disconnect
    peripheral.once('disconnect', () => {
      console.log('[NobleTransport] Device disconnected');
      this.state = ConnectionState.DISCONNECTED;
      callbacks.onDisconnected();
    });
    
    console.log('[NobleTransport] Connection complete');
    this.state = ConnectionState.CONNECTED;
    } catch (error) {
      // Reset state on any error
      this.state = ConnectionState.DISCONNECTED;
      throw error;
    }
  }
  
  async sendData(data: Uint8Array): Promise<void> {
    if (!this.writeChar) throw new Error('Not connected');
    await this.writeChar.writeAsync(Buffer.from(data), false);
  }
  
  async disconnect(): Promise<void> {
    console.log(`[NobleTransport] Disconnecting from current state: ${this.state}`);
    
    // Always set state to disconnecting first
    this.state = ConnectionState.DISCONNECTING;
    
    try {
      if (this.notifyChar) {
        await this.notifyChar.unsubscribeAsync();
      }
      if (this.peripheral && this.peripheral.state === 'connected') {
        await this.peripheral.disconnectAsync();
      }
    } catch (error) {
      console.log('[NobleTransport] Error during disconnect (expected):', error);
    } finally {
      // Clear references
      this.peripheral = null;
      this.writeChar = null;
      this.notifyChar = null;
      
      // Platform-specific cooldown before marking as disconnected
      const cooldownMs = NobleTransport.TIMINGS.DISCONNECT_COOLDOWN;
      console.log(`[NobleTransport] Applying ${cooldownMs}ms cooldown for ${process.platform}`);
      await new Promise(resolve => setTimeout(resolve, cooldownMs));
      
      // Now safe to mark as disconnected
      this.state = ConnectionState.DISCONNECTED;
      console.log('[NobleTransport] Disconnection complete');
    }
  }
  
  getDeviceName(): string {
    return this.deviceName;
  }
  
  private async scanForDevice(devicePrefix: string): Promise<any> {
    
    // Atomic guard - only one scan at a time
    if (this.isScanning) {
      console.log('[NobleTransport] Scan already in progress');
      throw new Error('Scan already in progress');
    }
    
    // Enforce scanner recovery delay to allow GC to clean up previous scanner
    const timeSinceLastDestroy = Date.now() - NobleTransport.lastScannerDestroyTime;
    if (timeSinceLastDestroy < NobleTransport.SCANNER_RECOVERY_DELAY) {
      const waitTime = NobleTransport.SCANNER_RECOVERY_DELAY - timeSinceLastDestroy;
      console.log(`[NobleTransport] Waiting ${waitTime}ms for GC recovery before new scan`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.isScanning = true;
    
    try {
      console.log(`[NobleTransport] Starting scan for device prefix: ${devicePrefix}`);
      
      // Start fresh scanning each time
      await noble.startScanningAsync([], false);
      console.log('[NobleTransport] Scanning started');
      
      const generator = noble.discoverAsync();
      const timeout = Date.now() + NobleTransport.TIMINGS.SCAN_TIMEOUT;
      let peripheral = null;
      
      while (Date.now() < timeout) {
        const { value: device, done } = await generator.next();
        
        if (done) break;
        
        const name = device.advertisement.localName || '';
        if (this.logLevel === 'debug') {
          console.log(`[NobleTransport] Discovered: ${name || 'Unknown'} (${device.id})`);
        }
        
        if (name.startsWith(devicePrefix)) {
          console.log(`[NobleTransport] Found matching device: ${name}`);
          peripheral = device;
          break;
        }
      }
      
      // Always stop scanning and clean up generator
      await noble.stopScanningAsync();
      generator.return();
      
      // Clean up any scanStop listeners to prevent memory leak warnings
      noble.removeAllListeners('scanStop');
      
      if (!peripheral) {
        console.log('[NobleTransport] Scan timeout - no matching device found');
        throw new Error(`No device found with prefix: ${devicePrefix}`);
      }
      
      return peripheral;
    } finally {
      this.isScanning = false;
      // Mark when scanner cleanup completes to enforce GC delay
      NobleTransport.lastScannerDestroyTime = Date.now();
      console.log('[NobleTransport] Scanner cleanup complete, GC recovery timer started');
    }
  }
  
  async performQuickScan(duration: number): Promise<Array<{id: string, name?: string}>> {
    const devices: Array<{id: string, name?: string}> = [];
    
    try {
      // Ensure noble is ready
      if (noble.state !== 'poweredOn') {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Bluetooth not powered on'));
          }, 5000);
          
          noble.once('stateChange', (state) => {
            clearTimeout(timeout);
            if (state === 'poweredOn') {
              resolve();
            } else {
              reject(new Error(`Bluetooth state: ${state}`));
            }
          });
          
          // Check current state
          if (noble.state === 'poweredOn') {
            clearTimeout(timeout);
            resolve();
          }
        });
      }
      
      // Start scanning
      await noble.startScanningAsync([], false);
      
      // Collect devices for the specified duration
      const generator = noble.discoverAsync();
      const endTime = Date.now() + duration;
      
      while (Date.now() < endTime) {
        const timeLeft = endTime - Date.now();
        if (timeLeft <= 0) break;
        
        // Use race to timeout the generator
        const result = await Promise.race([
          generator.next(),
          new Promise<{done: boolean, value?: any}>(resolve => 
            setTimeout(() => resolve({ done: true }), timeLeft)
          )
        ]);
        
        if (result.done) break;
        
        const device = result.value;
        const name = device.advertisement.localName || '';
        
        // Add to list if not already present
        if (!devices.some(d => d.id === device.id)) {
          devices.push({ id: device.id, name });
        }
      }
      
      // Stop scanning
      await noble.stopScanningAsync();
      generator.return();
      
    } catch (error) {
      // Stop scanning on error
      try {
        await noble.stopScanningAsync();
      } catch {} // Ignore cleanup errors
      
      throw error;
    }
    
    return devices;
  }
}