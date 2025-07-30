/**
 * NUCLEAR SIMPLE BLE Transport
 * 
 * Just connect, send data, disconnect. No pressure monitoring,
 * no dynamic cooldowns, no platform detection complexity.
 * 
 * Target: <200 lines
 */

import noble from '@stoprocent/noble';

interface BLEConfig {
  devicePrefix: string;
  serviceUuid: string;
  writeUuid: string;
  notifyUuid: string;
}

interface Callbacks {
  onData: (data: Uint8Array) => void;
  onDisconnected: () => void;
}

export class SimpleTransport {
  private peripheral: any = null;
  private writeChar: any = null;
  private notifyChar: any = null;
  
  async connect(config: BLEConfig, callbacks: Callbacks): Promise<void> {
    if (this.peripheral) {
      throw new Error('Already connected');
    }
    
    console.log(`[SimpleTransport] Connecting to ${config.devicePrefix}`);
    
    // Wait for Noble to be ready
    if (noble.state !== 'poweredOn') {
      await noble.waitForPoweredOnAsync();
    }
    
    // Scan for device
    await noble.startScanningAsync([], false);
    
    const peripheral = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        noble.stopScanningAsync();
        reject(new Error(`Device ${config.devicePrefix} not found`));
      }, 15000);
      
      const onDiscover = (device: any) => {
        const name = device.advertisement.localName || '';
        const id = device.id;
        
        if (name.startsWith(config.devicePrefix) || id === config.devicePrefix) {
          clearTimeout(timeout);
          noble.removeListener('discover', onDiscover);
          noble.stopScanningAsync();
          resolve(device);
        }
      };
      
      noble.on('discover', onDiscover);
    });
    
    this.peripheral = peripheral;
    
    // Connect
    await peripheral.connectAsync();
    
    // Find service and characteristics
    const services = await peripheral.discoverServicesAsync();
    const targetService = services.find((s: any) => 
      s.uuid === config.serviceUuid || 
      s.uuid === config.serviceUuid.toLowerCase().replace(/-/g, '')
    );
    
    if (!targetService) {
      throw new Error(`Service ${config.serviceUuid} not found`);
    }
    
    const characteristics = await targetService.discoverCharacteristicsAsync();
    
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
      callbacks.onData(new Uint8Array(data));
    });
    
    await this.notifyChar.subscribeAsync();
    
    // Handle unexpected disconnect
    peripheral.once('disconnect', () => {
      callbacks.onDisconnected();
    });
  }
  
  async sendData(data: Uint8Array): Promise<void> {
    if (!this.writeChar) {
      throw new Error('Not connected');
    }
    await this.writeChar.writeAsync(Buffer.from(data), false);
  }
  
  async disconnect(): Promise<void> {
    if (this.peripheral) {
      try {
        if (this.notifyChar) {
          await this.notifyChar.unsubscribeAsync();
        }
        await this.peripheral.disconnectAsync();
      } catch {
        // Ignore disconnect errors
      }
    }
    
    this.peripheral = null;
    this.writeChar = null;
    this.notifyChar = null;
  }
  
  getDeviceName(): string {
    return this.peripheral?.advertisement?.localName || 
           this.peripheral?.id || 
           'Unknown';
  }
  
  isConnected(): boolean {
    return this.peripheral?.state === 'connected';
  }
}