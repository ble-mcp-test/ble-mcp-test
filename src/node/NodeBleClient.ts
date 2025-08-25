import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import type { 
  NodeBleClientOptions, 
  BridgeResponse, 
  RequestDeviceOptions 
} from './types.js';
import { NodeBleDevice } from './NodeBleDevice.js';
import { getPackageMetadata } from '../utils.js';

export class NodeBleClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: Required<NodeBleClientOptions>;
  private devices: Map<string, NodeBleDevice> = new Map();
  private connected: boolean = false;
  private reconnectCount: number = 0;
  private connectionToken?: string;
  private messageHandlers: Map<string, (response: BridgeResponse) => void> = new Map();
  private currentDevice?: NodeBleDevice;

  constructor(options: NodeBleClientOptions) {
    super();
    
    // Set default options
    this.options = {
      bridgeUrl: options.bridgeUrl,
      device: options.device || '',
      service: options.service || '',
      write: options.write || '',
      notify: options.notify || '',
      sessionId: options.sessionId || randomUUID(),
      debug: options.debug || false,
      reconnectAttempts: options.reconnectAttempts || 3,
      reconnectDelay: options.reconnectDelay || 1000
    };
  }

  async getAvailability(): Promise<boolean> {
    // Always available when using WebSocket bridge
    return true;
  }

  async requestDevice(options?: RequestDeviceOptions): Promise<NodeBleDevice> {
    if (!this.connected) {
      throw new Error('Client not connected to bridge');
    }

    // Extract device name from filters if provided
    let deviceName = this.options.device;
    if (options?.filters) {
      for (const filter of options.filters) {
        if (filter.namePrefix) {
          deviceName = filter.namePrefix;
          break;
        }
      }
    }

    // Create or get existing device
    const deviceId = deviceName || 'default-device';
    let device = this.devices.get(deviceId);
    
    if (!device) {
      device = new NodeBleDevice(
        deviceId,
        deviceName || null,
        this
      );
      this.devices.set(deviceId, device);
    }

    this.currentDevice = device;
    return device;
  }

  async getDevices(): Promise<NodeBleDevice[]> {
    // Return all known devices
    return Array.from(this.devices.values());
  }

  async connect(): Promise<void> {
    let lastError: Error | null = null;
    let retryDelay = this.options.reconnectDelay;

    for (let attempt = 1; attempt <= this.options.reconnectAttempts; attempt++) {
      try {
        await this.connectInternal();
        
        if (attempt > 1 && this.options.debug) {
          console.log(`[NodeBleClient] Connected successfully after ${attempt} attempts`);
        }
        
        return;
      } catch (error: any) {
        lastError = error;

        // Check if error is retryable
        const retryableErrors = [
          'Bridge is disconnecting',
          'Bridge is connecting',
          'only ready state accepts connections',
          'Connection timeout'
        ];

        const isRetryable = retryableErrors.some(msg =>
          error.message?.includes(msg)
        );

        if (isRetryable && attempt < this.options.reconnectAttempts) {
          if (this.options.debug) {
            console.log(`[NodeBleClient] Bridge busy (${error.message}), retry ${attempt}/${this.options.reconnectAttempts} in ${retryDelay}ms...`);
          }

          await new Promise(resolve => setTimeout(resolve, retryDelay));

          // Exponential backoff
          retryDelay = Math.min(
            retryDelay * 1.5,
            10000 // Max 10 second delay
          );

          continue;
        }

        // Non-retryable error or max retries reached
        throw error;
      }
    }

    // If we get here, we've exhausted retries
    throw lastError || new Error('Failed to connect after maximum retries');
  }

  private async connectInternal(): Promise<void> {
    // Build WebSocket URL with parameters
    const url = new URL(this.options.bridgeUrl);
    
    // Add BLE configuration parameters
    if (this.options.device) url.searchParams.set('device', this.options.device);
    if (this.options.service) url.searchParams.set('service', this.options.service);
    if (this.options.write) url.searchParams.set('write', this.options.write);
    if (this.options.notify) url.searchParams.set('notify', this.options.notify);
    
    // Map sessionId to session parameter (critical for bridge compatibility)
    url.searchParams.set('session', this.options.sessionId);
    
    // Add version marker
    const { version } = getPackageMetadata();
    url.searchParams.set('_mv', version);

    if (this.options.debug) {
      console.log(`[NodeBleClient] Connecting to: ${url.toString()}`);
    }

    // Create WebSocket connection
    this.ws = new WebSocket(url.toString());

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);

      this.ws!.on('open', () => {
        if (this.options.debug) {
          console.log('[NodeBleClient] WebSocket opened, waiting for connected message...');
        }
      });

      this.ws!.on('message', (data: WebSocket.Data) => {
        try {
          const msg: BridgeResponse = JSON.parse(data.toString());
          
          if (msg.type === 'connected') {
            clearTimeout(timeout);
            this.connected = true;
            
            // Store connection token if provided
            if ((msg as any).token) {
              this.connectionToken = (msg as any).token;
            }
            
            if (this.options.debug) {
              console.log(`[NodeBleClient] Connected to bridge`);
            }
            
            // Set up ongoing message handler
            this.setupMessageHandler();
            
            resolve();
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            reject(new Error(msg.error || 'Connection failed'));
          }
        } catch (err) {
          // Ignore invalid messages during connection
          if (this.options.debug) {
            console.warn('[NodeBleClient] Invalid message during connection:', err);
          }
        }
      });

      this.ws!.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      this.ws!.on('close', () => {
        this.connected = false;
        this.ws = null;
        this.emit('disconnect');
        
        // Notify all devices of disconnection
        this.devices.forEach(device => {
          device.handleDisconnect();
        });
      });
    });
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;

    this.ws.removeAllListeners('message');
    
    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg: BridgeResponse = JSON.parse(data.toString());
        
        if (this.options.debug) {
          console.log('[NodeBleClient] Received message:', msg.type);
        }

        // Handle response to specific request
        if (msg.id && this.messageHandlers.has(msg.id)) {
          const handler = this.messageHandlers.get(msg.id)!;
          this.messageHandlers.delete(msg.id);
          handler(msg);
          return;
        }

        // Handle notifications
        if (msg.type === 'notification' && msg.data) {
          // Forward to current device
          if (this.currentDevice) {
            this.currentDevice.handleNotification(msg.characteristic || '', msg.data);
          }
        } else if (msg.type === 'disconnected') {
          // Handle unexpected disconnection
          this.handleDisconnect();
        } else if (msg.type === 'error') {
          this.emit('error', new Error(msg.error || 'Bridge error'));
        }
      } catch (err) {
        if (this.options.debug) {
          console.warn('[NodeBleClient] Error processing message:', err);
        }
      }
    });
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    // Send force_cleanup if we have a token
    if (this.connectionToken && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        await this.sendForceCleanup();
      } catch (error) {
        if (this.options.debug) {
          console.warn('[NodeBleClient] Force cleanup failed:', error);
        }
      }
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
    this.emit('disconnect');
  }

  private async sendForceCleanup(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Force cleanup timeout'));
      }, 5000);

      const messageId = randomUUID();
      
      this.messageHandlers.set(messageId, (response) => {
        clearTimeout(timeout);
        if (response.type === 'ack' || (response as any).type === 'force_cleanup_complete') {
          resolve();
        } else {
          reject(new Error('Force cleanup failed'));
        }
      });

      const request = {
        type: 'force_cleanup',
        id: messageId,
        token: this.connectionToken
      };

      this.ws!.send(JSON.stringify(request));
    });
  }

  async destroy(): Promise<void> {
    await this.disconnect();
    this.removeAllListeners();
    this.devices.clear();
  }

  private handleDisconnect(): void {
    this.connected = false;
    this.ws = null;
    
    // Notify all devices
    this.devices.forEach(device => {
      device.handleDisconnect();
    });
    
    this.emit('disconnect');
  }

  // Internal methods for device communication
  async sendMessage(message: any): Promise<BridgeResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to bridge');
    }

    const messageId = randomUUID();
    message.id = messageId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.messageHandlers.delete(messageId);
        reject(new Error('Message timeout'));
      }, 5000);

      this.messageHandlers.set(messageId, (response) => {
        clearTimeout(timeout);
        if (response.type === 'error') {
          reject(new Error(response.error || 'Bridge error'));
        } else {
          resolve(response);
        }
      });

      this.ws!.send(JSON.stringify(message));
    });
  }

  sendData(data: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to bridge');
    }

    const message = {
      type: 'data',
      data: Array.from(data)
    };

    this.ws.send(JSON.stringify(message));
  }

  isConnected(): boolean {
    return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getSessionId(): string {
    return this.options.sessionId;
  }
}