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
Integrate MCP server directly into the bridge server to create a unified, MCP-first architecture:
- Bridge server exposes BOTH WebSocket AND MCP protocols simultaneously
- Shared circular log buffer of last 10,000 TX/RX packets
- 5 debugging tools available via MCP protocol
- Per-client position tracking for "since: last" queries
- Raw hex data without interpretation
- Version bump to 0.3.0 with documentation updates
- Future CLI will be built as MCP client (not part of this phase)

## Why
- **Debugging**: Real-time visibility into BLE communication for trakrf-handheld testing
- **Integration**: Works with any MCP-compatible client (Claude Code, CLI tools)
- **Analysis**: Search and correlate TX/RX packets with hex patterns
- **Observability**: Connection state monitoring without modifying bridge core

## What
The bridge server with integrated MCP protocol support, exposing via MCP:
1. Recent communication logs with filtering (shared buffer)
2. Hex pattern search across packets
3. Connection state and activity monitoring
4. Bridge server status
5. BLE device scanning (with conflict protection)

The same bridge server process handles both WebSocket clients AND MCP clients.

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
│   ├── bridge-server.ts  # MODIFY: Integrate MCP server (~450 lines total)
│   ├── mcp-tools.ts      # NEW: Tool definitions & handlers (~200 lines)
│   ├── log-buffer.ts     # NEW: Circular buffer implementation (~100 lines)
│   ├── start-server.ts   # MODIFY: Add MCP stdio transport
│   └── [existing files]
├── tests/
│   ├── unit/
│   │   └── log-buffer.test.ts    # NEW: Buffer tests
│   └── integration/
│       └── mcp-tools.test.ts      # NEW: MCP tools integration tests
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

Task 3: Integrate MCP into bridge server
MODIFY src/bridge-server.ts:
  - Add logBuffer instance to class
  - Initialize McpServer in constructor
  - Register all 5 MCP tools
  - Update TX/RX logging to use shared buffer
  - Add MCP server start/stop lifecycle

Task 4: Update server startup for MCP
MODIFY src/start-server.ts:
  - Add StdioServerTransport for MCP
  - Handle stdio transport alongside WebSocket
  - Update CLI to support MCP mode

Task 5: Add unit tests for log buffer
CREATE tests/unit/log-buffer.test.ts:
  - Test circular buffer rotation
  - Test time parsing ('30s', '5m', 'last', ISO)
  - Test hex pattern search
  - Test client position tracking

Task 6: Add integration tests for MCP tools
CREATE tests/integration/mcp-tools.test.ts:
  - Test tool registration
  - Test tool calls with mock data
  - Test error handling scenarios
  - Test WebSocket + MCP coexistence

Task 7: Update package.json and build
MODIFY package.json:
  - Add "@modelcontextprotocol/sdk" dependency
  - Update version to 0.3.0
  - Update start script for MCP support

Task 8: Create MCP server documentation
CREATE docs/MCP-SERVER.md:
  - Installation instructions
  - Tool descriptions and examples
  - Claude Code configuration
  - mcp-cli usage examples

Task 9: Update architecture documentation
MODIFY docs/ARCHITECTURE.md:
  - Add MCP Server section
  - Update system diagram
  - Document unified architecture

Task 10: Update changelog
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

// Task 3: Integrate MCP into BridgeServer
class BridgeServer {
  private logBuffer: LogBuffer;
  private mcpServer: McpServer;
  
  constructor(logLevel: LogLevel = 'debug') {
    this.logLevel = logLevel;
    this.logBuffer = new LogBuffer();
    
    // Initialize MCP server
    this.mcpServer = new McpServer({
      name: '@trakrf/web-ble-bridge',
      version: '0.3.0'
    });
    
    // Register all MCP tools
    registerMcpTools(this.mcpServer, this);
  }
  
  // Update existing methods to use shared buffer
  private async handleBleData(direction: 'TX' | 'RX', data: Uint8Array) {
    // Add to shared log buffer
    this.logBuffer.push(direction, data);
    
    // Existing console.log for backward compatibility
    if (this.logLevel === 'debug') {
      console.log(`[${direction}] ${formatHex(data)}`);
    }
  }
  
  // MCP tool handler for scan_devices
  async scanDevices(): Promise<DeviceInfo[]> {
    // CRITICAL: Check connection state first
    if (this.transport?.getState() === 'connected') {
      throw new Error('Cannot scan while connected to a device. Please disconnect first.');
    }
    
    // Use existing transport or create temporary one
    const scanTransport = this.transport || new NobleTransport(this.logLevel);
    const devices = await scanTransport.performQuickScan(5000);
    
    return devices.map(d => ({
      id: d.id,
      name: d.name || 'Unknown',
      rssi: d.rssi
    }));
  }
}
```

### Integration Points
```yaml
BRIDGE_SERVER:
  - Single process serves both protocols
  - WebSocket: ws://localhost:8080 (existing clients)
  - MCP: stdio transport (for MCP clients/CLI)
  - Shared log buffer between both protocols
  
START_SCRIPT:
  - Default: Both WebSocket + MCP stdio
  - --no-mcp flag: WebSocket only (backward compat)
  - Environment: WS_PORT, LOG_LEVEL
  
PACKAGE.JSON:
  - script: "start": "node dist/start-server.js"
  - bin: "web-ble-bridge": "./dist/start-server.js"
  
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
# Build the project
pnpm run build

# Start the unified server (WebSocket + MCP)
pnpm run start

# In another terminal, test MCP tools
mcp call get_logs node dist/start-server.js
mcp call search_packets --params '{"hex_pattern":"A7B3"}' node dist/start-server.js
mcp call get_connection_state node dist/start-server.js

# Or use interactive shell
mcp shell node dist/start-server.js
> get_logs since=1m
> status

# Expected: Valid JSON responses
```

### Level 4: Manual MCP Client Test
```bash
# Configure Claude Code settings.json
{
  "mcpServers": {
    "web-ble-bridge": {
      "command": "node",
      "args": ["/path/to/dist/start-server.js"],
      "env": {
        "WS_PORT": "8080",
        "LOG_LEVEL": "debug"
      }
    }
  }
}

# Then verify tools appear in Claude Code
# Tools should be available for debugging BLE communication
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