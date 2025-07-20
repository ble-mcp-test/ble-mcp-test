import { WebSocketServer } from 'ws';
import { NobleTransport } from './noble-transport.js';

export class BridgeServer {
  private wss: WebSocketServer | null = null;

  start(port = 8080) {
    this.wss = new WebSocketServer({ port });
    
    this.wss.on('connection', async (ws, req) => {
      const url = new URL(req.url!, `http://localhost`);
      const devicePrefix = url.searchParams.get('device') || 'CS108';
      
      const transport = new NobleTransport();
      
      try {
        // Connect to BLE device
        await transport.connect(devicePrefix, {
          onData: (data) => {
            ws.send(JSON.stringify({ type: 'data', data: Array.from(data) }));
          },
          onDisconnected: () => {
            ws.send(JSON.stringify({ type: 'disconnected' }));
            ws.close();
          }
        });
        
        // Send connected message
        ws.send(JSON.stringify({ 
          type: 'connected', 
          device: transport.getDeviceName() 
        }));
        
        // Handle incoming messages
        ws.on('message', async (message) => {
          try {
            const msg = JSON.parse(message.toString());
            if (msg.type === 'data' && msg.data) {
              await transport.sendData(new Uint8Array(msg.data));
            }
          } catch (error) {
            // Ignore malformed messages
          }
        });
        
        // Clean disconnect on WebSocket close
        ws.on('close', () => {
          transport.disconnect();
        });
        
      } catch (error: any) {
        ws.send(JSON.stringify({ 
          type: 'error', 
          error: error?.message || error?.toString() || 'Unknown error' 
        }));
        ws.close();
      }
    });
  }
  
  stop() {
    this.wss?.close();
  }
}