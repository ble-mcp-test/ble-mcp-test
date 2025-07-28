import { WebSocketServer } from 'ws';
import { NobleTransport } from './noble-transport.js';
import { LogLevel, formatHex, getPackageMetadata } from './utils.js';
import { LogBuffer } from './log-buffer.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMcpTools } from './mcp-tools.js';
import { Logger } from './logger.js';

/**
 * WebSocket API Commands:
 * 
 * Outgoing messages (client -> server):
 * - { type: 'data', data: number[] } - Send data to BLE device
 * - { type: 'disconnect' } - Disconnect from BLE device gracefully
 * - { type: 'cleanup' } - Perform complete BLE cleanup (unsubscribe + disconnect)
 * - { type: 'force_cleanup' } - Force Noble.js global cleanup (use with caution)
 * - { type: 'check_pressure' } - Get current Noble.js listener pressure metrics
 * 
 * Incoming messages (server -> client):
 * - { type: 'connected', device: string } - Connected to BLE device
 * - { type: 'disconnected' } - Disconnected from BLE device
 * - { type: 'data', data: number[] } - Data received from BLE device
 * - { type: 'error', error: string } - Error occurred
 * - { type: 'cleanup_complete', message: string } - Cleanup completed
 * - { type: 'force_cleanup_complete', message: string } - Force cleanup completed
 * - { type: 'pressure_report', pressure: object } - Listener pressure metrics
 */

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private transport: NobleTransport | null = null;
  private logClients: Set<any> = new Set();
  private logLevel: LogLevel;
  private logBuffer: LogBuffer;
  private logger: Logger;
  private mcpServer: McpServer;
  private connectionState: {
    connected: boolean;
    deviceName?: string;
    connectedAt?: string;
    lastActivity?: string;
  } = { connected: false };
  
  constructor(logLevel: LogLevel = 'debug') {
    this.logLevel = logLevel;
    this.logger = new Logger('BridgeServer');
    this.logBuffer = new LogBuffer();
    
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
    const actualPort = port ?? parseInt(process.env.WS_PORT || '8080', 10);
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
      
      // Try to claim the connection atomically
      if (!this.transport.tryClaimConnection()) {
        this.logger.warn(`Rejecting connection - BLE state: ${this.transport.getState()}`);
        ws.send(JSON.stringify({ 
          type: 'error', 
          error: 'Another connection is active' 
        }));
        ws.close();
        return;
      }
      
      try {
        // Connect to BLE device
        this.logger.info('Starting BLE connection...');
        
        // Track if we're already disconnecting to prevent loops
        let isDisconnecting = false;
        
        await this.transport.connect(bleConfig, {
          onData: (data) => {
            this.logger.debug(`Forwarding ${data.length} bytes to WebSocket`);
            
            // Add to shared log buffer
            this.logBuffer.push('RX', data);
            this.updateActivity();
            
            if (this.logLevel === 'debug') {
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
        
        // Update connection state
        this.connectionState = {
          connected: true,
          deviceName: this.transport.getDeviceName(),
          connectedAt: new Date().toISOString(),
          lastActivity: new Date().toISOString()
        };
        
        // Send connected message
        this.logger.info('BLE connected, sending connected message');
        ws.send(JSON.stringify({ 
          type: 'connected', 
          device: this.transport.getDeviceName() 
        }));
        
        // Handle incoming messages
        ws.on('message', async (message) => {
          try {
            const msg = JSON.parse(message.toString());
            
            switch (msg.type) {
              case 'data':
                if (msg.data && this.transport) {
                  const dataArray = new Uint8Array(msg.data);
                  
                  // Add to shared log buffer
                  this.logBuffer.push('TX', dataArray);
                  this.updateActivity();
                  
                  if (this.logLevel === 'debug') {
                    this.logger.debug(`[TX] ${formatHex(dataArray)}`);
                  }
                  await this.transport.sendData(dataArray);
                }
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
                // Call the static forceCleanup method
                await NobleTransport.forceCleanup();
                ws.send(JSON.stringify({ 
                  type: 'force_cleanup_complete',
                  message: 'Noble force cleanup completed successfully'
                }));
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
          this.logger.info('WebSocket closed, disconnecting BLE');
          isDisconnecting = true;
          if (this.transport) {
            await this.transport.disconnect();
            this.logger.debug('BLE disconnected successfully');
          }
          
          // Clear connection state
          this.connectionState = { connected: false };
        });
        
      } catch (error: any) {
        this.logger.error('Error:', error?.message || error);
        ws.send(JSON.stringify({ 
          type: 'error', 
          error: error?.message || error?.toString() || 'Unknown error' 
        }));
        ws.close();
        // Reset transport state on connection error
        if (this.transport) {
          await this.transport.disconnect();
        }
        // NOTE: We're keeping the transport instance to allow pressure accumulation
        // this.transport = null;
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
    this.logger.info(`  CONNECTION_STABILITY: ${timings.CONNECTION_STABILITY}ms${process.env.BLE_CONNECTION_STABILITY ? ' (env override)' : ''}`);
    this.logger.info(`  PRE_DISCOVERY_DELAY: ${timings.PRE_DISCOVERY_DELAY}ms${process.env.BLE_PRE_DISCOVERY_DELAY ? ' (env override)' : ''}`);
    this.logger.info(`  NOBLE_RESET_DELAY: ${timings.NOBLE_RESET_DELAY}ms${process.env.BLE_NOBLE_RESET_DELAY ? ' (env override)' : ''}`);
    this.logger.info(`  SCAN_TIMEOUT: ${timings.SCAN_TIMEOUT}ms${process.env.BLE_SCAN_TIMEOUT ? ' (env override)' : ''}`);
    this.logger.info(`  CONNECTION_TIMEOUT: ${timings.CONNECTION_TIMEOUT}ms${process.env.BLE_CONNECTION_TIMEOUT ? ' (env override)' : ''}`);
    this.logger.info(`  DISCONNECT_COOLDOWN: ${timings.DISCONNECT_COOLDOWN}ms${process.env.BLE_DISCONNECT_COOLDOWN ? ' (env override)' : ''} (base - scales with load)`);
  }
  
  // MCP integration methods
  getLogBuffer(): LogBuffer {
    return this.logBuffer;
  }
  
  getMcpServer(): McpServer {
    return this.mcpServer;
  }
  
  getConnectionState(): { connected: boolean; deviceName?: string; connectedAt?: string; lastActivity?: string } {
    return { ...this.connectionState };
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
  
  private updateActivity(): void {
    if (this.connectionState.connected) {
      this.connectionState.lastActivity = new Date().toISOString();
    }
  }
}