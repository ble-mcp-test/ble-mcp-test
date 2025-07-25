# Web-BLE-Bridge MCP-First Specification

## Overview

Web-ble-bridge exposes all functionality through MCP (Model Context Protocol) tools. This enables:
- Claude Code direct integration
- CLI access via any MCP client (mcp-cli, mcptools, etc.)
- Unified interface for all consumers
- No custom CLI to maintain

## Using the MCP Server

### With Claude Code

```json
// In Claude Code settings
{
  "mcpServers": {
    "web-ble-bridge": {
      "command": "npx",
      "args": ["@trakrf/web-ble-bridge", "mcp"],
      "env": {
        "BRIDGE_PORT": "8080",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

### With CLI Clients

```bash
# Using mcp-cli
mcp-cli cmd --server web-ble-bridge --tool status
mcp-cli cmd --server web-ble-bridge --tool get_logs --params='{"since":"30s"}'

# Using mcptools
mcp tools npx @trakrf/web-ble-bridge mcp
mcp call scan_devices --params '{"duration": 5000}' npx @trakrf/web-ble-bridge mcp

# Interactive mode
mcp-cli interactive --server web-ble-bridge
```

## Phase 1: Build Now (High ROI for trakrf-handheld debugging)

### 1. `get_logs` - Debug Protocol Issues
```typescript
{
  name: "get_logs",
  description: "Get BLE communication logs from circular buffer",
  inputSchema: {
    type: "object",
    properties: {
      since: {
        type: "string",
        description: "ISO timestamp, 'last', or duration ('30s', '5m')",
        default: "last"
      },
      level: {
        type: "string",
        enum: ["error", "info", "debug"],
        description: "Minimum log level",
        default: "info"
      },
      filter: {
        type: "string",
        description: "Filter pattern (e.g., 'TX', 'RX', '0x0201')"
      }
    }
  }
}
```

Returns:
```json
{
  "logs": [
    {
      "timestamp": "2024-01-15T10:23:45.123Z",
      "level": "info",
      "message": "[TX] A7B302D98237000A000 (GET_BATTERY_VOLTAGE)",
      "data": "A7B302D98237000A000"
    },
    {
      "timestamp": "2024-01-15T10:23:45.487Z",
      "level": "info", 
      "message": "[RX] A7B304D98237004100... (4.1V)",
      "data": "A7B304D98237004100..."
    }
  ],
  "count": 2,
  "hasMore": false
}
```

### 2. `status` - Connection State
```typescript
{
  name: "status",
  description: "Get current BLE connection status",
  inputSchema: {
    type: "object",
    properties: {}
  }
}
```

Returns:
```json
{
  "connected": true,
  "device": "CS108Reader123456",
  "connectionTime": "2024-01-15T10:23:40.000Z",
  "packetsRx": 145,
  "packetsTx": 73,
  "lastActivity": "2024-01-15T10:23:45.487Z"
}
```

### 3. `scan_devices` - Find BLE Devices
```typescript
{
  name: "scan_devices",
  description: "Scan for available BLE devices",
  inputSchema: {
    type: "object",
    properties: {
      duration: {
        type: "number",
        description: "Scan duration in milliseconds",
        default: 5000
      },
      nameFilter: {
        type: "string",
        description: "Filter by device name prefix"
      }
    }
  }
}
```

## Phase 2: Nice to Have (Future)

### 4. `connect` - Connect to Device
```typescript
{
  name: "connect",
  description: "Connect to a BLE device",
  inputSchema: {
    type: "object",
    properties: {
      device: { type: "string", description: "Device name or UUID" },
      service: { type: "string", description: "Service UUID" },
      writeChar: { type: "string", description: "Write characteristic UUID" },
      notifyChar: { type: "string", description: "Notify characteristic UUID" }
    },
    required: ["device"]
  }
}
```

### 5. `send` - Send Data
```typescript
{
  name: "send",
  description: "Send hex data to connected device",
  inputSchema: {
    type: "object",
    properties: {
      hex: { type: "string", description: "Hex string to send" },
      expectResponse: { type: "boolean", default: true }
    },
    required: ["hex"]
  }
}
```

### 6. `disconnect` - Disconnect Device
```typescript
{
  name: "disconnect",
  description: "Disconnect from current device"
}
```

## Implementation Architecture

### Minimal MCP Server (Phase 1)

```typescript
// mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { BridgeServer } from './bridge-server.js';

