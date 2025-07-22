// Mock BLE transport for testing without hardware
import { ConnectionState } from './noble-transport.js';

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

export class MockBLETransport {
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private deviceName = '';
  private callbacks?: Callbacks;
  
  getState(): ConnectionState {
    return this.state;
  }

  tryClaimConnection(): boolean {
    if (this.state !== ConnectionState.DISCONNECTED) {
      return false;
    }
    this.state = ConnectionState.CONNECTING;
    return true;
  }

  async connect(config: BLEConfig, callbacks: Callbacks): Promise<void> {
    console.log(`[MockTransport] Simulating connection to ${config.devicePrefix}`);
    
    if (this.state !== ConnectionState.CONNECTING) {
      throw new Error(`Invalid state for connect: ${this.state}`);
    }

    this.callbacks = callbacks;
    this.deviceName = `${config.devicePrefix}-MOCK-12345`;
    
    // Simulate connection delay
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check for "NONEXISTENT" device to simulate no device found
    if (config.devicePrefix === 'NONEXISTENT') {
      throw new Error(`No device found with prefix: ${config.devicePrefix}`);
    }
    
    this.state = ConnectionState.CONNECTED;
    console.log(`[MockTransport] Connected to ${this.deviceName}`);
  }

  async sendData(data: Uint8Array): Promise<void> {
    if (this.state !== ConnectionState.CONNECTED) {
      throw new Error('Not connected');
    }
    
    console.log(`[MockTransport] Received data: [${Array.from(data).map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);
    
    // Simulate battery voltage response for testing
    if (data.length >= 10 && 
        data[8] === 0xA0 && data[9] === 0x00) {
      
      // Simulate battery response: a7 b3 04 d9 82 9e 59 8f a0 00 0f eb
      const response = new Uint8Array([0xa7, 0xb3, 0x04, 0xd9, 0x82, 0x9e, 0x59, 0x8f, 0xa0, 0x00, 0x0f, 0xeb]);
      
      setTimeout(() => {
        if (this.callbacks && this.state === ConnectionState.CONNECTED) {
          console.log(`[MockTransport] Sending battery response`);
          this.callbacks.onData(response);
        }
      }, 50);
    }
  }

  async disconnect(): Promise<void> {
    console.log(`[MockTransport] Disconnecting from state: ${this.state}`);
    this.state = ConnectionState.DISCONNECTING;
    
    // Simulate disconnect delay
    await new Promise(resolve => setTimeout(resolve, 50));
    
    this.state = ConnectionState.DISCONNECTED;
    this.callbacks = undefined;
    console.log('[MockTransport] Disconnection complete');
  }

  getDeviceName(): string {
    return this.deviceName;
  }
}