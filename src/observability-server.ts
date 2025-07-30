import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerMcpTools } from './mcp-tools.js';
import { createHttpApp, startHttpServer } from './mcp-http-transport.js';
import { SharedState } from './shared-state.js';
import { getPackageMetadata } from './utils.js';
import type { BridgeServer } from './bridge-server.js';

/**
 * Observability Server - Separate service for health checks and MCP tools
 * 
 * This server provides:
 * - HTTP health check endpoint
 * - MCP debugging tools via HTTP/stdio
 * - Future: metrics, monitoring, etc.
 * 
 * It observes the bridge server but doesn't interfere with it
 */
export class ObservabilityServer {
  private mcpServer: McpServer;
  private sharedState: SharedState;
  private bridgeServer: BridgeServer | null = null;
  
  constructor(sharedState: SharedState) {
    // Use shared state for log buffer
    this.sharedState = sharedState;
    
    // Initialize MCP server
    const metadata = getPackageMetadata();
    this.mcpServer = new McpServer({
      name: metadata.name,
      version: metadata.version
    });
    
    // Register MCP tools with bridge state access
    registerMcpTools(this.mcpServer, this);
  }
  
  /**
   * Connect to bridge server for observability
   */
  connectToBridge(bridgeServer: BridgeServer) {
    this.bridgeServer = bridgeServer;
  }
  
  /**
   * Start HTTP server for health checks and MCP
   */
  async startHttp(port: number = 8081): Promise<void> {
    const app = express();
    
    // Health check endpoint
    app.get('/health', (req, res) => {
      const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        bridge: this.getBridgeHealth()
      };
      res.json(health);
    });
    
    // Add MCP HTTP endpoints
    const mcpApp = createHttpApp(this.mcpServer, process.env.BLE_MCP_HTTP_TOKEN);
    app.use('/mcp', mcpApp);
    
    return new Promise((resolve) => {
      app.listen(port, () => {
        console.log(`📊 Observability server listening on port ${port}`);
        console.log(`   Health check: http://localhost:${port}/health`);
        console.log(`   MCP info: http://localhost:${port}/mcp/info`);
        resolve();
      });
    });
  }
  
  /**
   * Connect MCP stdio transport if available
   */
  async connectStdio(): Promise<void> {
    const hasTty = process.stdin.isTTY && process.stdout.isTTY;
    const stdioDisabled = process.env.BLE_MCP_STDIO_DISABLED === 'true';
    
    if (hasTty && !stdioDisabled) {
      const stdioTransport = new StdioServerTransport();
      await this.mcpServer.connect(stdioTransport);
      console.log('[MCP] Stdio transport connected');
    }
  }
  
  /**
   * Get bridge health status
   */
  private getBridgeHealth() {
    const state = this.sharedState.getConnectionState();
    
    return {
      connected: state.connected,
      deviceName: state.deviceName,
      free: !state.connected && !state.recovering,
      recovering: state.recovering
    };
  }
  
  // MCP tool interface methods
  getConnectionState() {
    return this.getBridgeHealth();
  }
  
  async scanDevices(): Promise<any[]> {
    // Could proxy to bridge if it exposed scanning
    throw new Error('Device scanning not available in ultra-simple mode');
  }
  
  getLogBuffer() {
    return this.sharedState.getLogBuffer();
  }
  
  getMcpServer() {
    return this.mcpServer;
  }
}