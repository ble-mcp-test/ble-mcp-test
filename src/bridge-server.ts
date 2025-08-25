import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import type { SharedState } from './shared-state.js';
import { SessionManager } from './session-manager.js';
import type { BleConfig } from './noble-transport.js';
import { getPackageMetadata } from './utils.js';

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
      const sessionParam = url.searchParams.get('session');
      const sessionId = sessionParam || randomUUID();
      const forceConnect = url.searchParams.get('force') === 'true';
      
      // Enhanced debugging for session ID handling
      if (sessionParam) {
        console.log(`[Bridge] New WebSocket connection with provided session: ${sessionId}`);
      } else {
        console.log(`[Bridge] New WebSocket connection, generated session: ${sessionId}`);
      }
      
      console.log(`[Bridge] Request URL: ${req.url}`);
      console.log(`[Bridge] All URL params:`, Object.fromEntries(url.searchParams));
      
      // Sneaky check for mock version marker
      const mockVersion = url.searchParams.get('_mv');
      if (!mockVersion) {
        console.warn('⚠️  WARNING: WebSocket connection WITHOUT mock library!');
        console.warn('⚠️  This client is bypassing the Web Bluetooth mock and connecting directly.');
        console.warn('⚠️  They should be using injectWebBluetoothMock() instead of raw WebSocket.');
        console.warn('⚠️  See README.md for correct usage.');
      } else {
        const { version: expectedVersion } = getPackageMetadata();
        if (mockVersion !== expectedVersion) {
          console.warn(`⚠️  WARNING: Mock version mismatch! Expected ${expectedVersion}, got ${mockVersion}`);
        }
      }
      
      // Parse BLE config with UUID normalization
      const rawService = url.searchParams.get('service') || '';
      const rawWrite = url.searchParams.get('write') || '';
      const rawNotify = url.searchParams.get('notify') || '';
      
      const config: BleConfig = {
        devicePrefix: url.searchParams.get('device') || '',
        serviceUuid: rawService,   // Pass through - noble transport will handle variants
        writeUuid: rawWrite,       // Pass through - noble transport will normalize
        notifyUuid: rawNotify      // Pass through - noble transport will normalize
      };
      
      // Validate required parameters (device is now optional)
      if (!config.serviceUuid || !config.writeUuid || !config.notifyUuid) {
        ws.send(JSON.stringify({ type: 'error', error: 'Missing required parameters: service, write, notify' }));
        ws.close();
        return;
      }
      
      try {
        // Get or create session
        let session = this.sessionManager.getOrCreateSession(sessionId, config);
        
        if (!session) {
          // Session rejected - device is busy
          // Find the blocking session
          const blockingSession = this.sessionManager.getAllSessions()
            .find(s => s.getStatus().hasTransport);
          
          // If force parameter is set, clean up the blocking session
          if (forceConnect && blockingSession) {
            console.log(`[Bridge] Force takeover - cleaning up blocking session ${blockingSession.sessionId}`);
            await blockingSession.forceCleanup('force takeover');
            
            // Try again to create session
            const newSession = this.sessionManager.getOrCreateSession(sessionId, config);
            if (newSession) {
              session = newSession;
            }
          }
          
          if (!session) {
            ws.send(JSON.stringify({ 
              type: 'error', 
              error: 'Device is busy with another session',
              blocking_session_id: blockingSession?.sessionId,
              device: config.devicePrefix
            }));
            ws.close();
            return;
          }
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