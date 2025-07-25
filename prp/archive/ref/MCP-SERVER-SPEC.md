# Web-BLE-Bridge MCP Server Specification

## Overview

An MCP (Model Context Protocol) server that allows Claude Code to directly interact with Bluetooth devices through web-ble-bridge. This enables natural language interactions like "What devices are available?" or "Send battery command to CS108".

## MCP Tools

### `ble_scan`
Scan for available Bluetooth devices.

```typescript
{
  name: "ble_scan",
  description: "Scan for nearby Bluetooth devices",
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
        description: "Filter devices by name prefix"
      }
    }
  }
}
```

### `ble_connect`
Connect to a Bluetooth device.

```typescript
{
  name: "ble_connect",
  description: "Connect to a Bluetooth device",
  inputSchema: {
    type: "object",
    properties: {
      deviceName: {
        type: "string",
        description: "Device name or prefix to connect to"
      },
      service: {
        type: "string",
        description: "Service UUID (optional, auto-detect if not provided)"
      },
      writeChar: {
        type: "string",
        description: "Write characteristic UUID"
      },
      notifyChar: {
        type: "string",
        description: "Notify characteristic UUID"
      }
    },
    required: ["deviceName"]
  }
}
```

### `ble_send`
Send data to connected device.

```typescript
{
  name: "ble_send",
  description: "Send hex data to connected BLE device",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "string",
        description: "Hex string to send (e.g., 'A7B302D98237000A000')"
      },
      expectResponse: {
        type: "boolean",
        description: "Wait for and return response",
        default: true
      },
      timeout: {
        type: "number",
        description: "Response timeout in milliseconds",
        default: 5000
      }
    },
    required: ["data"]
  }
}
```

### `ble_disconnect`
Disconnect from current device.

```typescript
{
  name: "ble_disconnect",
  description: "Disconnect from the currently connected BLE device"
}
```

### `ble_status`
Get current connection status.

```typescript
{
  name: "ble_status",
  description: "Get current BLE connection status and device info"
}
```

### `ble_logs`
Get recent BLE communication logs from the server's circular buffer.

```typescript
{
  name: "ble_logs",
  description: "Get recent BLE communication logs",
  inputSchema: {
    type: "object",
    properties: {
      since: {
        type: "string",
        description: "Get logs since: ISO timestamp, 'last' (since last query), or duration ('30s', '5m')",
        default: "last"
      },
      limit: {
        type: "number",
        description: "Maximum number of log entries to return",
        default: 100
      },
      level: {
        type: "string",
        enum: ["error", "info", "debug"],
        description: "Minimum log level to include"
      },
      follow: {
        type: "boolean",
        description: "Wait for new logs up to timeout",
        default: false
      },
      timeout: {
        type: "number",
        description: "Max milliseconds to wait when following",
        default: 5000
      }
    }
  }
}
```

Note: Server maintains logs in memory only (circular buffer). 
No persistence across server restarts.

## Usage Examples

### Claude Code Interactions

```
User: What BLE devices are available?
Claude: I'll scan for nearby Bluetooth devices.
[Uses ble_scan tool]
I found these devices:
- CS108Reader123456 (RFID reader)
- HP_Printer_5E4D (Printer)
- iPad (Apple device)
- MacBook Air (Computer)

User: Connect to the CS108
Claude: I'll connect to the CS108 reader.
[Uses ble_connect tool with deviceName: "CS108"]
Successfully connected to CS108Reader123456!

User: Get the battery level
Claude: I'll send the battery voltage command to the CS108.
[Uses ble_send with data: "A7B302D98237000A000"]
Battery voltage response: 4.1V (device reports 0x1004)

User: Monitor the communication for a bit
Claude: I'll show you the recent communication logs.
[Uses ble_logs tool with follow: true]
Recent BLE communication:
[TX] A7B302D98237000A000 (GET_BATTERY_VOLTAGE)
[RX] A7B304D98237004100... (Response: 4.1V)
...

User: What happened in the last 30 seconds?
Claude: Let me check the recent activity.
[Uses ble_logs with since: "30s"]
In the last 30 seconds:
- 3 battery voltage queries
- 2 inventory scans
- Average response time: 487ms
```

### Advanced Scenarios

```
User: Run a stress test on the CS108
Claude: I'll run a series of rapid commands to test the connection stability.
[Uses ble_send multiple times with different commands]
Stress test results:
- Sent 50 commands in 25 seconds
- All responses received
- Average round-trip time: 487ms
- No errors or disconnections

User: Compare response times between my CS108 and the nRF52 simulator
Claude: I'll test both devices and compare their performance.
[Connects to each device and runs timing tests]
Performance comparison:
- CS108: Average response 487ms (real hardware)
- nRF52 Simulator: Average response 12ms (local simulator)
- The simulator is 40x faster, perfect for development!
```

## Implementation Architecture

### MCP Server Structure

```typescript
// mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { BridgeServer } from './bridge-server.js';
import { WebSocketTransport } from './ws-transport.js';

class WebBleBridgeMCP {
  private bridge?: BridgeServer;
  private wsClient?: WebSocketTransport;
  private currentDevice?: string;
  private logBuffer: CircularBuffer<LogEntry>;
  private clientLogPositions: Map<string, number>;

  constructor() {
    // In-memory circular buffer for logs (no persistence)
    this.logBuffer = new CircularBuffer(10000); // ~10k entries
    this.clientLogPositions = new Map();
  }

  async initialize(options: { 
    mode: 'server' | 'client',
    url?: string 
  }) {
    if (options.mode === 'server') {
      // Start local bridge server
      this.bridge = new BridgeServer('info');
      await this.bridge.start(8080);
    } else {
      // Connect to remote bridge
      this.wsClient = new WebSocketTransport(options.url);
    }
  }

  // Tool implementations...
}
```

### Configuration

MCP server can be configured in Claude Code's settings:

```json
{
  "mcpServers": {
    "web-ble-bridge": {
      "command": "node",
      "args": ["./dist/mcp-server.js"],
      "env": {
        "BRIDGE_MODE": "server",
        "BRIDGE_PORT": "8080",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

Or for remote bridge:

```json
{
  "mcpServers": {
    "web-ble-bridge": {
      "command": "node", 
      "args": ["./dist/mcp-server.js"],
      "env": {
        "BRIDGE_MODE": "client",
        "BRIDGE_URL": "ws://192.168.1.100:8080"
      }
    }
  }
}
```

## Benefits

1. **Natural Language BLE Control** - "Connect to my RFID reader and check the battery"
2. **Cross-Project Usage** - Same MCP server works for any project needing BLE
3. **Remote Device Access** - Connect to BLE devices on other machines
4. **Debugging Paradise** - "Show me what's happening with the Bluetooth connection"
5. **Automated Testing** - Claude can run comprehensive BLE tests autonomously

## Future Enhancements

1. **Device Profiles** - Save common device configurations
2. **Batch Operations** - Send multiple commands in sequence
3. **Event Streaming** - Real-time notifications from devices
4. **Protocol Decoders** - Automatic parsing of known protocols (CS108, nRF52, etc.)
5. **Performance Analytics** - Track connection quality over time

## Integration with CLI

The MCP server would use the same underlying modules as the CLI, ensuring consistency:
- Both use `noble-transport.ts` for BLE operations
- Both can connect to remote bridges via WebSocket
- Commands map naturally between CLI and MCP tools

This creates a unified ecosystem where developers can:
- Use CLI for manual testing
- Use MCP for AI-assisted development
- Share configurations between both