class WebBleBridgeMCP {
  private bridge: BridgeServer;
  private logBuffer: CircularBuffer<LogEntry>;
  private clientPositions = new Map<string, number>();

  constructor() {
    this.logBuffer = new CircularBuffer(10000); // In-memory only
    this.bridge = new BridgeServer('info');
  }

  async start() {
    // Start bridge server
    await this.bridge.start(8080);
    
    // Hook into bridge logging
    this.bridge.on('log', (entry) => {
      this.logBuffer.push(entry);
    });

    // Register MCP tools
    const server = new Server({
      name: 'web-ble-bridge',
      version: '0.3.0'
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_logs',
          description: 'Get BLE communication logs',
          inputSchema: { /* ... */ }
        },
        {
          name: 'status',
          description: 'Get connection status',
          inputSchema: { /* ... */ }
        },
        {
          name: 'scan_devices',
          description: 'Scan for BLE devices',
          inputSchema: { /* ... */ }
        }
      ]
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'get_logs':
          return this.getLogs(request.params.arguments);
        case 'status':
          return this.getStatus();
        case 'scan_devices':
          return this.scanDevices(request.params.arguments);
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }
    });

    // Start MCP server
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  private getLogs(args: any) {
    const { since = 'last', level = 'info', filter } = args;
    
    // Handle 'last' by tracking client position
    let fromIndex = 0;
    if (since === 'last') {
      fromIndex = this.clientPositions.get(/* client id */) || 0;
    } else if (since.match(/^\d+[smh]$/)) {
      // Parse duration like '30s'
      const duration = parseDuration(since);
      fromIndex = this.logBuffer.findIndexSince(Date.now() - duration);
    }

    const logs = this.logBuffer.getFrom(fromIndex)
      .filter(log => log.level >= level)
      .filter(log => !filter || log.message.includes(filter));

    this.clientPositions.set(/* client id */, this.logBuffer.length);

    return { 
      content: [{ 
        type: 'text', 
        text: JSON.stringify({ logs, count: logs.length }) 
      }] 
    };
  }
}
```

## Installation Instructions

```bash
# Install web-ble-bridge with MCP support
npm install -g @trakrf/web-ble-bridge

# Install an MCP CLI client
pip install mcp-cli
# OR
brew tap f/mcptools && brew install mcp

# Start the MCP server
web-ble-bridge mcp

# In another terminal, use any MCP client
mcp-cli cmd --server web-ble-bridge --tool status
```

## Example Usage for trakrf-handheld Debugging

```bash
# 1. Check connection status
mcp-cli cmd --server web-ble-bridge --tool status

# 2. User clicks button in UI
# ...

# 3. Check what happened in last 5 seconds
mcp-cli cmd --server web-ble-bridge --tool get_logs --params='{"since":"5s"}'

# 4. Filter for specific command
mcp-cli cmd --server web-ble-bridge --tool get_logs --params='{"filter":"START_INVENTORY"}'

# 5. Interactive debugging session
mcp-cli interactive --server web-ble-bridge
> get_logs since=30s
> status
> get_logs filter=0x0201 level=debug
```

## Benefits of MCP-First Approach

1. **No Custom CLI** - Use any existing MCP client
2. **Single Implementation** - MCP tools serve all consumers
3. **Claude Integration** - Direct access from Claude Code
4. **Standard Protocol** - Tool discovery, logging, etc. built-in
5. **Extensible** - Add new tools without changing clients

## Migration Path

1. Phase 1 (Immediate): Implement core 3 tools for debugging
2. Document usage with existing MCP clients
3. Phase 2 (Later): Add device control tools as needed
4. Deprecate any custom CLI in favor of MCP

## Success Metrics

- trakrf-handheld can debug protocol issues in real-time
- Zero custom CLI code to maintain
- Any MCP client can control the bridge
- Claude Code can directly access bridge functionality