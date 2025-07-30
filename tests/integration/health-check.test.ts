import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { BridgeServer } from '../../src/bridge-server.js';
import { ServerState } from '../../src/state-machine.js';

describe('Health Check Tests', () => {
  let server: BridgeServer;
  let wsUrl: string;
  
  beforeAll(async () => {
    server = new BridgeServer('info');
    await server.start(0);
    const address = server['wss']?.address();
    const port = typeof address === 'object' ? address.port : 8080;
    wsUrl = `ws://localhost:${port}`;
  });
  
  afterAll(async () => {
    await server.stop();
  });
  
  it('should include state machine state in health response', async () => {
    const ws = new WebSocket(`${wsUrl}?command=health`);
    
    const response = await new Promise<any>((resolve, reject) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        resolve(msg);
      });
      
      ws.on('error', reject);
      
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });
    
    expect(response.type).toBe('health');
    expect(response.status).toBe('ok');
    expect(response.free).toBe(true);
    expect(response.state).toBe(ServerState.IDLE);
    expect(response.transportState).toBeDefined();
    expect(response.connectionInfo).toBe(null);
    expect(response.timestamp).toBeDefined();
  });
  
  it('should show ACTIVE state when connected', async () => {
    // First establish a connection
    const params = new URLSearchParams({
      device: '6c79b82603a7',
      service: '9800',
      write: '9900',
      notify: '9901'
    });
    
    const deviceWs = new WebSocket(`${wsUrl}?${params}`);
    
    // Wait for connection or error
    const connectionResult = await new Promise<any>((resolve) => {
      deviceWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected' || msg.type === 'error') {
          resolve(msg);
        }
      });
    });
    
    if (connectionResult.type === 'connected') {
      // Now check health
      const healthWs = new WebSocket(`${wsUrl}?command=health`);
      
      const healthResponse = await new Promise<any>((resolve, reject) => {
        healthWs.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          resolve(msg);
        });
        
        healthWs.on('error', reject);
        
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });
      
      expect(healthResponse.type).toBe('health');
      expect(healthResponse.free).toBe(false);
      expect(healthResponse.state).toBe(ServerState.ACTIVE);
      expect(healthResponse.connectionInfo).toBeDefined();
      expect(healthResponse.connectionInfo.token).toBeDefined();
      expect(healthResponse.connectionInfo.connected).toBe(true);
      expect(healthResponse.connectionInfo.deviceName).toBeDefined();
      
      // Clean up
      deviceWs.close();
    } else {
      // Skip test if no device available
      console.log('Skipping ACTIVE state test: No device available');
    }
  });
});