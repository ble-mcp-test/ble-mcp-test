# Web-BLE-Bridge MCP Specification - trakrf-handheld Priorities

## Overview

Based on trakrf-handheld's immediate debugging needs, this spec prioritizes packet search and analysis tools over generic status commands.

## Phase 1: Critical Debugging Tools

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
        description: "Filter: 'TX', 'RX', 'START_INVENTORY', 'tag', 'error', hex pattern",
        examples: ["TX", "RX", "0x0201", "START_INVENTORY", "tag", "error"]
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

Returns enhanced logs with interpretation:
```json
{
  "logs": [
    {
      "timestamp": "2024-01-15T10:23:45.123Z",
      "type": "TX",
      "hex": "A7B3010018000000700201AAA2",
      "interpretation": "START_INVENTORY command",
      "command": "START_INVENTORY",
      "raw": "[TX] A7B3010018000000700201AAA2"
    },
    {
      "timestamp": "2024-01-15T10:23:45.234Z",
      "type": "RX", 
      "hex": "0201E200000017394439454E30303234353632",
      "interpretation": "Tag data: E20000173944394EN00245622",
      "command": "TAG_DATA",
      "raw": "[RX] 0201E200000017394439454E30303234353632"
    }
  ],
  "count": 2,
  "hasMore": false
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
        description: "Command type to find",
        enum: ["START_INVENTORY", "STOP_INVENTORY", "GET_BATTERY_VOLTAGE", "TAG_DATA", "ANY"],
        examples: ["START_INVENTORY", "TAG_DATA"]
      },
      hex_pattern: {
        type: "string",
        description: "Hex pattern to search (e.g., '0201' for tag data)"
      },
      correlation: {
        type: "object",
        description: "Find correlated packets",
        properties: {
          tx_command: {
            type: "string",
            description: "TX command to correlate with (e.g., 'START_INVENTORY')"
          },
          window_ms: {
            type: "number",
            description: "Time window in milliseconds",
            default: 1000
          }
        }
      },
      time_range: {
        type: "object",
        properties: {
          start: { type: "string", description: "ISO timestamp or duration (e.g., '30s')" },
          end: { type: "string", description: "ISO timestamp or 'now'" }
        }
      }
    }
  }
}
```

Returns:
```json
{
  "packets": [
    {
      "timestamp": "2024-01-15T10:23:45.123Z",
      "type": "TX",
      "hex": "A7B3010018000000700201AAA2",
      "command": "START_INVENTORY",
      "correlated_responses": [
        {
          "timestamp": "2024-01-15T10:23:45.234Z",
          "type": "RX",
          "hex": "0201E200000017394439454E30303234353632",
          "command": "TAG_DATA",
          "latency_ms": 111
        },
        {
          "timestamp": "2024-01-15T10:23:45.345Z",
          "type": "RX",
          "hex": "0201E200000017394439454E30303234356AB",
          "command": "TAG_DATA",
          "latency_ms": 222
        }
      ]
    }
  ],
  "summary": {
    "total_found": 15,
    "by_command": {
      "START_INVENTORY": 3,
      "TAG_DATA": 12
    },
    "correlation_summary": "Found 12 TAG_DATA responses within 1000ms of START_INVENTORY commands"
  }
}
```

### 3. `get_connection_state` - Detailed Activity Info
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

Returns:
```json
{
  "connected": true,
  "device": {
    "name": "CS108Reader123456",
    "connected_at": "2024-01-15T10:23:40.000Z",
    "connection_duration_ms": 305000
  },
  "last_activity": {
    "timestamp": "2024-01-15T10:23:45.487Z",
    "seconds_ago": 2,
    "type": "RX",
    "command": "TAG_DATA",
    "hex": "0201E200000017394439454E30303234353632"
  },
  "last_tx": {
    "timestamp": "2024-01-15T10:23:45.123Z",
    "command": "START_INVENTORY",
    "hex": "A7B3010018000000700201AAA2"
  },
  "last_rx": {
    "timestamp": "2024-01-15T10:23:45.487Z", 
    "command": "TAG_DATA",
    "hex": "0201E200000017394439454E30303234353632"
  },
  "statistics": {
    "packets_tx": 73,
    "packets_rx": 145,
    "errors": 0,
    "last_error": null
  },
  "pending_operations": []
}
```

## Phase 2: Nice to Have (Later)

- `status` - Basic server status
- `scan_devices` - Find BLE devices
- `connect` / `disconnect` / `send` - Direct device control

## Example Usage for Debugging

```bash
# 1. Check what's happening right now
mcp-cli cmd --server web-ble-bridge --tool get_connection_state

# 2. See last 30 seconds of activity
mcp-cli cmd --server web-ble-bridge --tool get_logs --params='{"since":"30s"}'

# 3. Find all START_INVENTORY commands
mcp-cli cmd --server web-ble-bridge --tool search_packets --params='{"command":"START_INVENTORY"}'

# 4. Find all tag data responses
mcp-cli cmd --server web-ble-bridge --tool search_packets --params='{"hex_pattern":"0201"}'

# 5. CRITICAL: Find RX packets within 1 second of START_INVENTORY
mcp-cli cmd --server web-ble-bridge --tool search_packets --params='{
  "correlation": {
    "tx_command": "START_INVENTORY",
    "window_ms": 1000
  }
}'
```

## Packet Interpretation Logic

The server should recognize common CS108 commands:

```typescript
const COMMANDS = {
  // TX Commands
  'A7B3010018': 'START_INVENTORY',
  'A7B3020018': 'STOP_INVENTORY', 
  'A7B302D982': 'GET_BATTERY_VOLTAGE',
  
  // RX Patterns
  '0201': 'TAG_DATA',
  'A7B304': 'COMMAND_RESPONSE',
  '0203': 'ERROR_RESPONSE'
};

function interpretPacket(hex: string, type: 'TX' | 'RX'): string {
  // Check for known command prefixes
  for (const [pattern, command] of Object.entries(COMMANDS)) {
    if (hex.toUpperCase().startsWith(pattern)) {
      return command;
    }
  }
  return 'UNKNOWN';
}
```

## Benefits for trakrf-handheld

1. **Immediate visibility**: "Did START_INVENTORY get sent?" ✓
2. **Response detection**: "Did ANY tag data come back?" ✓  
3. **Correlation**: "Which responses came from which commands?" ✓
4. **Pattern analysis**: "Is the retry pattern different?" ✓

This gives them exactly what they need to debug the inventory test issue.