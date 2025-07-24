name: "Phase 1 MCP Server for BLE Bridge - Debugging & Analysis Tools"
description: |

## Purpose
Implement a minimal MCP (Model Context Protocol) server that exposes BLE bridge debugging capabilities with a circular log buffer, protocol-agnostic raw data transmission, and 5 essential tools for connection management and packet analysis.

## Core Principles
1. **Protocol Agnostic**: No device-specific interpretation - pure transport layer
2. **In-Memory Only**: No persistence, circular buffer of 10k entries
3. **MCP Standards**: Works with standard MCP clients (mcp-cli, MCP Tools, Claude Code)
4. **Safety First**: Refuse scanning while connected to prevent adapter conflicts
5. **Global Sequence**: Universal packet ordering with sequence IDs

---

## Goal
Create an MCP server (`src/mcp-server.ts`) that:
- Connects to the existing bridge server at localhost:8080
- Maintains a circular log buffer of last 10,000 TX/RX packets
- Exposes 5 debugging tools via MCP protocol
- Tracks per-client positions for "since: last" queries
- Provides raw hex data without interpretation
- Version bump to 0.3.0 with documentation updates

## Why
- **Debugging**: Real-time visibility into BLE communication for trakrf-handheld testing
- **Integration**: Works with any MCP-compatible client (Claude Code, CLI tools)
- **Analysis**: Search and correlate TX/RX packets with hex patterns
- **Observability**: Connection state monitoring without modifying bridge core

## What
An MCP server that acts as a debugging sidecar to the web-ble-bridge, exposing:
1. Recent communication logs with filtering
2. Hex pattern search across packets
3. Connection state and activity monitoring
4. Bridge server status
5. BLE device scanning (with conflict protection)

### Success Criteria
- [ ] All 5 MCP tools working with mcp-cli
- [ ] Circular buffer maintains exactly 10k entries
- [ ] Per-client position tracking for "last" queries
- [ ] Hex pattern search with TX/RX correlation
- [ ] Proper error handling for scan-while-connected
- [ ] Integration tests pass with mock data
- [ ] Version 0.3.0 published to npm
- [ ] MCP registry submission ready

## All Needed Context

### Documentation & References
```yaml
# MUST READ - Include these in your context window
- url: https://github.com/modelcontextprotocol/typescript-sdk
  why: Official TypeScript SDK for creating MCP servers
  
- url: https://modelcontextprotocol.io/docs
  why: MCP protocol specification and tool schema requirements
  
- url: https://github.com/modelcontextprotocol/servers/tree/main/src/memory
  why: Reference implementation for in-memory storage pattern
  
- url: https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem
  why: Tool registration and error handling patterns
  
- file: src/bridge-server.ts
  why: Understand WebSocket server structure and log streaming
  lines: 32-45, 188-223
  
- file: src/utils.ts
  why: formatHex function for data display consistency
  
- file: prp/ref/SEQUENCE-NUMBERING-DESIGN.md
  why: Global sequence numbering implementation pattern
  
- file: package.json
  why: Current dependencies and script patterns
```

### Current Codebase tree
```bash
/home/mike/web-ble-bridge/
├── src/
│   ├── index.ts           # ~20 lines - exports only
│   ├── bridge-server.ts   # WebSocket server with log streaming
│   ├── noble-transport.ts # Noble BLE wrapper
│   ├── mock-bluetooth.ts  # navigator.bluetooth mock
│   ├── ws-transport.ts    # WebSocket client
│   ├── utils.ts          # Shared utilities
│   └── start-server.ts   # CLI entry point
├── tests/
│   ├── integration/
│   └── unit/
├── package.json
├── tsconfig.json
└── README.md
```

### Desired Codebase tree with files to be added
```bash
/home/mike/web-ble-bridge/
├── src/
│   ├── mcp-server.ts     # NEW: MCP server implementation (~350 lines)
│   ├── mcp-tools.ts      # NEW: Tool definitions & handlers (~200 lines)
│   ├── log-buffer.ts     # NEW: Circular buffer implementation (~100 lines)
│   └── [existing files]
├── tests/
│   ├── unit/
│   │   └── log-buffer.test.ts    # NEW: Buffer tests
│   └── integration/
│       └── mcp-server.test.ts     # NEW: MCP integration tests
├── docs/
│   ├── MCP-SERVER.md     # NEW: MCP server documentation
│   └── ARCHITECTURE.md   # UPDATE: Add MCP server section
├── CHANGELOG.md          # UPDATE: Version 0.3.0 entry
└── package.json          # UPDATE: Add MCP dependency, version 0.3.0
```

