export interface WSMessage {
  type: 'data' | 'connected' | 'disconnected' | 'error' | 'eviction_warning' | 'keepalive_ack' | 'force_cleanup' | 'force_cleanup_complete' | 'admin_cleanup' | 'rpc_request' | 'rpc_response';
  seq?: number;
  data?: number[];
  device?: string;
  error?: string;
  token?: string; // v0.4.0: Authentication token for force cleanup
  grace_period_ms?: number; // v0.4.0: Eviction warning grace period
  reason?: string; // v0.4.0: Eviction reason
  timestamp?: string; // v0.4.0: Keepalive acknowledgment timestamp
  message?: string; // v0.4.5: Message for force cleanup complete
  all_sessions?: boolean; // v0.5.1: Force cleanup all sessions for device
  blocking_session_id?: string; // v0.5.1: Session blocking the connection
  auth?: string; // v0.5.1: Auth token for admin commands
  action?: string; // v0.5.1: Admin action type
  
  // RPC fields (v0.6.0)
  rpc_id?: string; // Unique ID to match request/response
  method?: string; // RPC method name (e.g., 'requestDevice')
  params?: any; // RPC parameters
  result?: any; // RPC result (for responses)
  
  // Extended RPC params for requestDevice (v0.6.0)
  characteristicUuids?: {
    write: string;
    notify: string;
  };
}

export class WebSocketTransport {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private messageHandler?: (msg: WSMessage) => void;
  private connectionToken?: string; // v0.4.0: Store token for force cleanup
  private sessionId?: string; // v0.4.5: Session management
  
  constructor(serverUrl = 'ws://localhost:8080') {
    this.serverUrl = serverUrl;
  }
  
  async connect(options?: { 
    session?: string;
    requestDeviceOptions?: any; // RPC mode only
  }): Promise<void> {
    if (!options?.requestDeviceOptions) {
      throw new Error('requestDeviceOptions required - WebSocket transport only supports RPC mode');
    }
    
    const url = new URL(this.serverUrl);
    
    // Only pass session ID in URL for routing
    if (options?.session) {
      url.searchParams.set('session', options.session);
      this.sessionId = options.session;
    }
    
    // Sneaky version marker - only set by the mock, never documented
    // This lets us detect when someone bypasses the mock
    // For browser builds, __PACKAGE_VERSION__ is replaced at build time
    let version: string;
    if (typeof __PACKAGE_VERSION__ !== 'undefined') {
      version = __PACKAGE_VERSION__;
    } else {
      // Dynamic import for Node.js environment only
      const { getPackageMetadata } = await import('./utils.js');
      version = getPackageMetadata().version;
    }
    url.searchParams.set('_mv', version);
    
    this.ws = new WebSocket(url.toString());
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);
      
      this.ws!.onopen = () => {
        // RPC mode: send requestDevice as first message
        console.log('[WSTransport] Sending RPC requestDevice');
        this.ws!.send(JSON.stringify({
          type: 'rpc_request',
          rpc_id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          method: 'requestDevice',
          params: options!.requestDeviceOptions
        }));
      };
      
      this.ws!.onmessage = (event) => {
        try {
          const msg: WSMessage = JSON.parse(event.data);
          if (msg.type === 'rpc_response' && msg.method === 'requestDevice') {
            clearTimeout(timeout);
            if (msg.error) {
              reject(new Error(msg.error));
            } else {
              // Store token if provided
              if (msg.token) {
                this.connectionToken = msg.token;
              }
              // Log device info
              if (msg.result?.device) {
                console.log('[WSTransport] RPC connected to device:', msg.result.device);
              }
              resolve();
            }
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
  
  // Session management methods
  getSessionId(): string | undefined {
    return this.sessionId;
  }
  
  async reconnectToSession(sessionId: string): Promise<void> {
    return this.connect({ session: sessionId });
  }
}