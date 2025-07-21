import noble from '@stoprocent/noble';

// Increase max listeners to handle multiple sequential scans
// Noble's async generator can leak listeners during cleanup
noble.setMaxListeners(100);

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

export class NobleTransport {
  private peripheral: any = null;
  private writeChar: any = null;
  private notifyChar: any = null;
  private deviceName = '';
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private discoveredDevices: Map<string, any> = new Map();
  private scanInterval: any = null;
  private isScanning = false;
  
  constructor() {
    this.startBackgroundScanning();
  }

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
      console.log(`[NobleTransport] Looking for device prefix: ${config.devicePrefix}`);
      
      // Ensure Noble is ready
      if (noble.state !== 'poweredOn') {
        console.log(`[NobleTransport] Waiting for Bluetooth to power on (current state: ${noble.state})`);
        await noble.waitForPoweredOnAsync();
        console.log('[NobleTransport] Bluetooth powered on');
      }
      
      // Wait for device to appear in our cache (max 15 seconds)
      let peripheral: any = null;
      const timeout = Date.now() + 15000;
      
      while (Date.now() < timeout) {
        // Check discovered devices
        for (const [name, p] of this.discoveredDevices) {
          if (name.startsWith(config.devicePrefix)) {
            console.log(`[NobleTransport] Found cached device: ${name}`);
            peripheral = p;
            break;
          }
        }
        
        if (peripheral) break;
        
        // Wait a bit before checking again
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      if (!peripheral) {
        throw new Error(`No device found with prefix: ${config.devicePrefix}`);
      }
    
    this.peripheral = peripheral;
    this.deviceName = peripheral.advertisement.localName || 'Unknown';
    
    // Connect
    console.log(`[NobleTransport] Connecting to ${this.deviceName}...`);
    await peripheral.connectAsync();
    console.log('[NobleTransport] Connected to BLE device');
    
    // Discover services and characteristics
    console.log('[NobleTransport] Discovering services and characteristics...');
    console.log(`[NobleTransport]   Service UUID: ${config.serviceUuid}`);
    console.log(`[NobleTransport]   Write UUID: ${config.writeUuid}`);
    console.log(`[NobleTransport]   Notify UUID: ${config.notifyUuid}`);
    const result = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [config.serviceUuid],
      [config.writeUuid, config.notifyUuid]
    );
    console.log(`[NobleTransport] Found ${result.services.length} services, ${result.characteristics.length} characteristics`);
    
    // Find our characteristics
    for (const char of result.characteristics) {
      const uuid = char.uuid;
      console.log(`[NobleTransport]   Characteristic: ${uuid}`);
      if (uuid === config.writeUuid) {
        this.writeChar = char;
        console.log('[NobleTransport]   -> This is the WRITE characteristic');
      } else if (uuid === config.notifyUuid) {
        this.notifyChar = char;
        console.log('[NobleTransport]   -> This is the NOTIFY characteristic');
      }
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
    if (!this.peripheral) return;
    
    // Set state to disconnecting to prevent new connections
    this.state = ConnectionState.DISCONNECTING;
    
    try {
      if (this.notifyChar) {
        await this.notifyChar.unsubscribeAsync();
      }
      if (this.peripheral.state === 'connected') {
        await this.peripheral.disconnectAsync();
      }
    } catch (error) {
      // Ignore errors during disconnect
    } finally {
      // Always reset to disconnected state
      this.peripheral = null;
      this.writeChar = null;
      this.notifyChar = null;
      this.state = ConnectionState.DISCONNECTED;
    }
  }
  
  getDeviceName(): string {
    return this.deviceName;
  }
  
  private async startBackgroundScanning() {
    // Scan every 10 seconds when disconnected
    this.scanInterval = setInterval(async () => {
      if (this.state === ConnectionState.DISCONNECTED) {
        await this.performScan();
      }
    }, 10000);
    
    // Initial scan
    if (this.state === ConnectionState.DISCONNECTED) {
      await this.performScan();
    }
  }
  
  private async performScan() {
    // Atomic guard - if already scanning, skip
    if (this.isScanning) {
      console.log('[NobleTransport] Scan already in progress, skipping');
      return;
    }
    
    this.isScanning = true;
    
    try {
      // Ensure Noble is ready
      if (noble.state !== 'poweredOn') {
        await noble.waitForPoweredOnAsync();
      }
      
      console.log('[NobleTransport] Background scan started');
      
      // Clear old devices
      this.discoveredDevices.clear();
      
      // Scan for 5 seconds
      await noble.startScanningAsync([], false);
      
      const scanTimeout = Date.now() + 5000;
      for await (const peripheral of noble.discoverAsync()) {
        const name = peripheral.advertisement.localName || '';
        if (name) {
          this.discoveredDevices.set(name, peripheral);
          console.log(`[NobleTransport] Discovered: ${name}`);
        }
        
        if (Date.now() > scanTimeout) break;
      }
      
      await noble.stopScanningAsync();
      console.log(`[NobleTransport] Background scan complete. Found ${this.discoveredDevices.size} devices`);
    } catch (error) {
      console.error('[NobleTransport] Background scan error:', error);
    } finally {
      this.isScanning = false;
    }
  }
  
  destroy() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
  }
}