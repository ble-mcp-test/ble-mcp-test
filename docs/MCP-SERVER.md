# MCP Server Documentation

## Overview

Web-ble-bridge includes an integrated MCP (Model Context Protocol) server that provides powerful debugging and analysis capabilities for BLE communication. The MCP server runs alongside the WebSocket bridge, exposing tools through both stdio and HTTP/SSE transports.

## Architecture

The MCP server is integrated directly into the bridge server process:

```
┌─────────────────────────────────────┐
│         Bridge Server Process       │
├─────────────────────────────────────┤
│  WebSocket Server (Port 8080)       │
│  ├─ BLE Device Connection           │
│  └─ Web Client Connection           │
├─────────────────────────────────────┤
│  MCP Server                         │
│  ├─ Stdio Transport (local)         │
│  └─ HTTP/SSE Transport (Port 3000)  │
├─────────────────────────────────────┤
│  Shared Components                  │
│  ├─ Circular Log Buffer (10k)       │
│  ├─ Connection State Manager        │
│  └─ BLE Transport Layer             │
└─────────────────────────────────────┘
```

## Transports

### HTTP/SSE Transport (Default)

The HTTP transport allows network access from VMs, containers, and other machines:

- **Port**: 3000 (configurable via `MCP_PORT`)
- **Protocol**: HTTP with Server-Sent Events (SSE)
- **Authentication**: Optional bearer token
- **CORS**: Permissive for local network use

### Stdio Transport

Available when running with TTY (interactive terminal):

- **Auto-enabled**: When `process.stdin.isTTY` is true
- **Disabled**: In cloud/Docker environments without TTY
- **Force disable**: Set `DISABLE_STDIO=true`

## Available Tools

### 1. get_logs

Retrieve recent BLE communication logs from the circular buffer.

**Parameters:**
- `since` (string, default: "30s"): Time filter
  - Duration: "30s", "5m", "1h"
  - ISO timestamp: "2024-01-15T10:30:00Z"
  - Special: "last" (from last seen position)
- `filter` (string, optional): Filter logs
  - "TX" or "RX" for direction
  - Hex pattern for content matching
- `limit` (number, default: 100, max: 1000): Maximum entries

**Example:**
```json
{
  "name": "get_logs",
  "arguments": {
    "since": "5m",
    "filter": "TX",
    "limit": 50
  }
}
```

**Response:**
```json
{
  "logs": [
    {
      "id": 1234,
      "timestamp": "2024-01-15T10:23:45.123Z",
      "direction": "TX",
      "hex": "A7 B3 02 00",
      "size": 4
    }
  ],
  "count": 1,
  "truncated": false
}
```

### 2. search_packets

Search for specific hex patterns across all logged packets.

**Parameters:**
- `hex_pattern` (string, required): Hex pattern to search
  - Supports spaces: "A7 B3" or "A7B3"
  - Case insensitive: "a7b3" or "A7B3"
  - Partial matches: "B3" finds "A7 B3 02"
- `limit` (number, default: 100, max: 1000): Maximum results

**Example:**
```json
{
  "name": "search_packets",
  "arguments": {
    "hex_pattern": "A7 B3",
    "limit": 20
  }
}
```

**Response:**
```json
{
  "matches": [
    {
      "id": 1234,
      "timestamp": "2024-01-15T10:23:45.123Z",
      "direction": "TX",
      "hex": "A7 B3 02 00",
      "size": 4
    }
  ],
  "count": 1,
  "pattern": "A7 B3"
}
```

### 3. get_connection_state

Get current BLE connection status and statistics.

**Parameters:** None

**Response:**
```json
{
  "connected": true,
  "deviceName": "CS108Reader2603A7",
  "connectedAt": "2024-01-15T10:20:00.000Z",
  "lastActivity": "2024-01-15T10:23:45.123Z",
  "packetsTransmitted": 42,
  "packetsReceived": 38
}
```

### 4. status

Get bridge server status and configuration.

**Parameters:** None

**Response:**
```json
{
  "version": "0.3.0",
  "uptime": 3600,
  "wsPort": 8080,
  "mcpPort": 3000,
  "logBufferSize": 10000,
  "logBufferUsed": 1532,
  "connections": {
    "websocket": 1,
    "mcp": 2
  }
}
```

### 5. scan_devices

Scan for nearby BLE devices. 

⚠️ **Important**: This tool will fail if already connected to a device to prevent BLE adapter conflicts.

