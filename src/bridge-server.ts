import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import type { SharedState } from './shared-state.js';
import { SessionManager } from './session-manager.js';
import type { BleConfig } from './noble-transport.js';
import { getPackageMetadata, normalizeUuid } from './utils.js';

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
      const isRpcMode = url.searchParams.get('rpc') === 'true';
      
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
      
      // Common connection handling function
      const handleConnection = async (config: BleConfig, rpcId?: string) => {
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
              const errorMsg = {
                type: rpcId ? 'rpc_response' : 'error',
                error: 'Device is busy with another session',
                blocking_session_id: blockingSession?.sessionId,
                device: config.devicePrefix
              };
              if (rpcId) {
                (errorMsg as any).rpc_id = rpcId;
                (errorMsg as any).method = 'requestDevice';
              }
              ws.send(JSON.stringify(errorMsg));
              ws.close();
              return;
            }
          }
          
          // Connect BLE if not already connected
          const deviceName = await session.connect();
          
          // Send connection success
          if (rpcId) {
            ws.send(JSON.stringify({ 
              type: 'rpc_response',
              rpc_id: rpcId,
              method: 'requestDevice',
              result: { 
                device: deviceName,
                sessionId: sessionId
              }
            }));
          } else {
            ws.send(JSON.stringify({ type: 'connected', device: deviceName }));
          }
          
          // Attach WebSocket to session
          this.sessionManager.attachWebSocket(session, ws);
          
        } catch (error: any) {
          console.error(`[Bridge] Connection error:`, error);
          const errorMsg = {
            type: rpcId ? 'rpc_response' : 'error',
            error: error.message || 'Connection failed'
          };
          if (rpcId) {
            (errorMsg as any).rpc_id = rpcId;
            (errorMsg as any).method = 'requestDevice';
          }
          ws.send(JSON.stringify(errorMsg));
          ws.close();
        }
      };
      
      // If RPC mode, wait for requestDevice RPC call
      if (isRpcMode) {
        console.log(`[Bridge] RPC mode - waiting for requestDevice RPC call`);
        
        // Set up a one-time message handler for the RPC request
        const handleRpcRequest = async (message: Buffer) => {
          try {
            const msg = JSON.parse(message.toString());
            
            if (msg.type === 'rpc_request' && msg.method === 'requestDevice') {
              console.log(`[Bridge] Received RPC requestDevice:`, JSON.stringify(msg.params));
              
              // Extract device filters and service UUIDs from requestDevice options
              const options = msg.params || {};
              let devicePrefix = '';
              let serviceUuid = '';
              
              // Process filters to extract device and service info
              if (options.filters && Array.isArray(options.filters)) {
                for (const filter of options.filters) {
                  // Extract device name/prefix
                  if (filter.namePrefix) {
                    devicePrefix = filter.namePrefix;
                  }
                  
                  // Extract service UUID
                  if (filter.services && filter.services.length > 0) {
                    serviceUuid = filter.services[0];
                  }
                }
              }
              
              // Default UUIDs if not specified (for backward compatibility)
              const config: BleConfig = {
                devicePrefix: devicePrefix,
                serviceUuid: normalizeUuid(serviceUuid || '9800'),
                writeUuid: normalizeUuid('9900'),
                notifyUuid: normalizeUuid('9901')
              };
              
              console.log(`[Bridge] RPC extracted config:`, config);
              
              // Continue with session creation as in legacy mode
              await handleConnection(config, msg.rpc_id);
              
            } else {
              ws.send(JSON.stringify({ 
                type: 'error', 
                error: 'Expected rpc_request with method requestDevice' 
              }));
              ws.close();
            }
          } catch (error: any) {
            console.error(`[Bridge] RPC parse error:`, error);
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid RPC request' }));
            ws.close();
          }
        };
        
        // Wait for the first message
        ws.once('message', handleRpcRequest);
        
      } else {
        // Legacy mode - parse from URL parameters
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
        
        await handleConnection(config);
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