import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import type { SharedState } from './shared-state.js';
import { SessionManager } from './session-manager.js';
import type { BleConfig } from './noble-transport.js';
import { getPackageMetadata } from './utils.js';
import { MetricsTracker } from './connection-metrics.js';
import { 
  WEBSOCKET_CLOSE_CODES, 
  CLOSE_CODE_MESSAGES, 
  mapErrorToCloseCode 
} from './constants.js';

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
        service: rawService,       // Pass through - noble transport will handle variants
        write: rawWrite,           // Pass through - noble transport will normalize
        notify: rawNotify,         // Pass through - noble transport will normalize
        deviceId: url.searchParams.get('deviceId') || undefined,
        deviceName: url.searchParams.get('deviceName') || undefined,
        timeout: url.searchParams.get('timeout') ? parseInt(url.searchParams.get('timeout')!, 10) : undefined
      };
      
      // Validate required parameters (device is now optional)
      if (!config.service || !config.write || !config.notify) {
        ws.send(JSON.stringify({ type: 'error', error: 'Missing required parameters: service, write, notify' }));
        ws.close();
        return;
      }
      
      let session: any = null;
      
      try {
        // Get or create session (now async - waits for cleanup if needed)
        console.log(`[Bridge] Requesting session: ${sessionId}`);
        session = await this.sessionManager.getOrCreateSession(sessionId, config);
        
        if (!session) {
          // Session rejected - device is busy or cleanup timeout
          // Find the blocking session
          const blockingSession = this.sessionManager.getAllSessions()
            .find(s => s.getStatus().hasTransport);
          
          // If force parameter is set, clean up the blocking session
          if (forceConnect && blockingSession) {
            console.log(`[Bridge] Force takeover - cleaning up blocking session ${blockingSession.sessionId}`);
            await blockingSession.forceCleanup('force takeover');
            
            // Try again to create session
            const newSession = await this.sessionManager.getOrCreateSession(sessionId, config);
            if (newSession) {
              session = newSession;
            }
          }
          
          if (!session) {
            const closeCode = WEBSOCKET_CLOSE_CODES.HARDWARE_NOT_FOUND;
            const message = 'Device is busy with another session';
            ws.close(closeCode, message);
            return;
          }
        }
        
        // Check if session has existing transport or needs connection
        let deviceName: string;
        const status = session.getStatus();
        
        if (status.hasTransport) {
          // Session has existing transport - reuse it
          console.log(`[Bridge] Session ${sessionId} has existing transport, reusing connection to ${status.deviceName || 'unnamed'}`);
          deviceName = status.deviceName || 'unnamed';
          
          // Track session reuse for monitoring
          MetricsTracker.getInstance().recordSessionReuse(sessionId);
          
          // Trust existing characteristic references
          console.log(`[Bridge] Trusting existing characteristics for session ${sessionId}`);
        } else {
          // Need to connect
          console.log(`[Bridge] Starting BLE connection for session ${sessionId}`);
          deviceName = await session.connect();
          console.log(`[Bridge] Connected to device: ${deviceName}`);
        }
        
        // BLE validation successful - accept WebSocket connection
        console.log(`[Bridge] BLE validation successful for session ${sessionId} - accepting WebSocket connection`);
        ws.send(JSON.stringify({ type: 'connected', device: deviceName }));
        
        // Attach WebSocket to session
        this.sessionManager.attachWebSocket(session, ws);
        
      } catch (error: any) {
        console.error(`[Bridge] Connection validation failed for session ${sessionId}:`, error.message || error);
        console.error(`[Bridge] Error stack:`, error.stack);
        
        // Don't remove the session - it might be reused by the next test
        // The session will clean itself up via grace period/idle timeout
        // This allows tests to retry with the same session ID
        console.log(`[Bridge] Keeping session ${sessionId} for potential reuse despite error`);
        
        // Map error to appropriate WebSocket close code
        const closeCode = mapErrorToCloseCode(error);
        const message = CLOSE_CODE_MESSAGES[closeCode] || error.message || 'Connection failed';
        
        console.log(`[Bridge] Closing WebSocket with code ${closeCode}: ${message}`);
        ws.close(closeCode, message);
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