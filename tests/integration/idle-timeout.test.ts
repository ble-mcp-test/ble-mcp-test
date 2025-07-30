import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import WebSocket from 'ws';
import { BridgeServer } from '../../src/bridge-server.js';

describe('Idle Timeout and Eviction Tests', () => {
  let server: BridgeServer;
  let wsUrl: string;
  const SHORT_IDLE_TIMEOUT = '3000'; // 3 seconds for testing
  const EVICTION_GRACE_PERIOD = 5000; // 5 seconds grace period
  
  beforeAll(async () => {
    // Override idle timeout for testing
    process.env.BLE_MCP_CLIENT_IDLE_TIMEOUT = SHORT_IDLE_TIMEOUT;
    
    server = new BridgeServer('info');
    await server.start(0);
    const address = server['wss']?.address();
    const port = typeof address === 'object' ? address.port : 8080;
    wsUrl = `ws://localhost:${port}`;
  });
  
  afterAll(async () => {
    await server.stop();
    delete process.env.BLE_MCP_CLIENT_IDLE_TIMEOUT;
  });
  
  it('should disconnect idle client after timeout', async () => {
    const params = new URLSearchParams({
      device: 'TestDevice',
      service: '180f',
      write: '2a19',
      notify: '2a19'
    });
    
    const ws = new WebSocket(`${wsUrl}?${params}`);
    const messages: any[] = [];
    
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });
    
    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected' || msg.type === 'error') {
          clearTimeout(timeout);
          if (msg.type === 'error' && msg.error.includes('No device found')) {
            // Skip test if no device available
            ws.close();
            resolve();
          } else if (msg.type === 'connected') {
            resolve();
          }
        }
      });
    });
    
    // If no device was found, skip the rest of the test
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.type === 'error') {
      console.log('Skipping idle timeout test: No device available');
      return;
    }
    
    // Wait for idle timeout (3 seconds) plus a bit
    await new Promise(resolve => setTimeout(resolve, 3500));
    
    // Should receive eviction warning
    const evictionWarning = messages.find(m => m.type === 'eviction_warning');
    expect(evictionWarning).toBeDefined();
    expect(evictionWarning.grace_period_ms).toBe(EVICTION_GRACE_PERIOD);
    expect(evictionWarning.reason).toBe('idle_timeout');
    
    // Wait for grace period to expire
    await new Promise(resolve => setTimeout(resolve, EVICTION_GRACE_PERIOD + 500));
    
    // Connection should be closed
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    
    // Should have received disconnected message
    const disconnectedMsg = messages.find(m => m.type === 'disconnected');
    expect(disconnectedMsg).toBeDefined();
  });
  
  it('should reset idle timer on keepalive message', async () => {
    const params = new URLSearchParams({
      device: 'TestDevice',
      service: '180f',
      write: '2a19',
      notify: '2a19'
    });
    
    const ws = new WebSocket(`${wsUrl}?${params}`);
    const messages: any[] = [];
    
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });
    
    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected' || msg.type === 'error') {
          clearTimeout(timeout);
          if (msg.type === 'error' && msg.error.includes('No device found')) {
            ws.close();
            resolve();
          } else if (msg.type === 'connected') {
            resolve();
          }
        }
      });
    });
    
    // If no device was found, skip the rest of the test
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.type === 'error') {
      console.log('Skipping keepalive test: No device available');
      return;
    }
    
    // Send keepalive messages periodically
    const keepaliveInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'keepalive' }));
      }
    }, 2000); // Every 2 seconds (less than 3 second timeout)
    
    // Wait for longer than idle timeout
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Should NOT receive eviction warning
    const evictionWarning = messages.find(m => m.type === 'eviction_warning');
    expect(evictionWarning).toBeUndefined();
    
    // Connection should still be open
    expect(ws.readyState).toBe(WebSocket.OPEN);
    
    // Should have received keepalive acknowledgments
    const keepaliveAcks = messages.filter(m => m.type === 'keepalive_ack');
    expect(keepaliveAcks.length).toBeGreaterThan(0);
    expect(keepaliveAcks[0].timestamp).toBeDefined();
    
    // Cleanup
    clearInterval(keepaliveInterval);
    ws.close();
  });
  
  it('should reset idle timer on data message', async () => {
    const params = new URLSearchParams({
      device: 'TestDevice',
      service: '180f',
      write: '2a19',
      notify: '2a19'
    });
    
    const ws = new WebSocket(`${wsUrl}?${params}`);
    const messages: any[] = [];
    
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });
    
    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected' || msg.type === 'error') {
          clearTimeout(timeout);
          if (msg.type === 'error' && msg.error.includes('No device found')) {
            ws.close();
            resolve();
          } else if (msg.type === 'connected') {
            resolve();
          }
        }
      });
    });
    
    // If no device was found, skip the rest of the test
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.type === 'error') {
      console.log('Skipping data activity test: No device available');
      return;
    }
    
    // Send data messages periodically
    const dataInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ 
          type: 'data', 
          data: [0x01, 0x02, 0x03] 
        }));
      }
    }, 2000); // Every 2 seconds
    
    // Wait for longer than idle timeout
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Should NOT receive eviction warning
    const evictionWarning = messages.find(m => m.type === 'eviction_warning');
    expect(evictionWarning).toBeUndefined();
    
    // Connection should still be open
    expect(ws.readyState).toBe(WebSocket.OPEN);
    
    // Cleanup
    clearInterval(dataInterval);
    ws.close();
  });
  
  it('should cancel eviction if activity resumes during grace period', async () => {
    const params = new URLSearchParams({
      device: 'TestDevice',
      service: '180f',
      write: '2a19',
      notify: '2a19'
    });
    
    const ws = new WebSocket(`${wsUrl}?${params}`);
    const messages: any[] = [];
    
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });
    
    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected' || msg.type === 'error') {
          clearTimeout(timeout);
          if (msg.type === 'error' && msg.error.includes('No device found')) {
            ws.close();
            resolve();
          } else if (msg.type === 'connected') {
            resolve();
          }
        }
      });
    });
    
    // If no device was found, skip the rest of the test
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.type === 'error') {
      console.log('Skipping grace period test: No device available');
      return;
    }
    
    // Wait for idle timeout to trigger eviction warning
    await new Promise(resolve => setTimeout(resolve, 3500));
    
    // Should receive eviction warning
    const evictionWarning = messages.find(m => m.type === 'eviction_warning');
    expect(evictionWarning).toBeDefined();
    
    // Send keepalive during grace period
    ws.send(JSON.stringify({ type: 'keepalive' }));
    
    // Wait for what would have been the end of grace period
    await new Promise(resolve => setTimeout(resolve, EVICTION_GRACE_PERIOD + 1000));
    
    // Connection should still be open (eviction cancelled)
    expect(ws.readyState).toBe(WebSocket.OPEN);
    
    // Should NOT have received disconnected message
    const disconnectedMsg = messages.find(m => m.type === 'disconnected');
    expect(disconnectedMsg).toBeUndefined();
    
    // Cleanup
    ws.close();
  });
});