# Web-BLE-Bridge Master Consolidated Specification

## Overview

This master specification consolidates all previous spec iterations into a unified roadmap with clear phases, dependencies, and implementation approaches. The project will deliver BLE debugging and control capabilities through MCP (Model Context Protocol) tools, with optional CLI wrappers for enhanced user experience.

## Core Architecture

### Foundation: MCP Server
- All functionality exposed as MCP tools
- Single implementation serves multiple consumers (Claude Code, CLI clients, custom wrappers)
- In-memory circular buffer for logs (no persistence)
- WebSocket bridge server integration

### Consumer Options
1. **Direct MCP clients**: mcp-cli, mcptools, Claude Code
2. **Custom CLI wrapper**: Go-based native CLI that calls MCP tools
3. **Future integrations**: Any MCP-compatible client

## Implementation Phases

### Phase 1: Critical Debugging Tools (Immediate Priority)

**Goal**: Enable trakrf-handheld debugging of BLE protocol issues

**Timeline**: 2-3 hours

**Dependencies**: 
- @modelcontextprotocol/sdk
- Existing bridge-server.ts and noble-transport.ts

**Tools to implement**:

1. **`get_logs`** - Raw BLE communication log retrieval
   - Circular buffer of recent BLE communications
   - Filter by: TX/RX, hex pattern, time range
   - Returns raw hex data with timestamps and direction
   - No protocol-specific interpretation (future plugin concern)

2. **`search_packets`** - Advanced packet search and correlation
   - Find specific command patterns
   - Correlate TX commands with RX responses
   - Time window analysis
   - Critical for debugging "did the command get sent?" issues

3. **`get_connection_state`** - Detailed connection information
   - Current device connection status
   - Last TX/RX activity with timestamps
   - Packet statistics
   - Recent activity summary

4. **`status`** - Basic server status (low-hanging fruit)
   - Server running state
   - Port, version, uptime
   - Simple connection status

5. **`scan_devices`** - BLE device scanning (low-hanging fruit)
   - Scan for nearby devices
   - Return name, ID, RSSI
   - Reuse existing Noble scan functionality

**Deliverable**: MCP server that can be used with any MCP client for debugging

### Phase 2: CLI Wrapper for Better UX (Optional Enhancement)

**Goal**: Provide native-feeling CLI while leveraging MCP implementation

**Timeline**: 3-4 hours

**Dependencies**: 
- Phase 1 completion
- Go 1.21+ and cobra CLI framework
- MCP Tools (mcp command)

**Implementation**:
- Go-based CLI that wraps MCP tool calls
- Commands: `web-ble-bridge logs`, `status`, `scan`, etc.
- Pretty output formatting
- Cross-platform static binaries
- Distributed via npm package with platform detection

**Benefits**:
- Professional CLI experience
- No Python/npm runtime dependencies
- Fast execution
- Maintains single source of truth (MCP tools)

### Phase 3: Device Control Tools (Future Enhancement)

**Goal**: Full BLE device control through MCP

**Timeline**: 2-3 hours when needed

**Tools to implement**:

1. **`connect`** - Connect to BLE device
   - Device selection by name/UUID
   - Service/characteristic configuration
   - Plugin-based device presets (future)

2. **`disconnect`** - Disconnect from device
   - Clean disconnection
   - State cleanup

3. **`send`** - Send data to device
   - Hex data transmission
   - Optional response waiting
   - Timeout configuration

### Phase 4: Advanced Features (Future Considerations)

**Potential enhancements**:
- Real-time log streaming (when MCP supports server-initiated events)
- Device profiles and saved configurations
- Batch command execution
- Protocol decoders for known device types. Recommend deploying to a separate plugin and/or device registry
- Performance analytics and metrics

## Technical Decisions

### Log Buffer Management
- Circular buffer with 10,000 entry capacity
- Client position tracking for "since last" queries
- Duration parsing ('30s', '5m', '1h')
- Hex pattern filtering
- Sequence numbering for global packet ordering

### MCP Tool Response Format
- Consistent JSON structure across all tools
- Raw hex data with metadata (timestamp, direction, sequence)
- Error messages with actionable suggestions

## Usage Examples

### Phase 1: Debugging with MCP clients
```bash
# Check connection
mcp call status node dist/mcp-server.js

# Find recent packets with hex pattern A7B3
mcp call get_logs --params '{"filter":"A7B3"}' node dist/mcp-server.js

# Search for RX responses within 1 second of TX pattern A7B301
mcp call search_packets --params '{"correlation":{"tx_pattern":"A7B301","window_ms":1000}}' node dist/mcp-server.js
```

### Phase 2: Using CLI wrapper
```bash
# Same functionality, better UX
web-ble-bridge status
web-ble-bridge logs --filter A7B3
web-ble-bridge search --correlate A7B301 --window 1000
```

### Claude Code Integration
```json
{
  "mcpServers": {
    "web-ble-bridge": {
      "command": "node",
      "args": ["./dist/mcp-server.js"],
      "env": {
        "BRIDGE_PORT": "8080",
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

## Success Metrics

### Phase 1
- ✓ trakrf-handheld can debug protocol issues in real-time
- ✓ Can search for specific packet patterns
- ✓ Can correlate commands with responses
- ✓ Works with any MCP client

### Phase 2
- ✓ Native CLI experience without custom implementation
- ✓ Cross-platform distribution
- ✓ Professional feel

### Phase 3+
- ✓ Full device control capabilities
- ✓ Extensible for new tools
- ✓ Zero maintenance of multiple implementations

## Implementation Order

1. **Week 1**: Phase 1 MCP server with debugging tools
2. **Week 2**: Phase 2 CLI wrapper (if desired)
3. **Future**: Phase 3+ as requirements emerge

## Key Benefits

1. **Single Implementation**: MCP tools serve all consumers
2. **Immediate Value**: Phase 1 solves urgent debugging needs
3. **Future Proof**: Easy to add new tools without changing clients
4. **Standard Protocol**: Leverages MCP ecosystem
5. **Flexible Consumption**: Direct MCP, CLI wrapper, or Claude Code

## Migration Path

1. Implement Phase 1 MCP server alongside existing code
2. Test with trakrf-handheld team
3. Add CLI wrapper if better UX needed
4. Deprecate any redundant implementations
5. Extend with new tools as needed

This consolidated specification provides a clear roadmap from immediate debugging needs to full-featured BLE control, all built on a solid MCP foundation.