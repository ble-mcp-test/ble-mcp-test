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
  
  // Remove dashes and lowercase for processing
  const cleanUuid = uuid.toLowerCase().replace(/-/g, '');
  
  // Check if it's a short UUID (4 hex chars)
  const isShortUuid = cleanUuid.length === 4 && /^[0-9a-fA-F]{4}$/.test(cleanUuid);
  
  // Check if it's a standard Bluetooth UUID that can be shortened
  const isStandardLongUuid = cleanUuid.length === 32 && 
    cleanUuid.startsWith('0000') && 
    cleanUuid.endsWith('00001000800000805f9b34fb');
  
  if (platform === 'linux') {
    // Linux Noble (BlueZ) prefers short UUIDs
    if (isShortUuid) {
      return cleanUuid;
    }
    // If it's a standard long UUID, extract the short form
    if (isStandardLongUuid) {
      // Extract characters 5-8 (the short UUID part)
      return cleanUuid.substring(4, 8);
    }
    // Non-standard long UUID - return as-is
    return cleanUuid;
  } else if (platform === 'darwin' || platform === 'win32') {
    // macOS and Windows typically need full UUIDs
    if (isShortUuid) {
      // Expand short UUID to full Bluetooth UUID
      // Standard base: 00000000-0000-1000-8000-00805F9B34FB
      return `0000${cleanUuid}00001000800000805f9b34fb`;
    }
    // For full UUIDs, already cleaned
    return cleanUuid;
  } else {
    // Unknown platform - just return cleaned UUID
    return cleanUuid;
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
      
      // Sneaky check for mock version marker
      const mockVersion = url.searchParams.get('_mv');
      if (!mockVersion) {
        console.warn('⚠️  WARNING: WebSocket connection WITHOUT mock library!');
        console.warn('⚠️  This client is bypassing the Web Bluetooth mock and connecting directly.');
        console.warn('⚠️  They should be using injectWebBluetoothMock() instead of raw WebSocket.');
        console.warn('⚠️  See README.md for correct usage.');
      } else if (mockVersion !== '0.5.7') {
        console.warn(`⚠️  WARNING: Mock version mismatch! Expected 0.5.7, got ${mockVersion}`);
      }
      
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