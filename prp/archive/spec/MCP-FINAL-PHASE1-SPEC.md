# Web-BLE-Bridge MCP Phase 1 Final Specification

## Overview

MCP server implementation with both trakrf-handheld's priority tools AND low-hanging fruit that's easy to add.

## Phase 1 Tools (Ship Today)

### 1. `get_logs` - Enhanced with Packet Interpretation
```typescript
{
  name: "get_logs",
  description: "Get BLE communication logs with packet interpretation",
  inputSchema: {
    type: "object",
    properties: {
      since: {
        type: "string",
        description: "ISO timestamp, 'last', or duration ('30s', '5m')",
        default: "30s"
      },
      filter: {
        type: "string",
        description: "Filter: 'TX', 'RX', 'START_INVENTORY', 'tag', 'error', hex pattern"
      },
      limit: {
        type: "number",
        description: "Maximum entries to return",
        default: 100,
        maximum: 1000
      }
    }
  }
}
```

### 2. `search_packets` - Find Specific Patterns
```typescript
{
  name: "search_packets",
  description: "Search for specific packet patterns and correlations",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Command type to find"
      },
      hex_pattern: {
        type: "string",
        description: "Hex pattern to search"
      },
      correlation: {
        type: "object",
        properties: {
          tx_command: { type: "string" },
          window_ms: { type: "number", default: 1000 }
        }
      }
    }
  }
}
```

### 3. `get_connection_state` - Detailed Connection Info
```typescript
{
  name: "get_connection_state",
  description: "Get detailed connection state and recent activity",
  inputSchema: {
    type: "object",
    properties: {}
  }
}
```

### 4. `status` - Server & Connection Status (Low-hanging fruit)
```typescript
{
  name: "status",
  description: "Get bridge server and connection status",
  inputSchema: {
    type: "object",
    properties: {}
  }
}
```

Returns:
```json
{
  "server": {
    "running": true,
    "port": 8080,
    "version": "0.3.0",
    "uptime_seconds": 3600
  },
  "connection": {
    "connected": true,
    "device": "CS108Reader123456",
    "duration_seconds": 145,
    "connected_at": "2024-01-15T10:23:40.000Z"
  }
}
```

Or when not connected:
```json
{
  "server": {
    "running": true,
    "port": 8080,
    "version": "0.3.0",
    "uptime_seconds": 3600
  },
  "connection": {
    "connected": false,
    "device": null,
    "duration_seconds": 0,
    "connected_at": null
  }
}
```

### 5. `scan_devices` - BLE Device Scan (Low-hanging fruit)
```typescript
{
  name: "scan_devices",
  description: "Scan for BLE devices",
  inputSchema: {
    type: "object",
    properties: {
      duration: {
        type: "number",
        description: "Scan duration in ms",
        default: 5000
      }
    }
  }
}
```

Returns:
```json
{
  "devices": [
    { "id": "uuid", "name": "CS108Reader123456", "rssi": -45 },
    { "id": "uuid", "name": "Device2", "rssi": -67 }
  ],
  "count": 2
}
```

## Implementation Order

1. **Core infrastructure** (30 min)
   - MCP server setup
   - Circular log buffer
   - Basic tool registration

2. **Easy tools** (15 min)
   - `status` - Just return static info
   - `scan_devices` - Call existing Noble scan

3. **Connection state** (15 min)
   - `get_connection_state` - Bridge already tracks this

4. **Log tools** (30 min)
   - `get_logs` - Read from buffer with filtering
   - Basic packet interpretation

5. **Search tool** (30 min)
   - `search_packets` - More complex but high value

Total: ~2 hours

## Benefits

- **trakrf-handheld gets**: Full debugging capability
- **Everyone gets**: Basic status/scan tools
- **Future-proof**: Easy to add more tools later

## Testing

```bash
# Quick sanity check
mcp call status node dist/mcp-server.js

# Scan for devices  
mcp call scan_devices node dist/mcp-server.js

# Debug trakrf-handheld issue
mcp call get_logs --params '{"filter":"START_INVENTORY"}' node dist/mcp-server.js
mcp call search_packets --params '{"hex_pattern":"0201"}' node dist/mcp-server.js
```