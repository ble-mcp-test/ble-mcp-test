import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import type { SharedState } from './shared-state.js';
import { SessionManager } from './session-manager.js';
import type { BleConfig } from './noble-transport.js';

/**
 * Normalize UUID based on platform requirements
 * Noble expects different formats on different platforms
 * @param uuid - UUID in short or full format
 * @returns Platform-appropriate UUID format
 */
function normalizeUuid(uuid: string): string {
  if (!uuid) return '';
  
  // Platform-specific UUID handling
  const platform = process.platform;
  
  // Check if it's a short UUID (4 hex chars)
  const isShortUuid = uuid.length === 4 && /^[0-9a-fA-F]{4}$/.test(uuid);
  
  if (platform === 'linux') {
    // Linux Noble (BlueZ) can work with short UUIDs directly
    if (isShortUuid) {
      return uuid.toLowerCase();
    }
    // For full UUIDs, remove dashes and lowercase
    return uuid.toLowerCase().replace(/-/g, '');
  } else if (platform === 'darwin' || platform === 'win32') {
    // macOS and Windows typically need full UUIDs
    if (isShortUuid) {
      // Expand short UUID to full Bluetooth UUID
      // Standard base: 00000000-0000-1000-8000-00805F9B34FB
      return `0000${uuid.toLowerCase()}00001000800000805f9b34fb`;
    }
    // For full UUIDs, remove dashes and lowercase
    return uuid.toLowerCase().replace(/-/g, '');
  } else {
    // Unknown platform - just clean up the UUID
    return uuid.toLowerCase().replace(/-/g, '');
  }
}

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
      
      // Parse BLE config with UUID normalization
      const rawService = url.searchParams.get('service') || '';
      const rawWrite = url.searchParams.get('write') || '';
      const rawNotify = url.searchParams.get('notify') || '';
      
      const config: BleConfig = {
        devicePrefix: url.searchParams.get('device') || '',
        serviceUuid: normalizeUuid(rawService),
        writeUuid: normalizeUuid(rawWrite),
        notifyUuid: normalizeUuid(rawNotify)
      };
      
      // Log UUID normalization if any were normalized
      if (rawService !== config.serviceUuid || rawWrite !== config.writeUuid || rawNotify !== config.notifyUuid) {
        console.log(`[Bridge] UUID normalization on ${process.platform}:`);
        if (rawService !== config.serviceUuid) {
          console.log(`  service: ${rawService} → ${config.serviceUuid}`);
        }
      }
      
      // Validate required parameters
      if (!config.devicePrefix || !config.serviceUuid || !config.writeUuid || !config.notifyUuid) {
        ws.send(JSON.stringify({ type: 'error', error: 'Missing required parameters: device, service, write, notify' }));
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