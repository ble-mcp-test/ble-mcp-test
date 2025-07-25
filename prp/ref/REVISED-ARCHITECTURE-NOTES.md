# Revised Architecture Notes - Addressing Key Concerns

## 1. Device-Specific Logic Should Be External

**Issue**: CS108 packet interpretation doesn't belong in a general-purpose BLE bridge.

**Solution**: Plugin architecture
```typescript
// Core bridge just passes raw hex
interface BLEPacket {
  timestamp: string;
  direction: 'TX' | 'RX';
  hex: string;
  // No interpretation here
}

// Plugin/extension approach
interface PacketInterpreter {
  name: string;
  canInterpret(hex: string): boolean;
  interpret(packet: BLEPacket): string;
}

// Separate CS108 package
// @trakrf/web-ble-bridge-cs108
export class CS108Interpreter implements PacketInterpreter {
  private patterns = {
    'A7B3010018': 'START_INVENTORY',
    'A7B3020018': 'STOP_INVENTORY',
    // etc...
  };
  
  canInterpret(hex: string): boolean {
    return Object.keys(this.patterns).some(p => hex.startsWith(p));
  }
  
  interpret(packet: BLEPacket): string {
    // CS108-specific logic here
  }
}
```

## 2. scan_devices Conflict with Active Connections

**Issue**: BLE scanning while connected can cause:
- Adapter conflicts (many don't support simultaneous operations)
- Connection instability
- Platform-specific issues

**Solutions**:
1. **Refuse scanning while connected** (Safest)
```typescript
async scan_devices(params) {
  if (this.isConnected()) {
    throw new Error("Cannot scan while connected. Disconnect first.");
  }
  // proceed with scan
}
```

2. **Queue operations** (More complex)
```typescript
async scan_devices(params) {
  if (this.isConnected()) {
    // Queue scan after current connection ends
    return { 
      status: "queued",
      message: "Scan will start after current connection ends"
    };
  }
}
```

**Recommendation**: Option 1 (refuse) for Phase 1, document clearly

## 3. Use MCP Tools Instead of Custom Go Wrapper

**Original plan**: Build Go CLI with Cobra
**Better approach**: Use existing MCP Tools

**Benefits**:
- Already exists and maintained
- Standard interface for all MCP servers
- Users can use interactive shell mode
- No custom code to maintain

**Usage**:
```bash
# Instead of custom "web-ble-bridge logs"
mcp call get_logs --params '{"since":"30s"}' node dist/mcp-server.js

# Or interactive mode
mcp shell node dist/mcp-server.js
> get_logs since=30s
> status
```

**Documentation approach**:
- Provide clear examples using MCP Tools
- Create aliases/scripts for common operations
- Focus on MCP server quality, not CLI wrapper

## 4. Protocol Decoders as Extensions

**Core principle**: Bridge should be protocol-agnostic

**Extension Architecture**:
```typescript
// Core MCP server
class WebBleBridgeMCP {
  private interpreters: Map<string, PacketInterpreter> = new Map();
  
  registerInterpreter(interpreter: PacketInterpreter) {
    this.interpreters.set(interpreter.name, interpreter);
  }
  
  // get_logs returns raw data by default
  async get_logs(params) {
    const logs = this.getRawLogs(params);
    
    // Optional: if interpreter specified
    if (params.interpreter) {
      const interpreter = this.interpreters.get(params.interpreter);
      if (interpreter) {
        logs.forEach(log => {
          if (interpreter.canInterpret(log.hex)) {
            log.interpretation = interpreter.interpret(log);
          }
        });
      }
    }
    
    return logs;
  }
}
```

**Device Libraries** (separate packages):
- `@trakrf/web-ble-bridge-cs108`
- `@trakrf/web-ble-bridge-nrf52`
- Community packages for other devices

## 5. MCP Server Discovery

**Registries to submit to**:
1. **Official MCP Registry**: https://github.com/modelcontextprotocol/registry
2. **awesome-mcp-servers** lists:
   - https://github.com/appcypher/awesome-mcp-servers
   - https://github.com/wong2/awesome-mcp-servers
3. **Web directories**: 
   - https://mcp.so/
   - https://mcpservers.org/

**Submission strategy**:
- Start with official registry
- PR to awesome lists after stable release
- Include in npm package description for discoverability

## Revised Phase 1 Scope

**Core MCP Tools** (protocol-agnostic):
1. `get_logs` - Raw hex logs with timestamps
2. `search_packets` - Search by hex patterns only
3. `get_connection_state` - Generic connection info
4. `status` - Server status
5. `scan_devices` - With connection conflict handling

**Removed from core**:
- CS108 command interpretation
- Device-specific presets
- Protocol decoders

**New additions**:
- Plugin registration mechanism (future)
- Clear error when scanning while connected

## Example Usage

```bash
# Install
npm install -g @trakrf/web-ble-bridge

# Start MCP server
web-ble-bridge-mcp

# Use with MCP Tools
mcp call status node dist/mcp-server.js
mcp call get_logs --params '{"filter":"A7B3"}' node dist/mcp-server.js

# With CS108 extension (future)
npm install -g @trakrf/web-ble-bridge-cs108
mcp call get_logs --params '{"interpreter":"cs108"}' node dist/mcp-server.js
```

This approach keeps the core generic while allowing device-specific extensions.