# Specification: Extract MCP Tools to Separate Package

## FEATURE:
Extract the Model Context Protocol (MCP) observability tools into a separate npm package to reduce the core bridge complexity and allow the MCP tools to be reused by other BLE projects.

Current implementation embeds 358 lines of MCP tools directly in the bridge, adding complexity to what should be a focused BLE tunneling solution.

**Current Operational Pain Point**: Because MCP tools are embedded in the bridge service, every bridge restart (common during development and debugging) breaks the Claude Code MCP connection, requiring manual `/mcp reconnect ble-mcp-test` commands. This disrupts development workflow.

## EXAMPLES:
Current architecture:
```
ble-mcp-test/
├── src/
│   ├── bridge-server.ts      # Core bridge
│   ├── mcp-tools.ts         # 358 lines - should be separate
│   ├── observability-server.ts # MCP integration
│   └── ...
```

Desired architecture:
```
ble-mcp-test/                 # Core bridge package
├── src/
│   ├── bridge-server.ts     # Core bridge only
│   └── ...

@ble-mcp-test/mcp-tools/     # Separate MCP package
├── src/
│   ├── tools.ts            # MCP tool implementations
│   ├── server.ts           # MCP server setup
│   └── ...
```

## DOCUMENTATION:
- MCP specification: https://modelcontextprotocol.io/
- Package splitting best practices: https://docs.npmjs.com/cli/v9/using-npm/workspaces
- Monorepo setup with pnpm: https://pnpm.io/workspaces
- MCP SDK documentation: https://github.com/modelcontextprotocol/typescript-sdk

## OTHER CONSIDERATIONS:

**Package Structure Options**:
1. **Separate Repository**: Completely separate npm package with own repo
2. **Workspace Package**: Monorepo workspace with multiple packages
3. **Plugin Architecture**: Optional dependency with plugin loading

**Scope and Benefits**:
- Reduces core package complexity by ~600 lines (MCP tools + observability server)
- Allows other BLE projects to use the same MCP debugging tools
- Cleaner separation of concerns (bridge vs observability)
- Independent versioning for MCP features
- **Critical operational benefit**: MCP connection stays alive when bridge service restarts
- Eliminates need to run `/mcp reconnect ble-mcp-test` after every bridge restart

**Technical Challenges**:
- Shared state management between packages
- Bridge server integration points
- Configuration and environment variable handling
- Build and deployment pipeline updates

**Migration Strategy**:
1. **Create workspace structure** with pnpm workspaces
2. **Extract MCP code** to new package while maintaining APIs
3. **Update build system** for multi-package builds
4. **Maintain backward compatibility** for existing users
5. **Test integration** extensively

**API Design Considerations**:
```typescript
// Core bridge package
import { createMcpIntegration } from '@ble-mcp-test/mcp-tools';

const bridge = new BridgeServer();
const mcpIntegration = createMcpIntegration(bridge);
```

**Validation Requirements**:
- All existing MCP functionality must work unchanged
- Core bridge package size significantly reduced
- Independent deployment of MCP tools possible
- No breaking changes for existing users
- Both packages can be used independently

**Files to Extract**:
- `src/mcp-tools.ts` (358 lines)
- `src/observability-server.ts` (189 lines) 
- `src/mcp-http-transport.ts` (276 lines)
- Related test files and documentation

**Future Benefits**:
- Other BLE libraries can adopt same debugging tools
- MCP tools can evolve independently
- Core bridge remains focused on tunneling
- Easier contribution to MCP ecosystem
- **Developer workflow improvement**: No more MCP reconnections during active development
- **Service reliability**: Bridge restarts don't disrupt Claude Code debugging sessions