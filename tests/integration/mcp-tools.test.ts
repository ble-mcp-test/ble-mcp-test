import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/bridge-server.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

describe('MCP Tools Integration Tests', () => {
  let server: BridgeServer;
  let mcpServer: McpServer;
  
  beforeAll(async () => {
    server = new BridgeServer('info');
    mcpServer = server.getMcpServer();
    
    // Start the WebSocket server (but not MCP transports)
    await server.start(0); // Use port 0 for random port
  });
  
  afterAll(async () => {
    await server.stop();
  });
  
  it('should have all 5 tools registered', () => {
    // Access the internal tools registry
    const tools = (mcpServer as any)._registeredTools;
    expect(tools).toBeDefined();
    expect(Object.keys(tools).length).toBe(5);
    
    const toolNames = Object.keys(tools);
    expect(toolNames).toContain('get_logs');
    expect(toolNames).toContain('search_packets');
    expect(toolNames).toContain('get_connection_state');
    expect(toolNames).toContain('status');
    expect(toolNames).toContain('scan_devices');
  });
  
  it('should execute get_logs tool', async () => {
    // Get the log buffer and clear it before test
    const logBuffer = server.getLogBuffer();
    (logBuffer as any).buffer = []; // Clear existing logs
    (logBuffer as any).sequenceCounter = 0; // Reset sequence counter
    
    // Add some test data to the log buffer
    logBuffer.push('TX', new Uint8Array([0x01, 0x02, 0x03]));
    logBuffer.push('RX', new Uint8Array([0x04, 0x05, 0x06]));
    
    // Get the tool
    const tools = (mcpServer as any)._registeredTools;
    const getLogsTool = tools['get_logs'];
    
    // Execute the tool
    const result = await getLogsTool.callback(
      { since: '0', limit: 10 },
      { request: {}, server: mcpServer }
    );
    
    expect(result).toBeDefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    
    const logs = JSON.parse(result.content[0].text);
    // Filter out INFO logs (system logs)
    const dataLogs = logs.logs.filter((log: any) => log.direction === 'TX' || log.direction === 'RX');
    expect(dataLogs).toHaveLength(2);
    expect(dataLogs[0].direction).toBe('TX');
    expect(dataLogs[0].hex).toBe('01 02 03');
    expect(dataLogs[1].direction).toBe('RX');
    expect(dataLogs[1].hex).toBe('04 05 06');
  });
  
  it('should execute search_packets tool', async () => {
    // Get the log buffer and clear it before test
    const logBuffer = server.getLogBuffer();
    (logBuffer as any).buffer = []; // Clear existing logs
    (logBuffer as any).sequenceCounter = 0; // Reset sequence counter
    
    // Add test data
    logBuffer.push('TX', new Uint8Array([0xA7, 0xB3, 0x01]));
    logBuffer.push('RX', new Uint8Array([0x02, 0x03, 0x04]));
    logBuffer.push('TX', new Uint8Array([0xA7, 0xB3, 0x02]));
    
    const tools = (mcpServer as any)._registeredTools;
    const searchTool = tools['search_packets'];
    
    const result = await searchTool.callback(
      { hex_pattern: 'A7B3', limit: 10 },
      { request: {}, server: mcpServer }
    );
    
    const searchResult = JSON.parse(result.content[0].text);
    // Filter out INFO logs from matches
    const dataMatches = searchResult.matches.filter((match: any) => match.direction === 'TX' || match.direction === 'RX');
    expect(dataMatches).toHaveLength(2);
    expect(searchResult.pattern).toBe('A7B3');
    expect(dataMatches.length).toBe(2);
  });
  
  it('should execute get_connection_state tool', async () => {
    const tools = (mcpServer as any)._registeredTools;
    const stateTool = tools['get_connection_state'];
    
    const result = await stateTool.callback(
      {},
      { request: {}, server: mcpServer }
    );
    
    const state = JSON.parse(result.content[0].text);
    expect(state.connected).toBe(false);
    expect(state.packetsTransmitted).toBeDefined();
    expect(state.packetsReceived).toBeDefined();
  });
  
  it('should execute status tool', async () => {
    const tools = (mcpServer as any)._registeredTools;
    const statusTool = tools['status'];
    
    const result = await statusTool.callback(
      {},
      { request: {}, server: mcpServer }
    );
    
    const status = JSON.parse(result.content[0].text);
    expect(status.version).toBe('0.4.0');
    expect(status.uptime).toBeGreaterThan(0);
    expect(status.wsPort).toBeDefined();
    expect(status.mcpTransports).toBeDefined();
    // Test environment behavior varies, so just check structure
    expect(status.logBufferSize).toBe(10000);
    expect(status.logLevel).toBe('debug');
  });
  
  it('should handle scan_devices when not connected', async () => {
    const tools = (mcpServer as any)._registeredTools;
    const scanTool = tools['scan_devices'];
    
    try {
      // This will likely fail in test environment without BLE
      const result = await scanTool.callback(
        { duration: 1000 },
        { request: {}, server: mcpServer }
      );
      
      const scanResult = JSON.parse(result.content[0].text);
      expect(scanResult.devices).toBeDefined();
      expect(Array.isArray(scanResult.devices)).toBe(true);
    } catch (error: any) {
      // Expected in test environment
      expect(error.message).toMatch(/Bluetooth|Noble/);
    }
  });
});