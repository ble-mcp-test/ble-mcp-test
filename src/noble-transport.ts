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
  CONNECTED = 'connected'
}

export class NobleTransport {
  private peripheral: any = null;
  private writeChar: any = null;
  private notifyChar: any = null;
  private deviceName = '';
  private state: ConnectionState = ConnectionState.DISCONNECTED;

  getState(): ConnectionState {
    return this.state;
  }

  async connect(config: BLEConfig, callbacks: Callbacks): Promise<void> {
    if (this.state !== ConnectionState.DISCONNECTED) {
      throw new Error(`Cannot connect in state: ${this.state}`);
    }
    
    this.state = ConnectionState.CONNECTING;
    
    try {
      console.log(`[NobleTransport] Starting scan for device prefix: ${config.devicePrefix}`);
      
      // Ensure Noble is ready
    if (noble.state !== 'poweredOn') {
      console.log(`[NobleTransport] Waiting for Bluetooth to power on (current state: ${noble.state})`);
      await new Promise<void>((resolve) => {
        noble.once('stateChange', (state) => {
          if (state === 'poweredOn') {
            console.log('[NobleTransport] Bluetooth powered on');
            resolve();
          }
        });
      });
    }
    
    // Start scanning
    await noble.startScanningAsync([], false);
    console.log('[NobleTransport] Scanning started');
    
    // Find device
    const peripheral = await new Promise<any>((resolve, reject) => {
      let found = false;
      const timer = setTimeout(async () => {
        if (!found) {
          console.log('[NobleTransport] Scan timeout - no matching device found');
          noble.removeAllListeners('discover');
          await noble.stopScanningAsync();
          reject(new Error(`No device found with prefix: ${config.devicePrefix}`));
        }
      }, 10000);
      
      const discoverHandler = async (p: any) => {
        const name = p.advertisement.localName || '';
        console.log(`[NobleTransport] Discovered: ${name || 'Unknown'} (${p.id})`);
        if (!found && name.startsWith(config.devicePrefix)) {
          found = true;
          console.log(`[NobleTransport] Found matching device: ${name}`);
          clearTimeout(timer);
          noble.removeListener('discover', discoverHandler);
          await noble.stopScanningAsync();
          resolve(p);
        }
      };
      
      noble.on('discover', discoverHandler);
    });
    
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
    
    try {
      if (this.notifyChar) {
        await this.notifyChar.unsubscribeAsync();
      }
      if (this.peripheral.state === 'connected') {
        await this.peripheral.disconnectAsync();
      }
    } catch (error) {
      // Ignore errors during disconnect
    }
    
    this.peripheral = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.state = ConnectionState.DISCONNECTED;
  }
  
  getDeviceName(): string {
    return this.deviceName;
  }
}