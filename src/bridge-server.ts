import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import type { SharedState } from './shared-state.js';
import { SessionManager } from './session-manager.js';
import type { BleConfig } from './noble-transport.js';

/**
 * BridgeServer - HTTP server and WebSocket routing
 * 
 * Simplified server that only handles:
 * - WebSocket server setup
 * - URL parameter parsing
 * - Session routing
 */
export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private sessionManager: SessionManager;
  
  constructor(logLevel?: string, sharedState?: SharedState) {
    this.sessionManager = new SessionManager(sharedState);
    console.log(`[Bridge] Session-based architecture initialized`);
  }

  async start(port = 8080) {
    this.wss = new WebSocketServer({ port });
    console.log(`🚀 Session-based bridge listening on port ${port}`);
    
    this.wss.on('connection', async (ws, req) => {
      // Parse BLE config from URL
      const url = new URL(req.url || '', 'http://localhost');
      
      // Extract session ID or generate new one
      const sessionId = url.searchParams.get('session') || randomUUID();
      
      // Parse BLE config
      const config: BleConfig = {
        devicePrefix: url.searchParams.get('device') || '',
        serviceUuid: url.searchParams.get('service') || '',
        writeUuid: url.searchParams.get('write') || '',
        notifyUuid: url.searchParams.get('notify') || ''
      };
      
      // Validate required parameters
      if (!config.devicePrefix || !config.serviceUuid || !config.writeUuid || !config.notifyUuid) {
        ws.send(JSON.stringify({ type: 'error', error: 'Missing required parameters: device, service, write, notify' }));
        ws.close();
        return;
      }
      
      console.log(`[Bridge] New WebSocket connection for session: ${sessionId}`);
      
      try {
        // Get or create session
        const session = this.sessionManager.getOrCreateSession(sessionId, config);
        
        if (!session) {
          // Session rejected - device is busy
          ws.send(JSON.stringify({ type: 'error', error: 'Device is busy with another session' }));
          ws.close();
          return;
        }
        
        // Connect BLE if not already connected
        const deviceName = await session.connect();
        
        // Send connection success
        ws.send(JSON.stringify({ type: 'connected', device: deviceName }));
        
        // Attach WebSocket to session
        this.sessionManager.attachWebSocket(session, ws);
        
      } catch (error: any) {
        console.error(`[Bridge] Connection error:`, error);
        ws.send(JSON.stringify({ type: 'error', error: error.message || 'Connection failed' }));
        ws.close();
      }
    });
  }
  
  async stop() {
    console.log('[Bridge] Stopping...');
    await this.sessionManager.stop();
    
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
  
  // Minimal observability interface for backward compatibility
  getConnectionState() {
    const sessions = this.sessionManager.getAllSessions();
    const activeSession = sessions.find(s => s.getStatus().connected);
    
    return {
      connected: !!activeSession,
      deviceName: activeSession?.getStatus().deviceName || null,
      recovering: false,
      state: activeSession ? 'active' : 'ready'
    };
  }
  
  getState(): string {
    const sessions = this.sessionManager.getAllSessions();
    return sessions.some(s => s.getStatus().connected) ? 'active' : 'ready';
  }
  
  async scanDevices(): Promise<any[]> {
    return []; // Ultra simple - no scanning
  }
}