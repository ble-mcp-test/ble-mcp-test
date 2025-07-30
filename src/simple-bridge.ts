#!/usr/bin/env node
/**
 * NUCLEAR SIMPLE WebSocket-to-BLE Bridge
 * 
 * One connection, one device, pure plumbing.
 * No tokens, no timers, no state machines, no managers.
 * 
 * Target: <100 lines total
 */

import { WebSocketServer } from 'ws';
import { NobleTransport } from './noble-transport.js';

export class SimpleBridge {
  private wss: WebSocketServer | null = null;
  private activeConnection: any = null; // WebSocket | null
  private transport: NobleTransport | null = null;
  
  async start(port = 8080) {
    this.wss = new WebSocketServer({ port });
    console.log(`🚀 Simple bridge listening on port ${port}`);
    
    this.wss.on('connection', async (ws, req) => {
      // One connection rule: if busy, reject immediately
      if (this.activeConnection) {
        ws.send(JSON.stringify({ type: 'error', error: 'Busy' }));
        ws.close();
        return;
      }
      
      // Parse BLE config from URL
      const url = new URL(req.url || '', 'http://localhost');
      const config = {
        devicePrefix: url.searchParams.get('device') || '',
        serviceUuid: url.searchParams.get('service') || '',
        writeUuid: url.searchParams.get('write') || '',
        notifyUuid: url.searchParams.get('notify') || ''
      };
      
      if (!config.devicePrefix || !config.serviceUuid || !config.writeUuid || !config.notifyUuid) {
        ws.send(JSON.stringify({ type: 'error', error: 'Missing params' }));
        ws.close();
        return;
      }
      
      // Claim connection
      this.activeConnection = ws;
      
      try {
        // Create transport and connect
        this.transport = new NobleTransport();
        
        await this.transport.connect(config, {
          onData: (data) => {
            ws.send(JSON.stringify({ type: 'data', data: Array.from(data) }));
          },
          onDisconnected: () => {
            ws.send(JSON.stringify({ type: 'disconnected' }));
            this.cleanup();
          }
        });
        
        // Connected!
        ws.send(JSON.stringify({ type: 'connected', device: this.transport.getDeviceName() }));
        
        // Handle messages
        ws.on('message', async (message) => {
          const msg = JSON.parse(message.toString());
          
          if (msg.type === 'data' && this.transport) {
            await this.transport.sendData(new Uint8Array(msg.data));
          }
        });
        
        // Handle disconnect
        ws.on('close', () => {
          this.cleanup();
        });
        
      } catch (error: any) {
        ws.send(JSON.stringify({ type: 'error', error: error.message }));
        this.cleanup();
      }
    });
  }
  
  private cleanup() {
    if (this.transport) {
      this.transport.disconnect().catch(() => {}); // Fire and forget
    }
    this.transport = null;
    this.activeConnection = null;
  }
  
  async stop() {
    this.cleanup();
    if (this.wss) {
      this.wss.close();
    }
  }
}

// If running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const bridge = new SimpleBridge();
  bridge.start(8080);
  
  process.on('SIGINT', () => {
    console.log('\\nShutting down...');
    bridge.stop();
    process.exit(0);
  });
}