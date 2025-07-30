import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { BridgeServer } from '../../src/bridge-server.js';

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
  
  it('should return health status when idle', async () => {
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
    expect(response.recovering).toBe(false);
    expect(response.timestamp).toBeDefined();
    
    ws.close();
  });
  
  it('should show connected state when device is connected', async () => {
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
      expect(healthResponse.status).toBe('ok');
      expect(healthResponse.free).toBe(false);
      expect(healthResponse.recovering).toBe(false);
      expect(healthResponse.timestamp).toBeDefined();
      
      healthWs.close();
      
      // Clean up
      deviceWs.close();
    } else {
      // Skip test if no device available
      console.log('Skipping connected state test: No device available');
    }
  });
  
  it('should show recovering state after disconnect', async () => {
    // This test validates the recovery period behavior
    const params = new URLSearchParams({
      device: '6c79b82603a7',
      service: '9800',
      write: '9900',
      notify: '9901'
    });
    
    const deviceWs = new WebSocket(`${wsUrl}?${params}`);
    
    // Wait for connection
    const connectionResult = await new Promise<any>((resolve) => {
      deviceWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected' || msg.type === 'error') {
          resolve(msg);
        }
      });
    });
    
    if (connectionResult.type === 'connected') {
      // Close connection to trigger recovery
      deviceWs.close();
      
      // Wait a moment for disconnect to process
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Check health during recovery period
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
      expect(healthResponse.status).toBe('ok');
      expect(healthResponse.free).toBe(false); // Not free during recovery
      expect(healthResponse.recovering).toBe(true);
      expect(healthResponse.timestamp).toBeDefined();
      
      healthWs.close();
      
      // Wait for recovery to complete
      await new Promise(resolve => setTimeout(resolve, 5500));
      
      // Check health after recovery
      const healthWs2 = new WebSocket(`${wsUrl}?command=health`);
      
      const healthResponse2 = await new Promise<any>((resolve, reject) => {
        healthWs2.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          resolve(msg);
        });
        
        healthWs2.on('error', reject);
        
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });
      
      expect(healthResponse2.type).toBe('health');
      expect(healthResponse2.status).toBe('ok');
      expect(healthResponse2.free).toBe(true); // Free after recovery
      expect(healthResponse2.recovering).toBe(false);
      expect(healthResponse2.timestamp).toBeDefined();
      
      healthWs2.close();
    } else {
      console.log('Skipping recovery state test: No device available');
    }
  });
});