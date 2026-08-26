import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import type { 
  NodeBleClientOptions, 
  BridgeResponse
} from './types.js';
import { getPackageMetadata } from './package-metadata.js';

export class NodeBleClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: NodeBleClientOptions;
  private connected: boolean = false;
  private reconnectCount: number = 0;
  private messageHandlers: Map<string, (response: BridgeResponse) => void> = new Map();
  private notificationHandler?: (data: Uint8Array) => void;

  constructor(options: NodeBleClientOptions) {
    super();
    
    // VALIDATION: Throw early for missing required parameters
    if (!options.sessionId) {
      throw new Error('sessionId is required - this prevents session conflicts and ensures predictable BLE connection management');
    }
    if (!options.service || !options.write || !options.notify) {
      throw new Error('service, write, and notify parameters are required');
    }
    
    // Set options with defaults
    this.options = {
      ...options,
      debug: options.debug ?? false,
      reconnectAttempts: options.reconnectAttempts ?? 3,
      reconnectDelay: options.reconnectDelay ?? 1000
    };
  }

  async getAvailability(): Promise<boolean> {
    // Always available when using WebSocket bridge
    return true;
  }

  // NEW: Direct write method (no GATT ceremony) - uses same pattern as E2E tests
  async writeValue(data: Uint8Array): Promise<void> {
    if (!this.connected) {
      throw new Error('Client not connected to bridge');
    }

    // Use the same 'data' message type as E2E tests (bridge only handles type: 'data')
    this.sendData(data);
    
    // For now, this is fire-and-forget like the E2E tests
    // The bridge doesn't send ACKs for data messages
  }

  // NEW: Direct notification setup (no characteristic object needed)
  onNotification(handler: (data: Uint8Array) => void): void {
    this.notificationHandler = handler;
  }

  // NEW: Async request/response pattern for command + wait for response
  async sendCommandAsync(command: Uint8Array, timeoutMs: number = 5000): Promise<Uint8Array> {
    if (!this.connected) {
      throw new Error('Client not connected to bridge');
    }

    return new Promise((resolve, reject) => {
      let responseReceived = false;
      const timeout = setTimeout(() => {
        if (!responseReceived) {
          reject(new Error('Command timeout'));
        }
      }, timeoutMs);

      // Set up one-time notification handler
      const originalHandler = this.notificationHandler;
      this.notificationHandler = (data: Uint8Array) => {
        if (responseReceived) return; // Prevent multiple responses
        responseReceived = true;
        clearTimeout(timeout);
        
        // Restore original handler
        this.notificationHandler = originalHandler;
        
        resolve(data);
      };

      // Send command
      this.writeValue(command).catch((error) => {
        clearTimeout(timeout);
        this.notificationHandler = originalHandler; // Restore on error
        reject(error);
      });
    });
  }

  async connect(): Promise<void> {
    let lastError: Error | null = null;
    let retryDelay = this.options.reconnectDelay!; // Will always be set by constructor

    for (let attempt = 1; attempt <= this.options.reconnectAttempts!; attempt++) {
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

        if (isRetryable && attempt < this.options.reconnectAttempts!) {
          if (this.options.debug) {
            console.log(`[NodeBleClient] Bridge busy (${error.message}), retry ${attempt}/${this.options.reconnectAttempts!} in ${retryDelay}ms...`);
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
    if (this.options.deviceId) url.searchParams.set('deviceId', this.options.deviceId);
    if (this.options.deviceName) url.searchParams.set('deviceName', this.options.deviceName);
    url.searchParams.set('service', this.options.service);
    url.searchParams.set('write', this.options.write);
    url.searchParams.set('notify', this.options.notify);
    
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

        // Handle data messages (notifications from device) - same pattern as E2E tests
        if (msg.type === 'data' && msg.data) {
          // Forward to notification handler if set
          if (this.notificationHandler && msg.data) {
            // Convert data back to Uint8Array - handle both string and number[] formats
            const data = Array.isArray(msg.data) 
              ? new Uint8Array(msg.data)
              : new Uint8Array([]); // Fallback for string format
            this.notificationHandler(data);
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

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
    this.emit('disconnect');
  }


  async destroy(): Promise<void> {
    await this.disconnect();
    this.removeAllListeners();
  }

  private handleDisconnect(): void {
    this.connected = false;
    this.ws = null;
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