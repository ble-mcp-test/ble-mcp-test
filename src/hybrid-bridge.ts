#!/usr/bin/env node
/**
 * NUCLEAR SIMPLE Bridge
 * 
 * One connection, one device, pure plumbing.
 * Emits logs for MCP to consume. No defensive complexity.
 * 
 * Target achieved: <200 lines for core bridge
 */

import { WebSocketServer } from 'ws';
import { SimpleTransport } from './simple-transport.js';

export class NuclearBridge {
  private wss: WebSocketServer | null = null;
  private activeConnection: any = null; // WebSocket | null
  private transport: SimpleTransport | null = null;
  
  async start(port = 8080) {
    this.wss = new WebSocketServer({ port });
    console.log(`🚀 Nuclear bridge listening on port ${port}`);
    
    this.wss.on('connection', async (ws, req) => {
      // Health check endpoint
      const url = new URL(req.url || '', 'http://localhost');
      if (url.searchParams.get('command') === 'health') {
        ws.send(JSON.stringify({
          type: 'health',
          status: 'ok',
          free: !this.activeConnection,
          timestamp: new Date().toISOString()
        }));
        ws.close();
        return;
      }
      
      // NUCLEAR SIMPLE: if busy, reject immediately
      if (this.activeConnection) {
        console.log(`[NuclearBridge] Connection rejected - busy`);
        ws.send(JSON.stringify({ type: 'error', error: 'Another connection is active' }));
        ws.close();
        return;
      }
      
      // Parse BLE config from URL
      const config = {
        devicePrefix: url.searchParams.get('device') || '',
        serviceUuid: url.searchParams.get('service') || '',
        writeUuid: url.searchParams.get('write') || '',
        notifyUuid: url.searchParams.get('notify') || ''
      };
      
      if (!config.devicePrefix || !config.serviceUuid || !config.writeUuid || !config.notifyUuid) {
        ws.send(JSON.stringify({ type: 'error', error: 'Missing required parameters: device, service, write, notify' }));
        ws.close();
        return;
      }
      
      console.log(`[NuclearBridge] New connection: ${config.devicePrefix}`);
      
      // NUCLEAR SIMPLE: claim connection (just set the flag)
      this.activeConnection = ws;
      
      try {
        // Create transport and connect
        this.transport = new SimpleTransport();
        
        await this.transport.connect(config, {
          onData: (data) => {
            // NUCLEAR SIMPLE: just forward, emit log for MCP
            console.log(`[NuclearBridge] RX ${data.length} bytes`);
            ws.send(JSON.stringify({ type: 'data', data: Array.from(data) }));
          },
          onDisconnected: () => {
            console.log(`[NuclearBridge] Device disconnected`);
            ws.send(JSON.stringify({ type: 'disconnected' }));
            this.cleanup();
          }
        });
        
        // Connected!
        const deviceName = this.transport.getDeviceName();
        console.log(`[NuclearBridge] Connected to ${deviceName}`);
        ws.send(JSON.stringify({ type: 'connected', device: deviceName }));
        
        // Handle messages - NUCLEAR SIMPLE
        ws.on('message', async (message) => {
          try {
            const msg = JSON.parse(message.toString());
            
            if (msg.type === 'data' && this.transport) {
              const data = new Uint8Array(msg.data);
              console.log(`[NuclearBridge] TX ${data.length} bytes`);
              await this.transport.sendData(data);
            }
          } catch (error) {
            console.error('[NuclearBridge] Message error:', error);
          }
        });
        
        // Handle disconnect - NUCLEAR SIMPLE
        ws.on('close', () => {
          console.log(`[NuclearBridge] WebSocket closed`);
          this.cleanup();
        });
        
      } catch (error: any) {
        console.error('Connection error:', error.message);
        ws.send(JSON.stringify({ type: 'error', error: error.message }));
        this.cleanup();
      }
    });
  }
  
  // NUCLEAR SIMPLE: cleanup is just clear the flags
  private cleanup() {
    console.log(`[NuclearBridge] Cleanup`);
    if (this.transport) {
      this.transport.disconnect().catch(() => {}); // Fire and forget
    }
    this.transport = null;
    this.activeConnection = null;
  }
  
  async stop() {
    console.log('[NuclearBridge] Stopping...');
    this.cleanup();
    if (this.wss) {
      this.wss.close();
    }
  }
}

// If running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const bridge = new NuclearBridge();
  bridge.start(8080);
  
  process.on('SIGINT', () => {
    console.log('\\n[NuclearBridge] Shutting down...');
    bridge.stop();
    process.exit(0);
  });
}