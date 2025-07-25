import { WebSocketServer } from 'ws';
import { NobleTransport } from './noble-transport.js';
import { LogLevel, formatHex } from './utils.js';
import { LogBuffer } from './log-buffer.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMcpTools } from './mcp-tools.js';

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private transport: NobleTransport | null = null;
  private logClients: Set<any> = new Set();
  private logLevel: LogLevel;
  private logBuffer: LogBuffer;
  private mcpServer: McpServer;
  private connectionState: {
    connected: boolean;
    deviceName?: string;
    connectedAt?: string;
    lastActivity?: string;
  } = { connected: false };
  
  constructor(logLevel: LogLevel = 'debug') {
    this.logLevel = logLevel;
    this.logBuffer = new LogBuffer();
    
    // Initialize MCP server
    this.mcpServer = new McpServer({
      name: 'ble-mcp-test',
      version: '0.3.0'
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
      
      console.log(`[BridgeServer] New WebSocket connection`);
      console.log(`[BridgeServer]   Device prefix: ${bleConfig.devicePrefix}`);
      console.log(`[BridgeServer]   Service UUID: ${bleConfig.serviceUuid}`);
      console.log(`[BridgeServer]   Write UUID: ${bleConfig.writeUuid}`);
      console.log(`[BridgeServer]   Notify UUID: ${bleConfig.notifyUuid}`);
      
      // Create transport if needed
      if (!this.transport) {
        this.transport = new NobleTransport(this.logLevel);
      }
      
      // Try to claim the connection atomically
      if (!this.transport.tryClaimConnection()) {
        console.warn(`[BridgeServer] Rejecting connection - BLE state: ${this.transport.getState()}`);
        ws.send(JSON.stringify({ 
          type: 'error', 
          error: 'Another connection is active' 
        }));
        ws.close();
        return;
      }
      
      try {
        // Connect to BLE device
        console.log('[BridgeServer] Starting BLE connection...');
        
        // Track if we're already disconnecting to prevent loops
        let isDisconnecting = false;
        
        await this.transport.connect(bleConfig, {
          onData: (data) => {
            console.log(`[BridgeServer] Forwarding ${data.length} bytes to WebSocket`);
            
            // Add to shared log buffer
            this.logBuffer.push('RX', data);
            this.updateActivity();
            
            if (this.logLevel === 'debug') {
              console.log(`[RX] ${formatHex(data)}`);
            }
            ws.send(JSON.stringify({ type: 'data', data: Array.from(data) }));
          },
          onDisconnected: () => {
            if (!isDisconnecting) {
              console.log('[BridgeServer] BLE disconnected, closing WebSocket');
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
        console.log(`[BridgeServer] BLE connected, sending connected message`);
        ws.send(JSON.stringify({ 
          type: 'connected', 
          device: this.transport.getDeviceName() 
        }));
        
        // Handle incoming messages
        ws.on('message', async (message) => {
          try {
            const msg = JSON.parse(message.toString());
            if (msg.type === 'data' && msg.data && this.transport) {
              const dataArray = new Uint8Array(msg.data);
              
              // Add to shared log buffer
              this.logBuffer.push('TX', dataArray);
              this.updateActivity();
              
              if (this.logLevel === 'debug') {
                console.log(`[TX] ${formatHex(dataArray)}`);
              }
              await this.transport.sendData(dataArray);
            }
          } catch {
            // Ignore malformed messages
          }
        });
        
        // Clean disconnect on WebSocket close
        ws.on('close', async () => {
          console.log('[BridgeServer] WebSocket closed, disconnecting BLE');
          isDisconnecting = true;
          if (this.transport) {
            await this.transport.disconnect();
            console.log('[BridgeServer] BLE disconnected successfully');
          }
          
          // Clear connection state
          this.connectionState = { connected: false };
        });
        
      } catch (error: any) {
        console.error('[BridgeServer] Error:', error?.message || error);
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
    console.log('[BridgeServer] Stopping server...');
    
    // Close all WebSocket connections
    if (this.wss) {
      this.wss.clients.forEach((client) => {
        client.terminate();
      });
      
      // Properly close the server
      await new Promise<void>((resolve) => {
        this.wss!.close(() => {
          console.log('[BridgeServer] WebSocket server closed');
          resolve();
        });
      });
    }
    
    // Disconnect BLE transport
    if (this.transport) {
      await this.transport.disconnect();
      this.transport = null;
    }
    
    console.log('[BridgeServer] Server stopped');
  }
  
  private interceptConsole() {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    
    console.log = (...args) => {
      originalLog.apply(console, args);
      this.broadcastLog('info', args.join(' '));
    };
    
    console.warn = (...args) => {
      originalWarn.apply(console, args);
      this.broadcastLog('warn', args.join(' '));
    };
    
    console.error = (...args) => {
      originalError.apply(console, args);
      this.broadcastLog('error', args.join(' '));
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
    console.log('[BridgeServer] Performing startup BLE scan to verify functionality...');
    
    try {
      // Create a temporary transport just for scanning
      const scanTransport = new NobleTransport(this.logLevel);
      
      // Scan for 2 seconds to discover devices
      const devices = await scanTransport.performQuickScan(2000);
      
      if (devices.length > 0) {
        console.log(`[BridgeServer] BLE is functional. Found ${devices.length} device(s):`);
        if (this.logLevel === 'debug') {
          devices.forEach(device => {
            console.log(`[BridgeServer]   - ${device.name || 'Unknown'} (${device.id})`);
          });
        }
      } else {
        console.log('[BridgeServer] BLE is functional. No devices found in range.');
      }
      
      // Clean up the temporary transport
      await scanTransport.disconnect();
    } catch (error) {
      console.error('[BridgeServer] BLE functionality check failed:', error);
      console.error('[BridgeServer] The bridge server will start but BLE operations may fail.');
      console.error('[BridgeServer] Please ensure:');
      console.error('[BridgeServer]   - Bluetooth is enabled on this system');
      console.error('[BridgeServer]   - Node.js has Bluetooth permissions');
      console.error('[BridgeServer]   - No other process is using Bluetooth');
    }
  }
  
  private logBleTimingConfig() {
    console.log('[BridgeServer] BLE Timing Configuration:');
    console.log(`[BridgeServer]   Platform: ${process.platform}`);
    
    // Get actual timing configuration from NobleTransport
    const timings = NobleTransport.getTimingConfig();
    
    // Check which values are from environment overrides
    console.log(`[BridgeServer]   CONNECTION_STABILITY: ${timings.CONNECTION_STABILITY}ms${process.env.BLE_CONNECTION_STABILITY ? ' (env override)' : ''}`);
    console.log(`[BridgeServer]   PRE_DISCOVERY_DELAY: ${timings.PRE_DISCOVERY_DELAY}ms${process.env.BLE_PRE_DISCOVERY_DELAY ? ' (env override)' : ''}`);
    console.log(`[BridgeServer]   NOBLE_RESET_DELAY: ${timings.NOBLE_RESET_DELAY}ms${process.env.BLE_NOBLE_RESET_DELAY ? ' (env override)' : ''}`);
    console.log(`[BridgeServer]   SCAN_TIMEOUT: ${timings.SCAN_TIMEOUT}ms${process.env.BLE_SCAN_TIMEOUT ? ' (env override)' : ''}`);
    console.log(`[BridgeServer]   CONNECTION_TIMEOUT: ${timings.CONNECTION_TIMEOUT}ms${process.env.BLE_CONNECTION_TIMEOUT ? ' (env override)' : ''}`);
    console.log(`[BridgeServer]   DISCONNECT_COOLDOWN: ${timings.DISCONNECT_COOLDOWN}ms${process.env.BLE_DISCONNECT_COOLDOWN ? ' (env override)' : ''} (base - scales with load)`);
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
    
    // Use existing transport or create temporary one
    const scanTransport = this.transport || new NobleTransport(this.logLevel);
    const devices = await scanTransport.performQuickScan(duration || 5000);
    
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