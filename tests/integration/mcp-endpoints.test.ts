import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Express } from 'express';
import { BridgeServer } from '../../src/bridge-server.js';
import { createHttpApp } from '../../src/mcp-http-transport.js';
import { getPackageMetadata } from '../../src/utils.js';

describe('MCP Dynamic Registration Endpoints', () => {
  let server: BridgeServer;
  let app: Express;
  const testToken = 'test-token-123';
  
  beforeAll(async () => {
    server = new BridgeServer('info');
    await server.start(0);
    app = createHttpApp(server.getMcpServer(), testToken);
  });
  
  afterAll(async () => {
    await server.stop();
  });
  
  describe('GET /mcp/info', () => {
    it('should return server metadata and tool list without auth', async () => {
      const response = await request(app)
        .get('/mcp/info')
        .expect(200)
        .expect('Content-Type', /application\/json/);
      
      const metadata = getPackageMetadata();
      expect(response.body).toEqual({
        name: metadata.name,
        version: metadata.version,
        description: metadata.description,
        tools: expect.arrayContaining([
          { name: 'get_logs', description: 'Retrieve recent BLE communication logs with filtering options' },
          { name: 'search_packets', description: 'Search for hex patterns in BLE packets' },
          { name: 'get_connection_state', description: 'Get detailed BLE connection state and activity' },
          { name: 'status', description: 'Get bridge server status and configuration' },
          { name: 'scan_devices', description: 'Scan for nearby BLE devices (only when not connected)' }
        ])
      });
    });
    
    it('should return proper cache headers', async () => {
      const response = await request(app)
        .get('/mcp/info')
        .expect(200);
      
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
    });
  });
  
  describe('POST /mcp/register', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .post('/mcp/register')
        .expect(401);
      
      expect(response.body).toEqual({ error: 'Unauthorized' });
    });
    
    it('should return capabilities with valid auth', async () => {
      const response = await request(app)
        .post('/mcp/register')
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200)
        .expect('Content-Type', /application\/json/);
      
      const metadata = getPackageMetadata();
      expect(response.body).toEqual({
        name: metadata.name,
        version: metadata.version,
        capabilities: {
          tools: true,
          resources: false,
          prompts: false
        }
      });
    });
    
    it('should return no-cache headers', async () => {
      const response = await request(app)
        .post('/mcp/register')
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);
      
      expect(response.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    });
  });
  
  describe('Error handling', () => {
    it('should handle server initialization errors gracefully', async () => {
      // Create app without initialized server
      const emptyApp = createHttpApp(null as any);
      
      const infoResponse = await request(emptyApp)
        .get('/mcp/info')
        .expect(500);
      
      expect(infoResponse.body.error).toBe('Internal server error');
      expect(infoResponse.body.message).toContain('not initialized');
      
      const registerResponse = await request(emptyApp)
        .post('/mcp/register')
        .set('Authorization', `Bearer ${testToken}`)
        .expect(500);
      
      expect(registerResponse.body.error).toBe('Internal server error');
      expect(registerResponse.body.message).toContain('not initialized');
    });
  });
  
  describe('Dynamic version verification', () => {
    it('should use dynamic version from package.json', async () => {
      const response = await request(app)
        .get('/mcp/info')
        .expect(200);
      
      // Should be 0.4.0 after update
      expect(response.body.version).toBe('0.4.0');
    });
  });
});