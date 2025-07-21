import noble from '@stoprocent/noble';

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
  private isScanning = false;
  
  // Scanner recovery delay management
  private static lastScannerDestroyTime = 0;
  private static SCANNER_RECOVERY_DELAY = 2000; // 2 seconds initially

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
      
      // Ensure Noble is ready
      if (noble.state !== 'poweredOn') {
        console.log(`[NobleTransport] Waiting for Bluetooth to power on (current state: ${noble.state})`);
        await noble.waitForPoweredOnAsync();
        console.log('[NobleTransport] Bluetooth powered on');
      }
      
      // Scan for device with atomic guard
      const peripheral = await this.scanForDevice(config.devicePrefix);
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
      const timeout = Date.now() + 10000; // 10 second timeout
      let peripheral = null;
      
      while (Date.now() < timeout) {
        const { value: device, done } = await generator.next();
        
        if (done) break;
        
        const name = device.advertisement.localName || '';
        console.log(`[NobleTransport] Discovered: ${name || 'Unknown'} (${device.id})`);
        
        if (name.startsWith(devicePrefix)) {
          console.log(`[NobleTransport] Found matching device: ${name}`);
          peripheral = device;
          break;
        }
      }
      
      // Always stop scanning and clean up generator
      await noble.stopScanningAsync();
      generator.return();
      
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
}