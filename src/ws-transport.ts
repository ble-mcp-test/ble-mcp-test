import { CLOSE_CODE_MESSAGES } from './constants.js';

export interface WSMessage {
  // Wire types are exactly what the Python bridge emits: see SERVER_MESSAGE_TYPES
  // in bridge/src/ble_bridge/ws/protocol.py, checked mechanically by
  // test_wire_types_have_a_typescript_consumer. `disconnected` is the one
  // exception -- it never crosses the wire, it is synthesised below in onclose.
  type: 'connected' | 'data' | 'error' | 'warning' | 'disconnected';
  seq?: number;
  data?: number[];
  device?: string;
  error?: string;
  warning?: string;
}

export class WebSocketTransport {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private messageHandler?: (msg: WSMessage) => void;
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
          if (msg.type === 'warning') {
            // Interstitial, NOT terminal: the server sends this before `connected`
            // (bridge .../ws/server.py, _take_over) to say this client displaced
            // somebody. Log it and keep waiting — settling here would end the
            // handshake on a non-terminal frame.
            console.warn(`[Transport] Server warning: ${msg.warning}`);
          } else if (msg.type === 'connected') {
            clearTimeout(timeout);
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