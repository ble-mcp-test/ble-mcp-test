# Phase 1: MCP Server for BLE Bridge

## FEATURE:
Implement a minimal MCP (Model Context Protocol) server that exposes BLE bridge debugging capabilities. The server will be protocol-agnostic, focusing on raw data transmission and connection management.

### Core Functionality:
1. **Circular log buffer** - Store last N TX/RX packets (configurable, default 10,000) with global sequence numbering
2. **5 MCP tools** to expose:
   - `get_logs` - Retrieve recent BLE communication logs with filtering
   - `search_packets` - Search for hex patterns and correlate TX/RX packets
   - `get_connection_state` - Get detailed connection state and activity
   - `status` - Get bridge server status
   - `scan_devices` - Scan for BLE devices (with connection conflict handling)

### Key Requirements:
- Protocol-agnostic (no device-specific interpretation)
- In-memory only (no persistence)
- Works with standard MCP clients (mcp-cli, MCP Tools, Claude Code)
- Refuse scanning while connected to prevent adapter conflicts
- Global sequence numbering for packet ordering

## EXAMPLES:

### MCP Tool Schema Example - get_logs:
```typescript
{
  name: "get_logs",
  description: "Get raw BLE communication logs",
  inputSchema: {
    type: "object",
    properties: {
      since: {
        type: "string",
        description: "ISO timestamp, 'last', or duration ('30s', '5m', '1h')",
        default: "30s"
      },
      filter: {
        type: "string",
        description: "Filter logs by hex pattern or 'TX'/'RX'"
      },
      limit: {
        type: "number",
        description: "Maximum log entries to return",
        default: 100,
        maximum: 1000
      }
    }
  }
}
```

### Response Format Example:
```json
{
  "logs": [
    {
      "id": 1234,
      "timestamp": "2024-01-15T10:23:45.123Z",
      "direction": "TX",
      "hex": "A7B3010018000000700201AAA2",
      "size": 12
    },
    {
      "id": 1235,
      "timestamp": "2024-01-15T10:23:45.234Z",
      "direction": "RX",
      "hex": "0201E200000017394439454E30303234353632",
      "size": 19
    }
  ],
  "count": 2,
  "truncated": false
}
```

### Log Buffer Implementation Pattern:
```typescript
interface LogEntry {
  id: number;              // Global sequence number
  timestamp: string;       // ISO timestamp
  direction: 'TX' | 'RX';  // Packet direction
  hex: string;             // Raw hex data
  size: number;            // Byte count
}

class LogBuffer {
  private buffer: LogEntry[] = [];
  private maxSize = 10000;
  private sequenceCounter = 0;
  private clientPositions = new Map<string, number>();
  
  push(entry: Omit<LogEntry, 'id'>) {
    this.buffer.push({
      id: this.sequenceCounter++,
      timestamp: new Date().toISOString(),
      size: entry.hex.length / 2,  // hex string to byte count
      ...entry
    });
    
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }
}
```

### Usage Examples:
```bash
# With MCP Tools
mcp call get_logs node dist/mcp-server.js
mcp call search_packets --params '{"hex_pattern":"A7B3"}' node dist/mcp-server.js
mcp call get_connection_state node dist/mcp-server.js

# Interactive mode
mcp shell node dist/mcp-server.js
> get_logs since=1m
> search_packets hex_pattern=0201

# With Claude Code settings.json
{
  "mcpServers": {
    "web-ble-bridge": {
      "command": "node",
      "args": ["/path/to/dist/mcp-server.js"],
      "env": {
        "BRIDGE_PORT": "8080",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

### Error Handling Example:
```json
// When scanning while connected
{
  "error": "Cannot scan while connected to a device. Please disconnect first.",
  "code": "SCAN_WHILE_CONNECTED"
}
```

## DOCUMENTATION:
- [MCP SDK Documentation](https://github.com/modelcontextprotocol/sdk)
- [MCP Tools CLI](https://github.com/f/mcptools)
- [MCP Protocol Specification](https://modelcontextprotocol.io/docs)
- [MCP Registry](https://github.com/modelcontextprotocol/registry)
- [awesome-mcp-servers](https://github.com/appcypher/awesome-mcp-servers)
- Similar implementations:
  - [MCP filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)
  - [MCP memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)

## OTHER CONSIDERATIONS:
- **Package manager**: Must use pnpm (not npm/yarn)
- **Dependencies**: Only `@modelcontextprotocol/sdk` (no device-specific libraries)
- **Node.js version**: 24.x required for BLE compatibility
- **Architecture principle**: Transport layer only - NO protocol interpretation
- **Separation of concerns**: Device-specific logic belongs at test/application layer
- **Scan conflict**: Must refuse BLE scanning while connected (adapter limitation)
- **Performance**: Circular buffer configurable (default 10k) via LOG_BUFFER_SIZE env var
- **Client tracking**: Each MCP client gets tracked position for "since: last" queries
- **Distribution strategy**: 
  - Publish to npm as `@trakrf/web-ble-bridge`
  - Submit to MCP registry for discoverability
- **Testing requirements**:
  - Unit tests for log buffer
  - Integration tests for MCP handlers
  - Manual validation with trakrf-handheld use case
- **Timeline**: ~3.5 hours (2h implementation, 1h testing, 0.5h documentation)
- **Future extensions** (NOT in Phase 1):
  - Plugin system for packet interpreters
  - Device-specific packages (e.g., `@trakrf/web-ble-bridge-cs108`)
  - Real-time streaming when MCP supports it