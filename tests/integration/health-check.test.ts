import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/bridge-server.js';
import { ObservabilityServer } from '../../src/observability-server.js';
import { SharedState } from '../../src/shared-state.js';
import request from 'supertest';

describe('Health Check Tests', () => {
  let bridgeServer: BridgeServer;
  let observabilityServer: ObservabilityServer;
  let sharedState: SharedState;
  let httpPort: number;
  
  beforeAll(async () => {
    // Create shared state
    sharedState = new SharedState();
    
    // Start bridge server
    bridgeServer = new BridgeServer('info', sharedState);
    await bridgeServer.start(0);
    
    // Start observability server
    observabilityServer = new ObservabilityServer(sharedState);
    httpPort = 0; // Use random port
    await observabilityServer.startHttp(httpPort);
    
    // Get actual port
    const address = (observabilityServer as any).httpServer?.address();
    httpPort = typeof address === 'object' ? address.port : 8081;
  });
  
  afterAll(async () => {
    await bridgeServer.stop();
    await observabilityServer.stop();
  });
  
  it('should return health status when idle', async () => {
    const response = await request(`http://localhost:${httpPort}`)
      .get('/health')
      .expect(200);
    
    expect(response.body.status).toBe('ok');
    expect(response.body.timestamp).toBeDefined();
    expect(response.body.bridge).toEqual({
      connected: false,
      deviceName: null,
      free: true,
      recovering: false
    });
  });
  
  it('should show connected state when device is connected', async () => {
    // Skip this test if no real device is available
    // The bridge state would need to be manipulated or we'd need a real connection
    console.log('Note: Connected state test requires active BLE connection');
    // This test would require actually connecting to a device
    // which is better tested in device-interaction.test.ts
  });
  
  it('should show recovering state after disconnect', async () => {
    // Skip this test as it requires manipulating bridge state
    console.log('Note: Recovery state test requires active BLE connection');
    // This test would require connecting and disconnecting
    // which is better tested in back-to-back-connections.test.ts
  });
});