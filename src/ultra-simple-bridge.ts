#!/usr/bin/env node
/**
 * ULTRA SIMPLE WebSocket-to-BLE Bridge
 * 
 * Everything in one file. No abstractions. No separation.
 * Just WebSocket + Noble + device. Pure plumbing.
 * 
 * Target: <200 lines total
 */

import { WebSocketServer } from 'ws';
import noble from '@stoprocent/noble';

export class UltraSimpleBridge {
  private wss: WebSocketServer | null = null;
  private activeConnection: any = null; // WebSocket | null
  private peripheral: any = null;
  private writeChar: any = null;
  private notifyChar: any = null;
  
  async start(port = 8080) {
    this.wss = new WebSocketServer({ port });
    console.log(`🚀 Ultra simple bridge listening on port ${port}`);
    
    this.wss.on('connection', async (ws, req) => {
      // Health check
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
      
      // One connection rule
      if (this.activeConnection) {
        console.log(`[Bridge] Connection rejected - busy`);
        ws.send(JSON.stringify({ type: 'error', error: 'Another connection is active' }));
        ws.close();
        return;
      }
      
      // Parse BLE config
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
      
      console.log(`[Bridge] New connection: ${config.devicePrefix}`);
      this.activeConnection = ws;
      
      try {
        // Connect to BLE device directly
        await this.connectToBLE(config);
        
        // Connected!
        const deviceName = this.peripheral?.advertisement?.localName || this.peripheral?.id || 'Unknown';
        console.log(`[Bridge] Connected to ${deviceName}`);
        ws.send(JSON.stringify({ type: 'connected', device: deviceName }));
        
        // Handle WebSocket messages
        ws.on('message', async (message) => {
          try {
            const msg = JSON.parse(message.toString());
            if (msg.type === 'data' && this.writeChar) {
              const data = new Uint8Array(msg.data);
              console.log(`[Bridge] TX ${data.length} bytes`);
              await this.writeChar.writeAsync(Buffer.from(data), false);
            }
          } catch (error) {
            console.error('[Bridge] Message error:', error);
          }
        });
        
        // Handle WebSocket close
        ws.on('close', () => {
          console.log(`[Bridge] WebSocket closed`);
          this.cleanup();
        });
        
      } catch (error: any) {
        console.error('[Bridge] Connection error:', error.message);
        ws.send(JSON.stringify({ type: 'error', error: error.message }));
        this.cleanup();
      }
    });
  }
  
  private async connectToBLE(config: any) {
    console.log(`[Bridge] Connecting to BLE device ${config.devicePrefix}`);
    
    // Wait for Noble to be ready
    if (noble.state !== 'poweredOn') {
      await noble.waitForPoweredOnAsync();
    }
    
    // Scan for device
    await noble.startScanningAsync([], false);
    
    this.peripheral = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        noble.stopScanningAsync();
        reject(new Error(`Device ${config.devicePrefix} not found`));
      }, 15000);
      
      const onDiscover = (device: any) => {
        const name = device.advertisement.localName || '';
        const id = device.id;
        
        if (name.startsWith(config.devicePrefix) || id === config.devicePrefix) {
          clearTimeout(timeout);
          noble.removeListener('discover', onDiscover);
          noble.stopScanningAsync();
          resolve(device);
        }
      };
      
      noble.on('discover', onDiscover);
    });
    
    // Connect to peripheral
    await this.peripheral.connectAsync();
    
    // Find service and characteristics
    const services = await this.peripheral.discoverServicesAsync();
    const targetService = services.find((s: any) => 
      s.uuid === config.serviceUuid || 
      s.uuid === config.serviceUuid.toLowerCase().replace(/-/g, '')
    );
    
    if (!targetService) {
      throw new Error(`Service ${config.serviceUuid} not found`);
    }
    
    const characteristics = await targetService.discoverCharacteristicsAsync();
    
    this.writeChar = characteristics.find((c: any) => 
      c.uuid === config.writeUuid || 
      c.uuid === config.writeUuid.toLowerCase().replace(/-/g, '')
    );
    
    this.notifyChar = characteristics.find((c: any) => 
      c.uuid === config.notifyUuid || 
      c.uuid === config.notifyUuid.toLowerCase().replace(/-/g, '')
    );
    
    if (!this.writeChar || !this.notifyChar) {
      throw new Error('Required characteristics not found');
    }
    
    // Subscribe to notifications
    this.notifyChar.on('data', (data: Buffer) => {
      const bytes = new Uint8Array(data);
      console.log(`[Bridge] RX ${bytes.length} bytes`);
      if (this.activeConnection) {
        this.activeConnection.send(JSON.stringify({ type: 'data', data: Array.from(bytes) }));
      }
    });
    
    await this.notifyChar.subscribeAsync();
    
    // Handle unexpected disconnect
    this.peripheral.once('disconnect', () => {
      console.log(`[Bridge] Device disconnected`);
      if (this.activeConnection) {
        this.activeConnection.send(JSON.stringify({ type: 'disconnected' }));
      }
      this.cleanup();
    });
  }
  
  private cleanup() {
    console.log(`[Bridge] Cleanup`);
    
    // Clean up BLE
    if (this.peripheral) {
      try {
        if (this.notifyChar) {
          this.notifyChar.unsubscribeAsync().catch(() => {});
        }
        this.peripheral.disconnectAsync().catch(() => {});
      } catch {}
    }
    
    this.peripheral = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.activeConnection = null;
  }
  
  async stop() {
    console.log('[Bridge] Stopping...');
    this.cleanup();
    if (this.wss) {
      this.wss.close();
    }
  }
}

// If running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const bridge = new UltraSimpleBridge();
  bridge.start(8080);
  
  process.on('SIGINT', () => {
    console.log('\\n[Bridge] Shutting down...');
    bridge.stop();
    process.exit(0);
  });
}