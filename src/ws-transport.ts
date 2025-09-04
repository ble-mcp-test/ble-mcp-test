import { CLOSE_CODE_MESSAGES } from './constants.js';

export interface WSMessage {
  type: 'data' | 'connected' | 'disconnected' | 'error' | 'eviction_warning' | 'keepalive_ack' | 'force_cleanup' | 'force_cleanup_complete' | 'admin_cleanup';
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
    device?: string; 
    service?: string; 
    write?: string; 
    notify?: string;
    session?: string;
  }): Promise<void> {
    const url = new URL(this.serverUrl);
    if (options?.device) url.searchParams.set('device', options.device);
    if (options?.service) url.searchParams.set('service', options.service);
    if (options?.write) url.searchParams.set('write', options.write);
    if (options?.notify) url.searchParams.set('notify', options.notify);
    
    // Session management
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
      
      this.ws!.onclose = (event: CloseEvent) => {
        this.ws = null;
        
        // Handle application-specific close codes (4000-4999) during connection
        if (event.code >= 4000 && event.code <= 4999) {
          clearTimeout(timeout);
          
          // Create detailed error message based on close code
          const closeCodeMessage = CLOSE_CODE_MESSAGES[event.code as keyof typeof CLOSE_CODE_MESSAGES];
          const reason = event.reason || closeCodeMessage || 'Hardware connection failed';
          
          console.error(`[WebSocketTransport] Connection failed with code ${event.code}: ${reason}`);
          
          // Create error with close code for upstream handling
          const error = new Error(`Connection failed: ${reason}`) as Error & { code: number };
          error.code = event.code;
          
          reject(error);
          return;
        }
        
        // Handle other close events (after successful connection)
        if (this.messageHandler) {
          this.messageHandler({ 
            type: 'disconnected',
            error: event.code !== 1000 ? `Connection closed with code ${event.code}: ${event.reason}` : undefined
          });
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
    console.warn('[Transport] WARNING: Force cleanup is broken and creates zombies');
    
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
      
      // Listen for cleanup confirmation or warning
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'warning') {
            console.warn(`[Transport] Server warning: ${msg.warning}`);
            // Continue waiting for completion
          }
          if (msg.type === 'cleanup_complete' || msg.type === 'force_cleanup_complete') {
            if (msg.warning) {
              console.warn(`[Transport] Cleanup warning: ${msg.warning}`);
            }
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
      
      // Send force cleanup request (even though it's broken)
      const request: any = { type: 'force_cleanup' };
      if (this.connectionToken) {
        request.token = this.connectionToken;
      }
      console.warn('[Transport] Sending force_cleanup request (this is broken - creates zombies)');
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