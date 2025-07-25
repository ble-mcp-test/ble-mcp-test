import noble from '@stoprocent/noble';
import { LogLevel } from './utils.js';
import { Logger } from './logger.js';

// Increase max listeners to prevent warnings during rapid connections and stress testing
noble.setMaxListeners(100);

// Track cleanup state to prevent concurrent cleanups
let cleanupInProgress = false;
let cleanupComplete = false;

// Global cleanup to ensure Noble doesn't keep process alive
export async function cleanupNoble(): Promise<void> {
  // If cleanup is already complete, return immediately
  if (cleanupComplete) {
    return;
  }
  
  // If cleanup is in progress, wait for it
  if (cleanupInProgress) {
    while (cleanupInProgress) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return;
  }
  
  cleanupInProgress = true;
  try {
    // Check if Noble is even initialized
    const nobleState = noble.state;
    const nobleBindings = (noble as any)._bindings;
    const isInitialized = nobleBindings && typeof nobleBindings.init === 'function';
    
    // Only try to stop scanning if Noble is actually initialized
    if (isInitialized && nobleState !== 'unknown' && nobleState !== 'unsupported') {
      // Check if we even have any active scanners
      const activeScanners = (NobleTransport as any).activeScanners || 0;
      
      if (activeScanners > 0) {
        try {
          await noble.stopScanningAsync();
        } catch {
          // Ignore stop scanning errors
        }
      }
    } else {
      cleanupComplete = true;
      return; // Skip all cleanup if Noble was never initialized
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
    
    cleanupComplete = true;
  } catch (error) {
    console.error('[NobleTransport] Error during global cleanup:', error);
  } finally {
    cleanupInProgress = false;
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
  private logger: Logger;
  
  constructor(logLevel: LogLevel = 'debug') {
    this.logLevel = logLevel;
    this.logger = new Logger('NobleTransport');
  }
  
  // Public method to check current pressure levels
  static checkPressure(): { [key: string]: number } {
    const eventNames = noble.eventNames();
    let nobleListeners = 0;
    eventNames.forEach(event => {
      nobleListeners += noble.listenerCount(event as string | symbol);
    });
    
    let bindingsListeners = 0;
    const bindings = (noble as any)._bindings;
    if (bindings && bindings.eventNames) {
      const bindingEvents = bindings.eventNames();
      bindingEvents.forEach((event: any) => {
        bindingsListeners += bindings.listenerCount(event);
      });
    }
    
    const peripherals = (noble as any)._peripherals || {};
    const peripheralCount = Object.keys(peripherals).length;
    let peripheralListeners = 0;
    Object.values(peripherals).forEach((p: any) => {
      if (p.eventNames) {
        p.eventNames().forEach((event: any) => {
          peripheralListeners += p.listenerCount(event);
        });
      }
    });
    
    return {
      nobleListeners,
      bindingsListeners,
      peripheralListeners,
      totalListeners: nobleListeners + bindingsListeners + peripheralListeners,
      peripheralCount,
      activeScanners: NobleTransport.activeScanners,
      scanStopListeners: noble.listenerCount('scanStop'),
      discoverListeners: noble.listenerCount('discover')
    };
  }
  
  // Expose timing configuration for logging
  static getTimingConfig() {
    return NobleTransport.TIMINGS;
  }
  
  // Scanner recovery delay management
  private static lastScannerDestroyTime = 0;
  private static SCANNER_RECOVERY_DELAY = 1000; // 1 second buffer
  
  // Track active scanner instances for pressure detection
  private static activeScanners = 0;
  
  // Service discovery timeout
  private static SERVICE_DISCOVERY_TIMEOUT = 60000; // 60 seconds - generous timeout
  
  // Connection retry management
  private static needsReset = false;
  
  // Platform-aware timing configuration with environment variable overrides
  private static readonly TIMINGS = (() => {
    // Platform defaults
    const defaults = (() => {
      switch (process.platform) {
        case 'darwin':
          return {
            // macOS timings - optimized for faster operations
            CONNECTION_STABILITY: 0,       // 0s - CS108 disconnects with any delay
            PRE_DISCOVERY_DELAY: 0,        // 0s - CS108 needs immediate discovery
            NOBLE_RESET_DELAY: 1000,       // 1s
            SCAN_TIMEOUT: 15000,           // 15s
            CONNECTION_TIMEOUT: 15000,     // 15s
            DISCONNECT_COOLDOWN: 200,      // 200ms base - Dynamic scaling based on listener pressure
          };
        
        case 'win32':
          return {
            // Windows timings - moderate delays for stability
            CONNECTION_STABILITY: 0,       // 0s - CS108 disconnects with any delay
            PRE_DISCOVERY_DELAY: 0,        // 0s - CS108 needs immediate discovery
            NOBLE_RESET_DELAY: 2000,       // 2s - Windows BLE is moderately stable
            SCAN_TIMEOUT: 15000,           // 15s
            CONNECTION_TIMEOUT: 15000,     // 15s
            DISCONNECT_COOLDOWN: 500,      // 500ms base - Windows (dynamic scaling applies)
          };
        
        default:  // linux, freebsd, etc.
          return {
            // Linux/Pi timings - needs longer delays for stability
            CONNECTION_STABILITY: 0,       // 0s - CS108 disconnects with any delay
            PRE_DISCOVERY_DELAY: 0,        // 0s - CS108 needs immediate discovery
            NOBLE_RESET_DELAY: 5000,       // 5s - Pi needs more recovery time
            SCAN_TIMEOUT: 15000,           // 15s
            CONNECTION_TIMEOUT: 15000,     // 15s
            DISCONNECT_COOLDOWN: 1000,     // 1s base - Linux/Pi (dynamic scaling applies)
          };
      }
    })();
    
    // Allow environment variable overrides
    return {
      CONNECTION_STABILITY: parseInt(process.env.BLE_CONNECTION_STABILITY || String(defaults.CONNECTION_STABILITY), 10),
      PRE_DISCOVERY_DELAY: parseInt(process.env.BLE_PRE_DISCOVERY_DELAY || String(defaults.PRE_DISCOVERY_DELAY), 10),
      NOBLE_RESET_DELAY: parseInt(process.env.BLE_NOBLE_RESET_DELAY || String(defaults.NOBLE_RESET_DELAY), 10),
      SCAN_TIMEOUT: parseInt(process.env.BLE_SCAN_TIMEOUT || String(defaults.SCAN_TIMEOUT), 10),
      CONNECTION_TIMEOUT: parseInt(process.env.BLE_CONNECTION_TIMEOUT || String(defaults.CONNECTION_TIMEOUT), 10),
      DISCONNECT_COOLDOWN: parseInt(process.env.BLE_DISCONNECT_COOLDOWN || String(defaults.DISCONNECT_COOLDOWN), 10),
    };
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
    
    let peripheral: any = null;
    
    // Helper to clean up ALL peripheral listeners
    const cleanupPeripheralListeners = () => {
      if (peripheral) {
        peripheral.removeAllListeners('connect');
        peripheral.removeAllListeners('disconnect');
      }
    };
    
    try {
      this.logger.info(`Starting scan for device prefix: ${config.devicePrefix}`);
      
      // Reset Noble if needed before starting
      if (NobleTransport.needsReset) {
        this.logger.info('Performing scheduled Noble reset');
        try {
          (noble as any).reset();
          NobleTransport.needsReset = false;
          await new Promise(resolve => setTimeout(resolve, NobleTransport.TIMINGS.NOBLE_RESET_DELAY));
        } catch (err) {
          this.logger.warn('Noble reset failed:', err);
        }
      }
      
      // Ensure Noble is ready with timeout
      if (noble.state !== 'poweredOn') {
        this.logger.info(`Waiting for Bluetooth to power on (current state: ${noble.state})`);
        
        // Add timeout to prevent hanging
        const poweredOnPromise = noble.waitForPoweredOnAsync();
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Timeout waiting for Noble to be powered on')), 10000);
        });
        
        try {
          await Promise.race([poweredOnPromise, timeoutPromise]);
          this.logger.info('Bluetooth powered on');
        } catch (error: any) {
          this.logger.error('Error:', error?.message || error);
          throw error;
        }
      }
      
      // Additional safety check - if Noble is in a bad state after waiting, fail fast
      if (noble.state === 'unsupported') {
        throw new Error(`Noble is in unusable state: ${noble.state}`);
      }
      
      // Scan for device with atomic guard
      peripheral = await this.scanForDevice(config.devicePrefix);
      if (!peripheral) {
        throw new Error(`No device found with prefix: ${config.devicePrefix}`);
      }
    
    this.peripheral = peripheral;
    this.peripheralId = peripheral.id;
    this.deviceName = peripheral.advertisement.localName || 'Unknown';
    
    this.logger.debug(`[NobleTransport] Peripheral ID: ${this.peripheralId}`);
    
    // Connect with event-based confirmation
    this.logger.debug(`[NobleTransport] Connecting to ${this.deviceName}...`);
    
    // Set up early disconnect handler to debug
    peripheral.once('disconnect', () => {
      this.logger.debug('[NobleTransport] EARLY DISCONNECT detected during connection!');
      this.logger.debug(`[NobleTransport] Peripheral state: ${peripheral.state}`);
    });
    
    // Set up connection promise with event listener
    const connectPromise = new Promise<void>((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        cleanupPeripheralListeners();
        reject(new Error('Connection timeout'));
      }, NobleTransport.TIMINGS.CONNECTION_TIMEOUT);
      
      peripheral.once('connect', () => {
        clearTimeout(connectTimeout);
        this.logger.debug('[NobleTransport] Connected event received');
        resolve();
      });
      
      // Start the connection
      peripheral.connectAsync().catch((err: any) => {
        clearTimeout(connectTimeout);
        cleanupPeripheralListeners();
        reject(err);
      });
    });
    
    await connectPromise;
    this.logger.debug('[NobleTransport] Connected to BLE device (confirmed by event)');
    this.logger.debug(`[NobleTransport] Peripheral state after connect: ${peripheral.state}`);
    
    // Normalize UUIDs for Noble.js
    const serviceUuid = normalizeUuid(config.serviceUuid);
    const writeUuid = normalizeUuid(config.writeUuid);
    const notifyUuid = normalizeUuid(config.notifyUuid);
    
    // Discover services and characteristics
    this.logger.debug('[NobleTransport] Discovering services and characteristics...');
    this.logger.debug(`[NobleTransport]   Service UUID: ${config.serviceUuid} -> ${serviceUuid}`);
    this.logger.debug(`[NobleTransport]   Write UUID: ${config.writeUuid} -> ${writeUuid}`);
    this.logger.debug(`[NobleTransport]   Notify UUID: ${config.notifyUuid} -> ${notifyUuid}`);
    
    // Wait for connection stability if needed
    const stabilityDelay = NobleTransport.TIMINGS.CONNECTION_STABILITY;
    if (stabilityDelay > 0) {
      this.logger.debug(`[NobleTransport] Waiting ${stabilityDelay/1000} seconds for connection stability...`);
      await new Promise(resolve => setTimeout(resolve, stabilityDelay));
    } else {
      this.logger.debug('[NobleTransport] Skipping stability delay - proceeding immediately to service discovery');
    }
    
    // Validate peripheral is still connected before service discovery
    if (peripheral.state !== 'connected') {
      throw new Error(`Peripheral disconnected during stability wait. State: ${peripheral.state}`);
    }
    
    // Double-check using our stored reference
    if (this.peripheral.state !== 'connected') {
      this.logger.debug('[NobleTransport] WARNING: Stored peripheral shows disconnected');
      this.logger.debug(`[NobleTransport] Original peripheral state: ${peripheral.state}`);
      this.logger.debug(`[NobleTransport] Stored peripheral state: ${this.peripheral.state}`);
      // Use the passed peripheral if it's still connected
      if (peripheral.state === 'connected') {
        this.logger.debug('[NobleTransport] Using passed peripheral reference');
      } else {
        throw new Error('Lost peripheral connection before service discovery');
      }
    }
    
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
      this.logger.debug('[NobleTransport] Discovering ALL services (no filter)...');
      this.logger.debug(`[NobleTransport] Peripheral state before discovery: ${peripheral.state}`);
      this.logger.debug(`[NobleTransport] Peripheral ID for discovery: ${this.peripheralId}`);
      this.logger.debug(`[NobleTransport] Peripheral address: ${peripheral.address || 'unknown'}`);
      
      // One more check before discovery
      if (peripheral.state !== 'connected') {
        throw new Error(`Peripheral not connected before service discovery. State: ${peripheral.state}`);
      }
      
      // Additional delay before service discovery
      const preDiscoveryDelay = NobleTransport.TIMINGS.PRE_DISCOVERY_DELAY;
      this.logger.debug(`[NobleTransport] Waiting ${preDiscoveryDelay/1000} seconds before service discovery...`);
      await new Promise(resolve => setTimeout(resolve, preDiscoveryDelay));
      
      const allServices = await serviceDiscoveryWithTimeout();
      this.logger.debug(`[NobleTransport] Found ${allServices.length} services total`);
      
      for (const srv of allServices) {
        this.logger.debug(`[NobleTransport]   Service: ${srv.uuid}`);
        // On Linux, Noble returns short UUIDs from discovery
        // Compare the raw UUID with the short version of our target
        const shortServiceUuid = extractShortUuid(serviceUuid);
        if (srv.uuid === shortServiceUuid || srv.uuid === serviceUuid) {
          targetService = srv;
          this.logger.debug(`[NobleTransport]   ^ This is our target service!`);
        }
      }
      
      if (!targetService) {
        throw new Error(`Service ${serviceUuid} not found among ${allServices.length} services`);
      }
      
      this.logger.debug(`[NobleTransport] Using target service: ${targetService.uuid}`);
      
      // Discover characteristics for the service
      this.logger.debug('[NobleTransport] Discovering characteristics...');
      const characteristics = await targetService.discoverCharacteristicsAsync();
      this.logger.debug(`[NobleTransport] Found ${characteristics.length} characteristics`);
      
      // Find our characteristics
      for (const char of characteristics) {
        const uuid = char.uuid;
        this.logger.debug(`[NobleTransport]   Characteristic: ${uuid}`);
        // On Linux, Noble returns short UUIDs from discovery
        // Compare with both short and long versions
        const shortWriteUuid = extractShortUuid(writeUuid);
        const shortNotifyUuid = extractShortUuid(notifyUuid);
        
        if (uuid === shortWriteUuid || uuid === writeUuid) {
          this.writeChar = char;
          this.logger.debug('[NobleTransport]   -> This is the WRITE characteristic');
        } else if (uuid === shortNotifyUuid || uuid === notifyUuid) {
          this.notifyChar = char;
          this.logger.debug('[NobleTransport]   -> This is the NOTIFY characteristic');
        }
      }
    } catch (error: any) {
      this.logger.debug(`[NobleTransport] Service discovery error:`, error);
      
      // Check for "unknown peripheral" error in message or stdout
      const errorStr = error.toString();
      if (errorStr.toLowerCase().includes('unknown peripheral') || 
          (error.message && error.message.toLowerCase().includes('unknown peripheral'))) {
        this.logger.debug('[NobleTransport] Unknown peripheral error detected - marking for reset');
        this.logger.debug(`[NobleTransport] Error details: ${errorStr}`);
        this.logger.debug(`[NobleTransport] Peripheral ID was: ${this.peripheralId}`);
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
    
    this.logger.debug('[NobleTransport] Found required characteristics');
    
    // Subscribe to notifications
    this.notifyChar.on('data', (data: Buffer) => {
      this.logger.debug(`[NobleTransport] Received data: ${data.length} bytes`);
      callbacks.onData(new Uint8Array(data));
    });
    await this.notifyChar.subscribeAsync();
    this.logger.debug('[NobleTransport] Subscribed to notifications');
    
    // Handle unexpected disconnect
    peripheral.once('disconnect', () => {
      this.logger.debug('[NobleTransport] Device disconnected');
      this.state = ConnectionState.DISCONNECTED;
      callbacks.onDisconnected();
    });
    
    this.logger.debug('[NobleTransport] Connection complete');
    this.state = ConnectionState.CONNECTED;
    } catch (error) {
      // CRITICAL: Clean up all listeners on ANY error
      cleanupPeripheralListeners();
      
      // Always reset state on ANY connection error
      this.state = ConnectionState.DISCONNECTED;
      
      // If we have a peripheral reference, try to disconnect it
      if (this.peripheral) {
        try {
          await this.peripheral.disconnectAsync();
        } catch (e) {
          // Ignore disconnect errors
          this.logger.debug('[NobleTransport] Error disconnecting peripheral during cleanup:', e);
        }
        this.peripheral = null;
      }
      
      // Clear any other references
      this.writeChar = null;
      this.notifyChar = null;
      
      throw error;
    }
  }
  
  async sendData(data: Uint8Array): Promise<void> {
    if (!this.writeChar) throw new Error('Not connected');
    await this.writeChar.writeAsync(Buffer.from(data), false);
  }
  
  async disconnect(): Promise<void> {
    this.logger.debug(`[NobleTransport] Disconnecting from current state: ${this.state}`);
    
    // If already disconnected or disconnecting, return early
    if (this.state === ConnectionState.DISCONNECTED || 
        this.state === ConnectionState.DISCONNECTING) {
      this.logger.debug('[NobleTransport] Already disconnected/disconnecting, skipping');
      return;
    }
    
    // Set state to disconnecting
    this.state = ConnectionState.DISCONNECTING;
    
    try {
      if (this.notifyChar) {
        await this.notifyChar.unsubscribeAsync();
      }
      if (this.peripheral && this.peripheral.state === 'connected') {
        await this.peripheral.disconnectAsync();
      }
    } catch (error) {
      this.logger.debug('[NobleTransport] Error during disconnect (expected):', error);
    } finally {
      // Clear references
      this.peripheral = null;
      this.writeChar = null;
      this.notifyChar = null;
      
      // Calculate dynamic cooldown based on listener pressure
      const baseCooldown = NobleTransport.TIMINGS.DISCONNECT_COOLDOWN;
      
      // Track multiple pressure indicators for a complete picture
      
      // 1. Noble event listeners (your current approach)
      const eventNames = noble.eventNames();
      let nobleListeners = 0;
      eventNames.forEach(event => {
        nobleListeners += noble.listenerCount(event as string | symbol);
      });
      
      // 2. HCI bindings listeners (where the real pressure builds)
      let bindingsListeners = 0;
      const bindings = (noble as any)._bindings;
      if (bindings && bindings.eventNames) {
        const bindingEvents = bindings.eventNames();
        bindingEvents.forEach((event: any) => {
          bindingsListeners += bindings.listenerCount(event);
        });
      }
      
      // 3. Peripheral count and their listeners
      const peripherals = (noble as any)._peripherals || {};
      const peripheralCount = Object.keys(peripherals).length;
      let peripheralListeners = 0;
      Object.values(peripherals).forEach((p: any) => {
        if (p.eventNames) {
          p.eventNames().forEach((event: any) => {
            peripheralListeners += p.listenerCount(event);
          });
        }
      });
      
      // 4. Track active scanner count (class-level)
      const activeScanners = NobleTransport.activeScanners;
      
      // 5. Check for specific high-pressure indicators
      const scanStopListeners = noble.listenerCount('scanStop');
      
      // Calculate total pressure from all sources
      const totalListeners = nobleListeners + bindingsListeners + peripheralListeners;
      
      // Use multiple pressure calculations
      const listenerPressure = Math.floor(totalListeners / 10); // Every 10 listeners = 1 pressure unit
      const peripheralPressure = Math.floor(peripheralCount / 3); // Every 3 peripherals = 1 pressure unit
      const scannerPressure = Math.floor(activeScanners / 2); // Every 2 active scanners = 1 pressure unit
      const criticalPressure = scanStopListeners > 10 ? Math.floor(scanStopListeners / 10) : 0; // Critical indicator
      
      // Use the highest pressure indicator
      const pressureMultiplier = Math.max(
        listenerPressure, 
        peripheralPressure, 
        scannerPressure,
        criticalPressure
      );
      
      // Dynamic cooldown: increase by 500ms per pressure unit
      const dynamicCooldown = baseCooldown + (pressureMultiplier * 500);
      
      
      if (pressureMultiplier > 0) {
        this.logger.debug(`[NobleTransport] Resource pressure detected (listeners: ${totalListeners}, peripherals: ${peripheralCount})`);
        this.logger.debug(`[NobleTransport] Dynamic cooldown: ${dynamicCooldown}ms (base: ${baseCooldown}ms + pressure: ${dynamicCooldown - baseCooldown}ms)`);
        if (this.logLevel === 'debug') {
          this.logger.debug(`[NobleTransport]   Details: Noble=${nobleListeners}, HCI=${bindingsListeners}, scanStop=${scanStopListeners}`);
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, dynamicCooldown));
      
      // Now safe to mark as disconnected
      this.state = ConnectionState.DISCONNECTED;
      this.logger.debug('[NobleTransport] Disconnection complete');
    }
  }
  
  getDeviceName(): string {
    return this.deviceName;
  }
  
  private async scanForDevice(devicePrefix: string): Promise<any> {
    
    // Atomic guard - only one scan at a time
    if (this.isScanning) {
      this.logger.debug('[NobleTransport] Scan already in progress');
      throw new Error('Scan already in progress');
    }
    
    // Enforce scanner recovery delay to allow GC to clean up previous scanner
    const timeSinceLastDestroy = Date.now() - NobleTransport.lastScannerDestroyTime;
    if (timeSinceLastDestroy < NobleTransport.SCANNER_RECOVERY_DELAY) {
      const waitTime = NobleTransport.SCANNER_RECOVERY_DELAY - timeSinceLastDestroy;
      if (this.logLevel === 'debug') {
        this.logger.debug(`[NobleTransport] Waiting ${waitTime}ms for GC recovery before new scan`);
      }
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.isScanning = true;
    NobleTransport.activeScanners++; // Track scanner instance
    
    try {
      this.logger.debug(`[NobleTransport] Starting scan for device prefix: ${devicePrefix}`);
      
      // Start fresh scanning each time
      await noble.startScanningAsync([], false);
      this.logger.debug('[NobleTransport] Scanning started');
      
      const generator = noble.discoverAsync();
      const timeout = Date.now() + NobleTransport.TIMINGS.SCAN_TIMEOUT;
      let peripheral = null;
      
      while (Date.now() < timeout) {
        const { value: device, done } = await generator.next();
        
        if (done) break;
        
        const name = device.advertisement.localName || '';
        if (this.logLevel === 'debug') {
          this.logger.debug(`[NobleTransport] Discovered: ${name || 'Unknown'} (${device.id})`);
        }
        
        if (name.startsWith(devicePrefix)) {
          this.logger.debug(`[NobleTransport] Found matching device: ${name}`);
          peripheral = device;
          break;
        }
        
        // Clean up excessive scanStop listeners during long scans
        // Noble's discoverAsync adds 3 listeners per next() call
        const scanStopCount = noble.listenerCount('scanStop');
        if (scanStopCount > 90) {
          if (this.logLevel === 'debug') {
            this.logger.debug(`[NobleTransport] Mid-scan cleanup of ${scanStopCount} scanStop listeners`);
          }
          noble.removeAllListeners('scanStop');
        }
      }
      
      // Always stop scanning and clean up generator
      await noble.stopScanningAsync();
      generator.return();
      
      // Clean up scanStop listeners that discoverAsync() adds
      // Each call to generator.next() adds 3 scanStop listeners that aren't removed
      // This is a Noble bug - the async generator leaks event listeners
      // We clean them up after each scan to prevent accumulation
      const scanStopCount = noble.listenerCount('scanStop');
      if (scanStopCount > 0) {
        if (this.logLevel === 'debug') {
          this.logger.debug(`[NobleTransport] Cleaning up ${scanStopCount} scanStop listeners from discoverAsync`);
        }
        noble.removeAllListeners('scanStop');
      }
      
      if (!peripheral) {
        this.logger.debug('[NobleTransport] Scan timeout - no matching device found');
        throw new Error(`No device found with prefix: ${devicePrefix}`);
      }
      
      return peripheral;
    } finally {
      this.isScanning = false;
      NobleTransport.activeScanners--; // Decrement scanner count
      // Mark when scanner cleanup completes to enforce GC delay
      NobleTransport.lastScannerDestroyTime = Date.now();
      if (this.logLevel === 'debug') {
        this.logger.debug('[NobleTransport] Scanner cleanup complete');
      }
    }
  }
  
  async performQuickScan(duration: number): Promise<Array<{id: string, name?: string, rssi?: number}>> {
    const devices: Array<{id: string, name?: string, rssi?: number}> = [];
    
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
          devices.push({ id: device.id, name, rssi: device.rssi });
        }
      }
      
      // Stop scanning
      await noble.stopScanningAsync();
      generator.return();
      
      // Clean up scanStop listeners from discoverAsync (Noble bug)
      const scanStopCount = noble.listenerCount('scanStop');
      if (scanStopCount > 0) {
        noble.removeAllListeners('scanStop');
      }
      
    } catch (error) {
      // Stop scanning on error
      try {
        await noble.stopScanningAsync();
      } catch {
        // Ignore cleanup errors
      }
      
      throw error;
    }
    
    return devices;
  }
}