import { WebSocketServer } from 'ws';
import { NobleTransport, ConnectionState } from './noble-transport.js';

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private transport: NobleTransport | null = null;
  private zombieCheckInterval: any = null;
  private logClients: Set<any> = new Set();

  start(port = 8080) {
    this.wss = new WebSocketServer({ port });
    
    // Hook into console methods for log streaming
    this.interceptConsole();
    
    // Start zombie connection check every 30 seconds
    this.zombieCheckInterval = setInterval(() => {
      this.checkForZombieConnections();
    }, 30000);
    
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
      
      // Check if another connection is active
      if (this.transport && this.transport.getState() !== ConnectionState.DISCONNECTED) {
        console.warn(`[BridgeServer] Rejecting connection - BLE state: ${this.transport.getState()}`);
        ws.send(JSON.stringify({ 
          type: 'error', 
          error: 'Another connection is active' 
        }));
        ws.close();
        return;
      }
      
      // Create transport if needed
      if (!this.transport) {
        this.transport = new NobleTransport();
      }
      
      try {
        // Connect to BLE device
        console.log('[BridgeServer] Starting BLE connection...');
        
        // Track if we're already disconnecting to prevent loops
        let isDisconnecting = false;
        
        await this.transport.connect(bleConfig, {
          onData: (data) => {
            console.log(`[BridgeServer] Forwarding ${data.length} bytes to WebSocket`);
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
              await this.transport.sendData(new Uint8Array(msg.data));
            }
          } catch (error) {
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
            // Small delay to ensure transport state is fully reset
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        });
        
      } catch (error: any) {
        console.error('[BridgeServer] Error:', error?.message || error);
        ws.send(JSON.stringify({ 
          type: 'error', 
          error: error?.message || error?.toString() || 'Unknown error' 
        }));
        ws.close();
        // Reset transport state on connection error
        this.transport = null;
      }
    });
  }
  
  stop() {
    if (this.zombieCheckInterval) {
      clearInterval(this.zombieCheckInterval);
      this.zombieCheckInterval = null;
    }
    this.wss?.close();
    this.transport?.disconnect();
  }
  
  private checkForZombieConnections() {
    // If we have a BLE connection but no WebSocket connections (excluding log clients), it's a zombie
    const activeBleClients = Array.from(this.wss?.clients || []).filter(
      client => !this.logClients.has(client)
    ).length;
    
    if (this.transport && 
        this.transport.getState() !== ConnectionState.DISCONNECTED && 
        activeBleClients === 0) {
      console.log('🧟 [BridgeServer] Found zombie BLE connection - cleaning up');
      this.transport.disconnect();
    }
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
}