### Known Gotchas & Library Quirks
```typescript
// CRITICAL: Use pnpm exclusively - NEVER npm or npx
// CRITICAL: Node.js 24.x required for BLE compatibility
// CRITICAL: Noble async/await only - no callbacks except event handlers
// CRITICAL: MCP SDK requires Node.js v18.x or higher
// CRITICAL: WebSocket at port 8080 expects URL params for BLE config
// CRITICAL: Log streaming uses command=log-stream query param
// CRITICAL: formatHex from utils.ts for consistent hex display
// CRITICAL: BLE adapter conflicts if scanning while connected
```

## Implementation Blueprint

### Data models and structure

```typescript
// src/log-buffer.ts
interface LogEntry {
  id: number;              // Global sequence number
  timestamp: string;       // ISO timestamp
  direction: 'TX' | 'RX';  // Packet direction
  hex: string;             // Raw hex data (uppercase, space-separated)
  size: number;            // Byte count
}

class LogBuffer {
  private buffer: LogEntry[] = [];
  private maxSize = 10000;
  private sequenceCounter = 0;
  private clientPositions = new Map<string, number>(); // client_id -> last_seen_id
  
  push(direction: 'TX' | 'RX', data: Uint8Array): void
  getLogsSince(since: string | number, limit: number): LogEntry[]
  searchPackets(hexPattern: string, limit: number): LogEntry[]
  getClientPosition(clientId: string): number
  updateClientPosition(clientId: string, lastSeenId: number): void
}

// src/mcp-server.ts
interface ConnectionState {
  connected: boolean;
  deviceName?: string;
  connectedAt?: string;
  lastActivity?: string;
  packetsTransmitted: number;
  packetsReceived: number;
}

// Tool input schemas using Zod
const GetLogsSchema = z.object({
  since: z.string().default('30s'),
  filter: z.string().optional(),
  limit: z.number().min(1).max(1000).default(100)
});
```

### List of tasks to be completed in order

```yaml
Task 1: Create log buffer implementation
CREATE src/log-buffer.ts:
  - Implement circular buffer with 10k limit
  - Global sequence counter
  - Client position tracking Map
  - Time parsing for 'since' parameter (ISO, 'last', duration)
  - Hex pattern search with regex

Task 2: Create MCP tool definitions
CREATE src/mcp-tools.ts:
  - Define Zod schemas for all 5 tools
  - Create tool metadata objects
  - Export tool registration helper

Task 3: Implement MCP server core
CREATE src/mcp-server.ts:
  - Initialize McpServer instance
  - Connect to bridge WebSocket for log streaming
  - Register all 5 tools with handlers
  - Implement client tracking for positions
  - Handle connection state management

Task 4: Add unit tests for log buffer
CREATE tests/unit/log-buffer.test.ts:
  - Test circular buffer rotation
  - Test time parsing ('30s', '5m', 'last', ISO)
  - Test hex pattern search
  - Test client position tracking

Task 5: Add integration tests for MCP server
CREATE tests/integration/mcp-server.test.ts:
  - Test tool registration
  - Test tool calls with mock data
  - Test error handling scenarios
  - Test client position persistence

Task 6: Update package.json and build
MODIFY package.json:
  - Add "@modelcontextprotocol/sdk" dependency
  - Update version to 0.3.0
  - Add mcp:server script

Task 7: Create MCP server documentation
CREATE docs/MCP-SERVER.md:
  - Installation instructions
  - Tool descriptions and examples
  - Claude Code configuration
  - mcp-cli usage examples

Task 8: Update architecture documentation
MODIFY docs/ARCHITECTURE.md:
  - Add MCP Server section
  - Update system diagram
  - Document debugging workflow

Task 9: Update changelog
MODIFY CHANGELOG.md:
  - Add version 0.3.0 section
  - List new MCP server features
  - Document breaking changes (none)
```

### Per task pseudocode

```typescript
// Task 1: Log Buffer Implementation
class LogBuffer {
  private parseSince(since: string, clientId?: string): number {
    // Handle 'last' - return client's last position
    if (since === 'last' && clientId) {
      return this.clientPositions.get(clientId) || 0;
    }
    
    // Handle duration strings: '30s', '5m', '1h'
    const durationMatch = since.match(/^(\d+)([smh])$/);
    if (durationMatch) {
      const [, num, unit] = durationMatch;
      const multipliers = { s: 1000, m: 60000, h: 3600000 };
      const cutoffTime = Date.now() - (parseInt(num) * multipliers[unit]);
      // Find first entry after cutoff
      return this.buffer.findIndex(e => new Date(e.timestamp).getTime() > cutoffTime);
    }
    
    // Handle ISO timestamp
    try {
      const cutoffTime = new Date(since).getTime();
      return this.buffer.findIndex(e => new Date(e.timestamp).getTime() > cutoffTime);
    } catch {
      return 0; // Default to beginning
    }
  }
}

// Task 3: MCP Server WebSocket Connection
class MCPBridgeServer {
  private async connectToBridge() {
    // Connect to log stream endpoint
    this.ws = new WebSocket('ws://localhost:8080?command=log-stream');
    
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      
      // Parse TX/RX from log messages using regex
      const txMatch = msg.message.match(/\[TX\] ([0-9A-F\s]+)/);
      const rxMatch = msg.message.match(/\[RX\] ([0-9A-F\s]+)/);
      
      if (txMatch) {
        this.logBuffer.push('TX', this.hexToBytes(txMatch[1]));
      } else if (rxMatch) {
        this.logBuffer.push('RX', this.hexToBytes(rxMatch[1]));
      }
      
      // Update connection state from messages
      if (msg.message.includes('BLE connected')) {
        this.connectionState.connected = true;
        this.connectionState.connectedAt = msg.timestamp;
      }
    });
  }
  
  private async handleScanDevices() {
    // CRITICAL: Check connection state first
    if (this.connectionState.connected) {
      throw new Error('Cannot scan while connected to a device. Please disconnect first.');
    }
    
    // Perform scan using a separate WebSocket connection
    // Parse discovered devices from log stream
  }
}
```

