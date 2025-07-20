import noble from '@stoprocent/noble';

// CS108 uses shortened UUIDs
const CS108_SERVICE_UUID = '9800';
const CS108_WRITE_UUID = '9900';
const CS108_NOTIFY_UUID = '9901';

interface Callbacks {
  onData: (data: Uint8Array) => void;
  onDisconnected: () => void;
}

export class NobleTransport {
  private peripheral: any = null;
  private writeChar: any = null;
  private notifyChar: any = null;
  private deviceName = '';

  async connect(devicePrefix: string, callbacks: Callbacks): Promise<void> {
    console.log(`[NobleTransport] Starting scan for device prefix: ${devicePrefix}`);
    
    // Start scanning
    await noble.startScanningAsync([], false);
    console.log('[NobleTransport] Scanning started');
    
    // Find device
    const peripheral = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        console.log('[NobleTransport] Scan timeout - no matching device found');
        noble.stopScanningAsync();
        reject(new Error(`No device found with prefix: ${devicePrefix}`));
      }, 10000);
      
      noble.on('discover', (p: any) => {
        const name = p.advertisement.localName || '';
        console.log(`[NobleTransport] Discovered: ${name || 'Unknown'} (${p.id})`);
        if (name.startsWith(devicePrefix)) {
          console.log(`[NobleTransport] Found matching device: ${name}`);
          clearTimeout(timer);
          noble.stopScanningAsync();
          resolve(p);
        }
      });
    });
    
    this.peripheral = peripheral;
    this.deviceName = peripheral.advertisement.localName || 'Unknown';
    
    // Connect
    console.log(`[NobleTransport] Connecting to ${this.deviceName}...`);
    await peripheral.connectAsync();
    console.log('[NobleTransport] Connected to BLE device');
    
    // Discover services and characteristics using shortened UUIDs
    console.log('[NobleTransport] Discovering services and characteristics...');
    const result = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [CS108_SERVICE_UUID],
      [CS108_WRITE_UUID, CS108_NOTIFY_UUID]
    );
    console.log(`[NobleTransport] Found ${result.services.length} services, ${result.characteristics.length} characteristics`);
    
    // Find our characteristics
    for (const char of result.characteristics) {
      const uuid = char.uuid;
      console.log(`[NobleTransport]   Characteristic: ${uuid}`);
      if (uuid === CS108_WRITE_UUID) {
        this.writeChar = char;
        console.log('[NobleTransport]   -> This is the WRITE characteristic');
      } else if (uuid === CS108_NOTIFY_UUID) {
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
      callbacks.onDisconnected();
    });
    
    console.log('[NobleTransport] Connection complete');
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
  }
  
  getDeviceName(): string {
    return this.deviceName;
  }
}