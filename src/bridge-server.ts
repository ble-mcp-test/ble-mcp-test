import { WebSocketServer } from 'ws';
import { NobleTransport } from './noble-transport.js';
import { LogLevel, formatHex, getPackageMetadata } from './utils.js';
import { LogBuffer } from './log-buffer.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMcpTools } from './mcp-tools.js';
import { Logger } from './logger.js';
import { StateMachine, ServerState } from './state-machine.js';
import { ConnectionMutex } from './connection-mutex.js';
import { ConnectionContext } from './connection-context.js';

/**
 * WebSocket API v0.4.0 - Enhanced Connection Lifecycle
 * 
 * Special connection URLs:
 * - ws://localhost:8080/?command=health - Health check endpoint (server status + state machine)
 * - ws://localhost:8080/?command=log-stream - Real-time log streaming
 * 
 * Connection URL Parameters (for BLE connections):
 * - device: Device name prefix to search for (required)
 * - service: BLE service UUID (required)
 * - write: Write characteristic UUID (required)
 * - notify: Notify characteristic UUID (required)
 * 
 * Client → Server Messages:
 * - { type: 'data', data: number[] } - Send data to BLE device
 * - { type: 'disconnect' } - Graceful disconnect from BLE device
 * - { type: 'cleanup' } - Complete BLE cleanup (unsubscribe + disconnect)
 * - { type: 'force_cleanup', token: string } - Force cleanup with auth token (NEW)
 * - { type: 'check_pressure' } - Get Noble.js listener pressure metrics
 * - { type: 'keepalive' } - Reset idle timer, prevents eviction (NEW)
 * 
 * Server → Client Messages:
 * - { type: 'connected', device: string, token: string } - Connected with auth token (BREAKING)
 * - { type: 'disconnected' } - Disconnected from BLE device
 * - { type: 'data', data: number[] } - Data received from BLE device
 * - { type: 'error', error: string } - Error occurred
 * - { type: 'cleanup_complete', message: string } - Cleanup completed
 * - { type: 'force_cleanup_complete', message: string } - Force cleanup completed (NEW)
 * - { type: 'pressure_report', pressure: object } - Listener pressure metrics
 * - { type: 'health', status: string, free: boolean, state: string, transportState: string, connectionInfo: object, timestamp: string } - Health check (ENHANCED)
 * - { type: 'eviction_warning', grace_period_ms: number, reason: string } - Idle timeout warning (NEW)
 * - { type: 'keepalive_ack', timestamp: string } - Keepalive acknowledgment (NEW)
 * 
 * Breaking Changes in v0.4.0:
 * - 'connected' message now includes mandatory token field
 * - Health endpoint includes state machine state and connection info
 * - Clients are disconnected after idle timeout (default: 45s)
 * - Only one active connection allowed (enforced by mutex)
 * 
 * Environment Variables:
 * - BLE_MCP_CLIENT_IDLE_TIMEOUT: Idle timeout in ms (default: 45000)
 * - BLE_MCP_WS_PORT: WebSocket port (default: 8080)
 * - BLE_MCP_LOG_LEVEL: Logging level (debug|info|warn|error)
 */

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private transport: NobleTransport | null = null;
  private logClients: Set<any> = new Set();
  private logLevel: LogLevel;
  private logBuffer: LogBuffer;
  private logger: Logger;
  private mcpServer: McpServer;
  private stateMachine: StateMachine;
  private connectionMutex: ConnectionMutex;
  private activeConnection: ConnectionContext | null = null;
  private idleTimeout: number;
  private isCleaningUp = false;  // Track if cleanup is in progress
  
  constructor(logLevel: LogLevel = 'debug') {
    this.logLevel = logLevel;
    this.logger = new Logger('BridgeServer');
    this.logBuffer = new LogBuffer();
    
    // Initialize state management components
    this.stateMachine = new StateMachine();
    this.connectionMutex = new ConnectionMutex();
    
    // Get idle timeout from environment or use default
    this.idleTimeout = parseInt(process.env.BLE_MCP_CLIENT_IDLE_TIMEOUT || '45000', 10);
    this.logger.info(`Client idle timeout configured: ${this.idleTimeout}ms`);
    
    // Initialize MCP server
    const metadata = getPackageMetadata();
    this.mcpServer = new McpServer({
      name: metadata.name,
      version: metadata.version
    });
    
    // Register all MCP tools
    registerMcpTools(this.mcpServer, this);
  }
  async start(port?: number) {
    // Use provided port, or fall back to env var, or default to 8080
    const actualPort = port ?? parseInt(process.env.BLE_MCP_WS_PORT || '8080', 10);
    this.wss = new WebSocketServer({ port: actualPort });
    
    // Hook into console methods for log streaming
    this.interceptConsole();
    
    // Log BLE timing configuration to eliminate uncertainty
    this.logBleTimingConfig();
    
    // Perform startup BLE scan to verify functionality
    await this.performStartupScan();
    
    this.wss.on('connection', async (ws, req) => {
      const url = new URL(req.url!, `http://localhost`);
      
      // Check if this is a log streaming connection
      if (url.searchParams.get('command') === 'log-stream') {
        this.logClients.add(ws);
        ws.send(JSON.stringify({ 
          type: 'log', 
          timestamp: new Date().toISOString(),
          level: 'info',
          message: 'Connected to log stream' 
        }));
        
        ws.on('close', () => {
          this.logClients.delete(ws);
        });
        return;
      }
      
      // Check if this is a health check connection
      if (url.searchParams.get('command') === 'health') {
        // "Are you free, Mr. Bridge Server?"
        const isFree = this.connectionMutex.isFree();
        const serverState = this.stateMachine.getState();
        ws.send(JSON.stringify({ 
          type: 'health',
          status: 'ok',
          free: isFree,
          state: serverState,
          transportState: this.transport?.getState() || 'no-transport',
          message: isFree ? "I'm free!" : "I'm with a customer",
          connectionInfo: this.activeConnection?.getConnectionInfo() || null,
          timestamp: new Date().toISOString()
        }));
        ws.close();
        return;
      }
      
      // Parse BLE configuration from URL parameters
      const bleConfig = {
        devicePrefix: url.searchParams.get('device') || '',
        serviceUuid: url.searchParams.get('service') || '',
        writeUuid: url.searchParams.get('write') || '',
        notifyUuid: url.searchParams.get('notify') || ''
      };
      
      // Validate required parameters
      if (!bleConfig.devicePrefix || !bleConfig.serviceUuid || !bleConfig.writeUuid || !bleConfig.notifyUuid) {
        ws.send(JSON.stringify({ 
          type: 'error', 
          error: 'Missing required parameters: device, service, write, notify' 
        }));
        ws.close();
        return;
      }
      
      this.logger.info('New WebSocket connection');
      this.logger.debug(`  Device prefix: ${bleConfig.devicePrefix}`);
      this.logger.debug(`  Service UUID: ${bleConfig.serviceUuid}`);
      this.logger.debug(`  Write UUID: ${bleConfig.writeUuid}`);
      this.logger.debug(`  Notify UUID: ${bleConfig.notifyUuid}`);
      
      // Create transport if needed
      if (!this.transport) {
        this.transport = new NobleTransport(this.logLevel);
      }
      
      // Check if cleanup is in progress
      if (this.isCleaningUp) {
        this.logger.warn('Rejecting connection - cleanup in progress');
        ws.send(JSON.stringify({ 
          type: 'error', 
          error: 'System cleanup in progress, please try again' 
        }));
        ws.close();
        return;
      }

      // Check server state
      if (this.stateMachine.getState() !== ServerState.IDLE) {
        this.logger.warn(`Rejecting connection - server state: ${this.stateMachine.getState()}`);
        ws.send(JSON.stringify({ 
          type: 'error', 
          error: 'Another connection is active' 
        }));
        ws.close();
        return;
      }

      // Create connection context
      const connectionContext = new ConnectionContext(
        this.connectionMutex,
        this.stateMachine,
        {
          idleTimeout: this.idleTimeout,
          onEvictionWarning: (gracePeriodMs) => {
            ws.send(JSON.stringify({
              type: 'eviction_warning',
              grace_period_ms: gracePeriodMs,
              reason: 'idle_timeout'
            }));
          },
          onForceCleanup: () => {
            ws.send(JSON.stringify({
              type: 'disconnected'
            }));
            ws.close();
          }
        }
      );

      // Try to claim the connection with the context's token
      if (!this.connectionMutex.tryClaimConnection(connectionContext.getToken())) {
        this.logger.warn('Failed to claim connection mutex');
        ws.send(JSON.stringify({ 
          type: 'error', 
          error: 'Another connection is active' 
        }));
        ws.close();
        return;
      }

      // CRITICAL: Ensure mutex is always released, even on unexpected errors
      let mutexReleased = false;
      
      try {
        // Set active connection
        this.activeConnection = connectionContext;
        connectionContext.setWebSocket(ws);

        // Try to claim the transport connection
        if (!this.transport.tryClaimConnection()) {
          this.logger.warn(`Rejecting connection - BLE state: ${this.transport.getState()}`);
          ws.send(JSON.stringify({ 
            type: 'error', 
            error: 'BLE transport is not available' 
          }));
          ws.close();
          
          // Release mutex before returning
          this.connectionMutex.releaseConnection(connectionContext.getToken());
          mutexReleased = true;
          this.activeConnection = null;
          return;
        }
        // Connect to BLE device
        this.logger.info('Starting BLE connection...');
        
        // Track if we're already disconnecting to prevent loops
        let isDisconnecting = false;
        
        await this.transport.connect(bleConfig, {
          onData: (data) => {
            this.logger.debug(`Forwarding ${data.length} bytes to WebSocket`);
            
            if (this.logLevel === 'debug') {
              // Add to shared log buffer only in debug mode
              this.logBuffer.push('RX', data);
              this.logger.debug(`[RX] ${formatHex(data)}`);
            }
            ws.send(JSON.stringify({ type: 'data', data: Array.from(data) }));
          },
          onDisconnected: () => {
            if (!isDisconnecting) {
              this.logger.info('BLE disconnected, closing WebSocket');
              ws.send(JSON.stringify({ type: 'disconnected' }));
              ws.close();
            }
          }
        });
        
        // Transition to ACTIVE state
        this.stateMachine.transition(ServerState.ACTIVE, 'BLE connected');
        
        // Update connection context
        const deviceName = this.transport.getDeviceName();
        connectionContext.setDeviceName(deviceName);
        connectionContext.setBleTransport(this.transport);
        
        // Send connected message with token
        this.logger.info('BLE connected, sending connected message with token');
        ws.send(JSON.stringify({ 
          type: 'connected', 
          device: deviceName,
          token: connectionContext.getToken()
        }));
        
        // Start idle timer
        connectionContext.startIdleTimer();
        
        // Handle incoming messages
        ws.on('message', async (message) => {
          try {
            const msg = JSON.parse(message.toString());
            
            // Messages that reset idle timer
            const activityMessages = ['data', 'disconnect', 'cleanup', 'force_cleanup', 'check_pressure', 'keepalive'];
            if (activityMessages.includes(msg.type)) {
              connectionContext.resetIdleTimer();
            }
            
            switch (msg.type) {
              case 'data':
                if (msg.data && this.transport) {
                  const dataArray = new Uint8Array(msg.data);
                  
                  if (this.logLevel === 'debug') {
                    // Add to shared log buffer only in debug mode
                    this.logBuffer.push('TX', dataArray);
                    this.logger.debug(`[TX] ${formatHex(dataArray)}`);
                  }
                  await this.transport.sendData(dataArray);
                }
                break;
                
              case 'keepalive':
                this.logger.debug('Keepalive received');
                ws.send(JSON.stringify({
                  type: 'keepalive_ack',
                  timestamp: new Date().toISOString()
                }));
                break;
                
              case 'disconnect':
                this.logger.info('Disconnect requested via WebSocket');
                isDisconnecting = true;
                if (this.transport) {
                  await this.transport.disconnect();
                  ws.send(JSON.stringify({ type: 'disconnected' }));
                  ws.close();
                }
                break;
                
              case 'cleanup':
                this.logger.info('Cleanup requested via WebSocket');
                if (this.transport) {
                  // Use the new performCompleteCleanup method
                  await (this.transport as any).performCompleteCleanup('websocket-cleanup');
                  ws.send(JSON.stringify({ 
                    type: 'cleanup_complete',
                    message: 'BLE cleanup completed successfully'
                  }));
                }
                break;
                
              case 'force_cleanup':
                this.logger.info('Force cleanup requested via WebSocket');
                
                // Validate token
                if (!msg.token || !connectionContext.isOwner(msg.token)) {
                  this.logger.warn('Force cleanup rejected - invalid token');
                  ws.send(JSON.stringify({ 
                    type: 'error', 
                    error: 'Invalid token for force cleanup' 
                  }));
                  break;
                }
                
                // Set cleanup flag to block new connections
                this.isCleaningUp = true;
                
                try {
                  // Perform cleanup through context
                  await connectionContext.performCleanup('force_cleanup');
                  mutexReleased = true; // Mark mutex as released by performCleanup
                  
                  // Clear active connection
                  this.activeConnection = null;
                  
                  // Transition back to IDLE
                  this.stateMachine.transition(ServerState.IDLE, 'force cleanup');
                  
                  // Then do the static force cleanup
                  await NobleTransport.forceCleanup();
                  
                  // Wait a bit to ensure Noble is fully reset
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  
                  ws.send(JSON.stringify({ 
                    type: 'force_cleanup_complete',
                    message: 'Noble force cleanup completed successfully'
                  }));
                } finally {
                  // Always clear the cleanup flag
                  this.isCleaningUp = false;
                }
                break;
                
              case 'check_pressure': {
                this.logger.info('Pressure check requested via WebSocket');
                const pressure = NobleTransport.checkPressure();
                ws.send(JSON.stringify({ 
                  type: 'pressure_report',
                  pressure
                }));
                break;
              }
                
              default:
                this.logger.warn(`Unknown message type: ${msg.type}`);
            }
          } catch {
            // Ignore malformed messages
          }
        });
        
        // Clean disconnect on WebSocket close
        ws.on('close', async () => {
          this.logger.info('WebSocket closed, cleaning up connection');
          isDisconnecting = true;
          
          // Perform cleanup through context
          await connectionContext.performCleanup('websocket_closed');
          mutexReleased = true; // Mark mutex as released by performCleanup
          
          // Clear active connection
          this.activeConnection = null;
          
          // Clear transport reference if no other connections
          if (this.connectionMutex.isFree()) {
            this.transport = null;
          }
          
          // Transition back to IDLE
          if (this.stateMachine.getState() !== ServerState.IDLE) {
            this.stateMachine.transition(ServerState.IDLE, 'websocket closed');
          }
        });
        
      } catch (error: any) {
        this.logger.error('Error:', error?.message || error);
        
        try {
          ws.send(JSON.stringify({ 
            type: 'error', 
            error: error?.message || error?.toString() || 'Unknown error' 
          }));
          ws.close();
        } catch {
          // Ignore errors during error handling
        }
        
        // Mark mutex as needing release
        mutexReleased = false;
        
        // Clear active connection
        this.activeConnection = null;
        
        // Clear transport reference if no other connections
        if (this.connectionMutex.isFree()) {
          this.transport = null;
        }
        
        // Transition back to IDLE
        if (this.stateMachine.getState() !== ServerState.IDLE) {
          this.stateMachine.transition(ServerState.IDLE, 'connection error');
        }
      } finally {
        // CRITICAL: Always release mutex to prevent permanent lockup
        if (!mutexReleased) {
          try {
            // Use performCleanup which releases the mutex
            await connectionContext.performCleanup('finally_cleanup');
          } catch (cleanupError) {
            this.logger.error('Error during finally cleanup:', cleanupError);
            // Last resort: force release the mutex
            if (this.connectionMutex.isOwner(connectionContext.getToken())) {
              this.connectionMutex.releaseConnection(connectionContext.getToken());
            }
          }
        }
      }
    });
  }
  
  async stop() {
    this.logger.info('Stopping server...');
    
    // Close all WebSocket connections
    if (this.wss) {
      this.wss.clients.forEach((client) => {
        client.terminate();
      });
      
      // Properly close the server
      await new Promise<void>((resolve) => {
        this.wss!.close(() => {
          this.logger.debug('WebSocket server closed');
          resolve();
        });
      });
    }
    
    // Disconnect BLE transport
    if (this.transport) {
      await this.transport.disconnect();
      this.transport = null;
    }
    
    this.logger.info('Server stopped');
  }
  
  private interceptConsole() {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    
    console.log = (...args) => {
      originalLog.apply(console, args);
      const message = args.join(' ');
      this.broadcastLog('info', message);
      // Add console logs to the buffer for MCP get_logs tool
      this.logBuffer.pushSystemLog('INFO', message);
    };
    
    console.warn = (...args) => {
      originalWarn.apply(console, args);
      const message = args.join(' ');
      this.broadcastLog('warn', message);
      this.logBuffer.pushSystemLog('WARN', message);
    };
    
    console.error = (...args) => {
      originalError.apply(console, args);
      const message = args.join(' ');
      this.broadcastLog('error', message);
      this.logBuffer.pushSystemLog('ERROR', message);
    };
  }
  
  private broadcastLog(level: string, message: string) {
    const logEvent = {
      type: 'log',
      timestamp: new Date().toISOString(),
      level,
      message
    };
    
    const json = JSON.stringify(logEvent);
    this.logClients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(json);
      }
    });
  }
  
  private async performStartupScan() {
    this.logger.info('Performing startup BLE scan to verify functionality...');
    
    try {
      // Create a temporary transport just for scanning
      const scanTransport = new NobleTransport(this.logLevel);
      
      // Scan for 2 seconds to discover devices
      const devices = await scanTransport.performQuickScan(2000);
      
      if (devices.length > 0) {
        this.logger.info(`BLE is functional. Found ${devices.length} device(s):`);
        if (this.logLevel === 'debug') {
          devices.forEach(device => {
            this.logger.debug(`  - ${device.name || 'Unknown'} (${device.id})`);
          });
        }
      } else {
        this.logger.info('BLE is functional. No devices found in range.');
      }
      
      // Clean up the temporary transport
      await scanTransport.disconnect();
    } catch (error) {
      this.logger.error('BLE functionality check failed:', error);
      this.logger.error('The bridge server will start but BLE operations may fail.');
      this.logger.error('Please ensure:');
      this.logger.error('  - Bluetooth is enabled on this system');
      this.logger.error('  - Node.js has Bluetooth permissions');
      this.logger.error('  - No other process is using Bluetooth');
    }
  }
  
  private logBleTimingConfig() {
    this.logger.info('BLE Timing Configuration:');
    this.logger.info(`  Platform: ${process.platform}`);
    
    // Get actual timing configuration from NobleTransport
    const timings = NobleTransport.getTimingConfig();
    
    // Check which values are from environment overrides
    this.logger.info(`  CONNECTION_STABILITY: ${timings.CONNECTION_STABILITY}ms${process.env.BLE_MCP_CONNECTION_STABILITY ? ' (env override)' : ''}`);
    this.logger.info(`  PRE_DISCOVERY_DELAY: ${timings.PRE_DISCOVERY_DELAY}ms${process.env.BLE_MCP_PRE_DISCOVERY_DELAY ? ' (env override)' : ''}`);
    this.logger.info(`  NOBLE_RESET_DELAY: ${timings.NOBLE_RESET_DELAY}ms${process.env.BLE_MCP_NOBLE_RESET_DELAY ? ' (env override)' : ''}`);
    this.logger.info(`  SCAN_TIMEOUT: ${timings.SCAN_TIMEOUT}ms${process.env.BLE_MCP_SCAN_TIMEOUT ? ' (env override)' : ''}`);
    this.logger.info(`  CONNECTION_TIMEOUT: ${timings.CONNECTION_TIMEOUT}ms${process.env.BLE_MCP_CONNECTION_TIMEOUT ? ' (env override)' : ''}`);
    this.logger.info(`  DISCONNECT_COOLDOWN: ${timings.DISCONNECT_COOLDOWN}ms${process.env.BLE_MCP_DISCONNECT_COOLDOWN ? ' (env override)' : ''} (base - scales with load)`);
  }
  
  // MCP integration methods
  getLogBuffer(): LogBuffer {
    return this.logBuffer;
  }
  
  getMcpServer(): McpServer {
    return this.mcpServer;
  }
  
  getConnectionState(): { connected: boolean; deviceName?: string; connectedAt?: string; lastActivity?: string; token?: string } {
    if (this.activeConnection) {
      return this.activeConnection.getConnectionInfo();
    }
    return { connected: false };
  }
  
  async scanDevices(duration?: number): Promise<any[]> {
    // CRITICAL: Check connection state first
    if (this.transport && this.transport.getState() === 'connected') {
      throw new Error('Cannot scan while connected to a device. Please disconnect first.');
    }
    
    // Log scan start
    this.logger.info(`Starting BLE scan for ${duration || 5000}ms...`);
    
    // Use existing transport or create temporary one
    const scanTransport = this.transport || new NobleTransport(this.logLevel);
    const devices = await scanTransport.performQuickScan(duration || 5000);
    
    // Log scan results
    this.logger.info(`Scan complete. Found ${devices.length} device(s).`);
    if (devices.length > 0 && this.logLevel === 'debug') {
      devices.forEach(device => {
        this.logger.debug(`  - ${device.name || 'Unknown'} (${device.id}) RSSI: ${device.rssi}`);
      });
    }
    
    // Clean up temporary transport
    if (!this.transport && scanTransport) {
      await scanTransport.disconnect();
    }
    
    return devices.map(d => ({
      id: d.id,
      name: d.name || 'Unknown',
      rssi: d.rssi
    }));
  }
}