**Parameters:**
- `duration` (number, default: 5000, min: 1000, max: 30000): Scan duration in milliseconds

**Example:**
```json
{
  "name": "scan_devices",
  "arguments": {
    "duration": 10000
  }
}
```

**Response:**
```json
{
  "devices": [
    {
      "id": "e245f25413c2e682de9eefb9adc81d88",
      "name": "CS108Reader2603A7",
      "rssi": -42
    }
  ],
  "count": 1,
  "duration": 10000
}
```

## Configuration

### Environment Variables

```bash
# MCP Server Configuration
MCP_PORT=3000              # HTTP transport port
MCP_TOKEN=secret123        # Optional bearer token
LOG_BUFFER_SIZE=50000      # Circular buffer size (default: 10000)

# Disable transports
DISABLE_STDIO=true         # Force disable stdio transport
```

### Authentication

For local network security:

```bash
# Option 1: Auto-generate token
pnpm start:auth

# Option 2: Set explicit token
MCP_TOKEN=your-secret-token pnpm start

# Option 3: Use .env.local
echo "MCP_TOKEN=your-secret-token" >> .env.local
pnpm start
```

## Client Configuration

### Claude Code

Add to your `settings.json`:

```json
{
  "mcpServers": {
    "ble-mcp-test": {
      "transport": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  }
}
```

### Network Access

For access from VMs or other machines:

```json
{
  "mcpServers": {
    "ble-mcp-test": {
      "transport": "http",
      "url": "http://macbook.local:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  }
}
```

### Using mcp-cli

```bash
# List available tools
uvx mcp-cli tools

# Call a specific tool
uvx mcp-cli call get_logs --server ble-mcp-test

# Interactive mode
uvx mcp-cli chat --server ble-mcp-test
```

## Security Considerations

⚠️ **WARNING**: The MCP HTTP transport is designed for LOCAL NETWORK USE ONLY.

### Why Local Only?

1. **Minimal Authentication**: Only bearer token support
2. **Permissive CORS**: Allows all origins
3. **Sensitive Data**: Exposes all BLE communication
4. **Control Access**: Can trigger BLE device scans

### Best Practices

1. **Always use authentication** for network access:
   ```bash
   MCP_TOKEN=strong-random-token pnpm start
   ```

2. **Firewall rules** to restrict access:
   ```bash
   # Allow only local network
   sudo ufw allow from 192.168.0.0/16 to any port 3000
   ```

3. **Use SSH tunneling** for remote access:
   ```bash
   # On remote machine
   ssh -L 3000:localhost:3000 user@ble-host
   ```

## Debugging

### Check MCP Server Status

```bash
# Verify HTTP server is running
curl http://localhost:3000/health

# Test with authentication
curl -H "Authorization: Bearer your-token" http://localhost:3000/health
```

### View Server Logs

```bash
# Start with debug logging
LOG_LEVEL=debug pnpm start

# Watch for MCP-specific logs
[MCP HTTP] Server listening on port 3000
[MCP HTTP] New session initialized: <session-id>
```

### Common Issues

1. **"Cannot scan while connected"**
   - Disconnect from BLE device first
   - The bridge enforces single connection

2. **"Session not found"**
   - MCP clients must include Accept header
   - Must accept both `application/json` and `text/event-stream`

3. **"Unauthorized"**
   - Check MCP_TOKEN matches between server and client
   - Include "Bearer " prefix in Authorization header

## Examples

### Get Recent TX Packets

```javascript
// Using fetch API
const response = await fetch('http://localhost:3000/mcp', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Mcp-Session-Id': sessionId
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'get_logs',
      arguments: {
        since: '1m',
        filter: 'TX',
        limit: 50
      }
    }
  })
});
```

### Search for Battery Commands

```javascript
// Search for CS108 battery voltage command (A000)
const response = await fetch('http://localhost:3000/mcp', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Mcp-Session-Id': sessionId
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'search_packets',
      arguments: {
        hex_pattern: 'A0 00',
        limit: 100
      }
    }
  })
});
```

## Client Position Tracking

The MCP server tracks each client's last seen log position for efficient log retrieval:

1. **First request**: `since: "5m"` returns logs from 5 minutes ago
2. **Server tracks**: Last log ID seen by this client
3. **Next request**: `since: "last"` returns only new logs
4. **Efficient streaming**: No duplicate logs sent

This enables efficient log streaming without overwhelming clients with historical data.