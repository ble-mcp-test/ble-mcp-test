export interface WSMessage {
  type: 'data' | 'connected' | 'disconnected' | 'error' | 'eviction_warning' | 'keepalive_ack';
  seq?: number;
  data?: number[];
  device?: string;
  error?: string;
  token?: string; // v0.4.0: Authentication token for force cleanup
  grace_period_ms?: number; // v0.4.0: Eviction warning grace period
  reason?: string; // v0.4.0: Eviction reason
  timestamp?: string; // v0.4.0: Keepalive acknowledgment timestamp
}

export class WebSocketTransport {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private messageHandler?: (msg: WSMessage) => void;
  private connectionToken?: string; // v0.4.0: Store token for force cleanup
  
  constructor(serverUrl = 'ws://localhost:8080') {
    this.serverUrl = serverUrl;
  }
  
  async connect(options?: { device?: string; service?: string; write?: string; notify?: string }): Promise<void> {
    const url = new URL(this.serverUrl);
    if (options?.device) url.searchParams.set('device', options.device);
    if (options?.service) url.searchParams.set('service', options.service);
    if (options?.write) url.searchParams.set('write', options.write);
    if (options?.notify) url.searchParams.set('notify', options.notify);
    
    this.ws = new WebSocket(url.toString());
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);
      
      this.ws!.onopen = () => {
        // WebSocket opened, wait for connected message
      };
      
      this.ws!.onmessage = (event) => {
        try {
          const msg: WSMessage = JSON.parse(event.data);
          if (msg.type === 'connected') {
            clearTimeout(timeout);
            // v0.4.0: Store token for force cleanup
            if (msg.token) {
              this.connectionToken = msg.token;
            }
            resolve();
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            reject(new Error(msg.error || 'Connection failed'));
          }
        } catch {
          // Ignore invalid messages
        }
      };
      
      this.ws!.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket error'));
      };
      
      this.ws!.onclose = () => {
        this.ws = null;
        if (this.messageHandler) {
          this.messageHandler({ type: 'disconnected' });
        }
      };
    });
  }
  
  send(data: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }
    this.ws.send(JSON.stringify({ 
      type: 'data', 
      data: Array.from(data) 
    }));
  }
  
  onMessage(callback: (msg: WSMessage) => void): void {
    this.messageHandler = callback;
    if (this.ws) {
      this.ws.onmessage = (event) => {
        try {
          const msg: WSMessage = JSON.parse(event.data);
          if (this.messageHandler) {
            this.messageHandler(msg);
          }
        } catch {
          // Ignore invalid messages
        }
      };
    }
  }
  
  async forceCleanup(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Force cleanup timeout'));
      }, 5000);
      
      // Store reference to WebSocket
      const ws = this.ws!;
      const originalHandler = ws.onmessage;
      
      // Listen for cleanup confirmation
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'cleanup_complete' || msg.type === 'force_cleanup_complete') {
            clearTimeout(timeout);
            ws.onmessage = originalHandler;
            resolve();
          } else if (originalHandler) {
            originalHandler.call(ws, event);
          }
        } catch {
          if (originalHandler) originalHandler.call(ws, event);
        }
      };
      
      // Send force cleanup request
      // v0.4.0: Include token for authentication
      const request: any = { type: 'force_cleanup' };
      if (this.connectionToken) {
        request.token = this.connectionToken;
      }
      ws.send(JSON.stringify(request));
    });
  }
  
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
  
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}