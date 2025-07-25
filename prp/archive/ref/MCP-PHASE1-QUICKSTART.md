# MCP Phase 1 Quick Implementation Guide

## Goal: Get debugging tools working ASAP for trakrf-handheld

## Step 1: Add MCP SDK dependency

```bash
pnpm add @modelcontextprotocol/sdk
```

## Step 2: Create minimal MCP server (src/mcp-server.ts)

```typescript
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BridgeServer } from './bridge-server.js';
import { NobleTransport } from './noble-transport.js';

// Simple circular buffer for logs
class LogBuffer {
  private buffer: any[] = [];
  private maxSize = 10000;
  
  push(entry: any) {
    this.buffer.push({
      timestamp: new Date().toISOString(),
      ...entry
    });
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }
  
  getSince(since: string): any[] {
    if (since === 'last') return this.buffer;
    
    // Parse duration like '30s'
    const match = since.match(/^(\d+)([smh])$/);
    if (match) {
      const [, num, unit] = match;
      const ms = parseInt(num) * (unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000);
      const cutoff = Date.now() - ms;
      return this.buffer.filter(e => new Date(e.timestamp).getTime() > cutoff);
    }
    
    return this.buffer;
  }
}

async function main() {
  const logBuffer = new LogBuffer();
  let bridgeServer: BridgeServer | null = null;
  
  // Start bridge server
  try {
    bridgeServer = new BridgeServer(process.env.LOG_LEVEL || 'info');
    
    // Intercept console.log to capture logs
    const originalLog = console.log;
    console.log = (...args) => {
      originalLog(...args);
      const message = args.join(' ');
      
      // Parse log level and message
      let level = 'info';
      if (message.includes('[ERROR]')) level = 'error';
      else if (message.includes('[DEBUG]')) level = 'debug';
      
      // Capture TX/RX logs
      if (message.includes('[TX]') || message.includes('[RX]')) {
        const match = message.match(/\[(TX|RX)\]\s+([0-9A-Fa-f]+)/);
        if (match) {
          logBuffer.push({
            level,
            type: match[1],
            data: match[2],
            message
          });
        }
      } else {
        logBuffer.push({ level, message });
      }
    };
    
    await bridgeServer.start(parseInt(process.env.BRIDGE_PORT || '8080'));
  } catch (error) {
    console.error('Failed to start bridge server:', error);
  }
  
  // Create MCP server
  const server = new Server({
    name: 'web-ble-bridge',
    version: '0.3.0'
  });
  
  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_logs',
        description: 'Get BLE communication logs',
        inputSchema: {
          type: 'object',
          properties: {
            since: {
              type: 'string',
              description: 'ISO timestamp, "last", or duration like "30s"',
              default: 'last'
            },
            filter: {
              type: 'string',
              description: 'Filter pattern'
            }
          }
        }
      },
      {
        name: 'status',
        description: 'Get bridge server status',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'scan_devices',
        description: 'Scan for BLE devices',
        inputSchema: {
          type: 'object',
          properties: {
            duration: {
              type: 'number',
              description: 'Scan duration in ms',
              default: 5000
            }
          }
        }
      }
    ]
  }));
  
  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    switch (name) {
      case 'get_logs': {
        const logs = logBuffer.getSince(args?.since || 'last');
        const filtered = args?.filter 
          ? logs.filter(l => l.message.includes(args.filter))
          : logs;
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              logs: filtered,
              count: filtered.length
            }, null, 2)
          }]
        };
      }
      
      case 'status': {
        const status = {
          running: !!bridgeServer,
          port: process.env.BRIDGE_PORT || '8080',
          connections: bridgeServer?.getActiveConnections() || 0,
          uptime: process.uptime()
        };
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(status, null, 2)
          }]
        };
      }
      
      case 'scan_devices': {
        if (!bridgeServer) {
          throw new Error('Bridge server not running');
        }
        
        // Quick scan using Noble
        const transport = new NobleTransport();
        const devices = await transport.performQuickScan(args?.duration || 5000);
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              devices,
              count: devices.length
            }, null, 2)
          }]
        };
      }
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });
  
  // Start MCP server on stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Handle shutdown
  process.on('SIGINT', async () => {
    if (bridgeServer) {
      await bridgeServer.stop();
    }
    process.exit(0);
  });
}

main().catch(console.error);
```

## Step 3: Update package.json

```json
{
  "bin": {
    "web-ble-bridge": "./dist/cli.js",
    "web-ble-bridge-mcp": "./dist/mcp-server.js"
  },
  "scripts": {
    "build": "tsc && chmod +x dist/mcp-server.js"
  }
}
```

## Step 4: Test with mcp-cli

```bash
# Build
pnpm build

# Run MCP server
node dist/mcp-server.js

# In another terminal
mcp-cli cmd --server web-ble-bridge-mcp --tool status
mcp-cli cmd --server web-ble-bridge-mcp --tool get_logs --params='{"since":"30s"}'
```

## Step 5: Use from Claude Code

```json
{
  "mcpServers": {
    "web-ble-bridge": {
      "command": "node",
      "args": ["/path/to/web-ble-bridge/dist/mcp-server.js"],
      "env": {
        "BRIDGE_PORT": "8080",
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

## That's it!

With this minimal implementation:
- trakrf-handheld Claude can see real-time TX/RX logs
- Can check connection status
- Can scan for devices
- Total implementation time: ~1-2 hours

Future phases can add connect/disconnect/send tools as needed.