### Integration Points
```yaml
WEBSOCKET:
  - Connect to: ws://localhost:8080?command=log-stream
  - Parse: [TX] and [RX] log patterns
  - Monitor: Connection state changes
  
PACKAGE.JSON:
  - script: "mcp:server": "node dist/mcp-server.js"
  - bin: "web-ble-bridge-mcp": "./dist/mcp-server.js"
  
MCP_REGISTRATION:
  - Name: "@trakrf/web-ble-bridge"
  - Version: "0.3.0"
  - Tools: 5 (get_logs, search_packets, get_connection_state, status, scan_devices)
```

## Validation Loop

### Level 1: Syntax & Style
```bash
# Run these FIRST - fix any errors before proceeding
pnpm run lint              # ESLint with auto-fix
pnpm run typecheck         # TypeScript type checking

# Expected: No errors. If errors, READ the error and fix.
```

### Level 2: Unit Tests
```typescript
// tests/unit/log-buffer.test.ts
describe('LogBuffer', () => {
  it('should maintain max 10k entries', () => {
    const buffer = new LogBuffer();
    for (let i = 0; i < 11000; i++) {
      buffer.push('TX', new Uint8Array([i & 0xFF]));
    }
    expect(buffer.getLogsSince('0', 20000).length).toBe(10000);
  });
  
  it('should parse duration strings correctly', () => {
    const buffer = new LogBuffer();
    const now = Date.now();
    // Add entries at different times
    // Test '30s', '5m', '1h' parsing
  });
  
  it('should track client positions', () => {
    const buffer = new LogBuffer();
    buffer.updateClientPosition('client1', 100);
    const logs = buffer.getLogsSince('last', 10, 'client1');
    // Verify returns entries after position 100
  });
});
```

```bash
# Run and iterate until passing:
pnpm run test log-buffer.test.ts
```

### Level 3: Integration Test
```bash
# Start the bridge server
pnpm run start

# In another terminal, test MCP server
pnpm run build
node dist/mcp-server.js

# Test with mcp-cli
mcp call get_logs
mcp call search_packets --params '{"hex_pattern":"A7B3"}'
mcp call get_connection_state

# Expected: Valid JSON responses
```

### Level 4: Manual MCP Client Test
```bash
# Test with MCP Tools
mcp shell node dist/mcp-server.js
> get_logs since=1m
> search_packets hex_pattern=0201
> status

# Configure Claude Code settings.json
# Then verify tools appear in Claude Code
```

## Final Validation Checklist
- [ ] All tests pass: `pnpm run test`
- [ ] No linting errors: `pnpm run lint`
- [ ] No type errors: `pnpm run typecheck`
- [ ] Build succeeds: `pnpm run build`
- [ ] MCP tools work with mcp-cli
- [ ] Circular buffer stays at 10k entries
- [ ] Client position tracking works
- [ ] Scan-while-connected returns proper error
- [ ] Version updated to 0.3.0
- [ ] CHANGELOG.md updated
- [ ] Architecture docs updated
- [ ] MCP server documentation complete

---

## Anti-Patterns to Avoid
- ❌ Don't interpret packet data - stay protocol-agnostic
- ❌ Don't persist logs to disk - memory only
- ❌ Don't allow scanning while connected
- ❌ Don't use npm/npx - always use pnpm
- ❌ Don't mix callbacks and promises in Noble
- ❌ Don't hardcode WebSocket URLs - use config
- ❌ Don't exceed 10k log entries
- ❌ Don't forget client position tracking

## Timeline Estimate
- Implementation: 2 hours
- Testing: 1 hour  
- Documentation: 0.5 hours
- Total: ~3.5 hours

## Confidence Score: 9/10
High confidence due to:
- Clear requirements and examples
- Existing WebSocket log streaming
- Well-documented MCP SDK
- Simple in-memory storage pattern
- Reference implementations available