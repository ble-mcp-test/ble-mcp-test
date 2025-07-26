# PRP: MCP Dynamic Registration Endpoints

## Context

Claude Code expects specific dynamic registration endpoints (`/mcp/info` and `/mcp/register`) that are not part of the standard MCP specification. These endpoints enable Claude Code to discover server capabilities and register with MCP servers dynamically, avoiding the HTTP 404 error currently encountered.

## Success Criteria

- Claude Code can successfully discover and register with the MCP server
- No more "Dynamic client registration failed: HTTP 404" errors
- All existing functionality continues to work
- Package metadata is dynamically loaded from package.json
- Tool list is dynamically generated from registered tools

## Critical Context

### Existing Patterns to Follow

1. **Express App Pattern** (src/mcp-http-transport.ts):
   - Middleware setup: express.json(), CORS configuration
   - Authentication middleware pattern at line 27
   - Error response format: `{ error: string, message?: string }`
   - Endpoint structure: authenticate middleware, async handler, try/catch

2. **Tool Registration Pattern** (src/mcp-tools.ts):
   - Tools registered with: name, title, description, inputSchema
   - Private _registeredTools in McpServer (not publicly accessible)
   - Need parallel registry for dynamic tool listing

3. **Test Pattern** (tests/integration/mcp-tools.test.ts):
   - Setup BridgeServer and get McpServer instance
   - Access private properties with type assertion: `(mcpServer as any)._registeredTools`
   - Test both success and error cases
   - Verify response structure and content

### External Documentation

- MCP SDK npm: https://www.npmjs.com/package/@modelcontextprotocol/sdk
- MCP Introduction: https://modelcontextprotocol.io/introduction
- How to MCP Guide: https://simplescraper.io/blog/how-to-mcp
- Note: /mcp/info and /mcp/register are Claude Code specific, not standard MCP

### Known Gotchas

1. **Private Tool Registry**: McpServer._registeredTools is private - must maintain parallel registry
2. **Import Paths**: Use .js extensions in TypeScript imports for ES modules
3. **Cache Headers**: Must be explicit - browsers/proxies may cache incorrectly otherwise
4. **Version Hardcoding**: Currently hardcoded in multiple places - easy to miss updates
5. **Test Environment**: BLE functionality may fail in tests - handle gracefully

## Implementation Blueprint

### Pseudocode Overview

```
1. Update package.json version → 0.3.1
2. Create getPackageMetadata() utility:
   - Read package.json using import.meta.url
   - Cache result for performance
   - Return { name, version, description }
3. Update existing version references:
   - BridgeServer constructor
   - MCP status tool
4. Create tool registry:
   - Export array from mcp-tools.ts
   - Push tool info after each registerTool()
5. Add new endpoints:
   - GET /mcp/info (no auth, cacheable)
   - POST /mcp/register (auth required, no cache)
6. Write comprehensive tests
```

### Detailed Implementation Tasks

#### Task 1: Update Package Version
**File**: package.json (line 3)
```json
"version": "0.3.1",
```

#### Task 2: Create Package Metadata Utility
**File**: src/utils.ts (add at end)
```typescript
import { readFileSync } from 'fs';

let cachedMetadata: { name: string; version: string; description: string } | null = null;

export function getPackageMetadata(): { name: string; version: string; description: string } {
  if (!cachedMetadata) {
    const packageJsonPath = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    cachedMetadata = {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description
    };
  }
  return cachedMetadata;
}
```

#### Task 3: Update Hardcoded Versions
**File**: src/bridge-server.ts (line 32)
```typescript
import { getPackageMetadata } from './utils.js';

// In constructor:
const metadata = getPackageMetadata();
this.mcpServer = new McpServer({
  name: metadata.name,
  version: metadata.version
});
```

**File**: src/mcp-tools.ts (line 162)
```typescript
import { getPackageMetadata } from '../utils.js';

// In status tool:
const metadata = getPackageMetadata();
const status: ServerStatus = {
  version: metadata.version,
  // ... rest of status
};
```

#### Task 4: Create Tool Registry
**File**: src/mcp-tools.ts (add at top after imports)
```typescript
// Tool registry for dynamic tool listing
export const toolRegistry: Array<{name: string, description: string}> = [];
```

**File**: src/mcp-tools.ts (after each registerTool call)
```typescript
// After tool 1: get_logs (line ~89)
toolRegistry.push({ 
  name: 'get_logs', 
  description: 'Get BLE Communication Logs' 
});

// After tool 2: search_packets (line ~119)
toolRegistry.push({ 
  name: 'search_packets', 
  description: 'Search BLE Packets' 
});

// After tool 3: get_connection_state (line ~145)
toolRegistry.push({ 
  name: 'get_connection_state', 
  description: 'Get Connection State' 
});

// After tool 4: status (line ~182)
toolRegistry.push({ 
  name: 'status', 
  description: 'Get Bridge Server Status' 
});

// After tool 5: scan_devices (line ~221)
toolRegistry.push({ 
  name: 'scan_devices', 
  description: 'Scan for BLE Devices' 
});
```

#### Task 5: Add New Endpoints
**File**: src/mcp-http-transport.ts (add imports at top)
```typescript
import { getPackageMetadata } from './utils.js';
import { toolRegistry } from './mcp-tools.js';
```

**File**: src/mcp-http-transport.ts (add after authenticate middleware, before POST /mcp)
```typescript
// MCP INFO endpoint - public discovery
app.get('/mcp/info', (req, res) => {
  try {
    // Validate server is initialized
    if (!server || !toolRegistry) {
      return res.status(500).json({ 
        error: 'Internal server error', 
        message: 'MCP server not initialized' 
      });
    }

    const metadata = getPackageMetadata();
    
    // Set headers
    res.set('Content-Type', 'application/json');
    res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    
    res.json({
      name: metadata.name,
      version: metadata.version,
      description: metadata.description,
      tools: toolRegistry
    });
  } catch (error: any) {
    logger.error('Error in /mcp/info:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message 
    });
  }
});

// MCP REGISTER endpoint - requires auth
app.post('/mcp/register', authenticate, (req, res) => {
  try {
    // Validate server is initialized
    if (!server) {
      return res.status(500).json({ 
        error: 'Internal server error', 
        message: 'MCP server not initialized' 
      });
    }

    const metadata = getPackageMetadata();
    
    // Set headers
    res.set('Content-Type', 'application/json');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    res.json({
      name: metadata.name,
      version: metadata.version,
      capabilities: {
        tools: true,
        resources: false,
        prompts: false
      }
    });
  } catch (error: any) {
    logger.error('Error in /mcp/register:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message 
    });
  }
});
```

#### Task 6: Add Integration Tests
**File**: tests/integration/mcp-endpoints.test.ts (new file)
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Express } from 'express';
import { BridgeServer } from '../../src/bridge-server.js';
import { createHttpApp } from '../../src/mcp-http-transport.js';
import { getPackageMetadata } from '../../src/utils.js';

describe('MCP Dynamic Registration Endpoints', () => {
  let server: BridgeServer;
  let app: Express;
  const testToken = 'test-token-123';
  
  beforeAll(async () => {
    server = new BridgeServer('info');
    await server.start(0);
    app = createHttpApp(server.getMcpServer(), testToken);
  });
  
  afterAll(async () => {
    await server.stop();
  });
  
  describe('GET /mcp/info', () => {
    it('should return server metadata and tool list without auth', async () => {
      const response = await request(app)
        .get('/mcp/info')
        .expect(200)
        .expect('Content-Type', /application\/json/);
      
      const metadata = getPackageMetadata();
      expect(response.body).toEqual({
        name: metadata.name,
        version: metadata.version,
        description: metadata.description,
        tools: expect.arrayContaining([
          { name: 'status', description: 'Get Bridge Server Status' },
          { name: 'get_connection_state', description: 'Get Connection State' },
          { name: 'scan_devices', description: 'Scan for BLE Devices' },
          { name: 'get_logs', description: 'Get BLE Communication Logs' },
          { name: 'search_packets', description: 'Search BLE Packets' }
        ])
      });
    });
    
    it('should return proper cache headers', async () => {
      const response = await request(app)
        .get('/mcp/info')
        .expect(200);
      
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
    });
  });
  
  describe('POST /mcp/register', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .post('/mcp/register')
        .expect(401);
      
      expect(response.body).toEqual({ error: 'Unauthorized' });
    });
    
    it('should return capabilities with valid auth', async () => {
      const response = await request(app)
        .post('/mcp/register')
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200)
        .expect('Content-Type', /application\/json/);
      
      const metadata = getPackageMetadata();
      expect(response.body).toEqual({
        name: metadata.name,
        version: metadata.version,
        capabilities: {
          tools: true,
          resources: false,
          prompts: false
        }
      });
    });
    
    it('should return no-cache headers', async () => {
      const response = await request(app)
        .post('/mcp/register')
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);
      
      expect(response.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    });
  });
  
  describe('Error handling', () => {
    it('should handle server initialization errors gracefully', async () => {
      // Create app without initialized server
      const emptyApp = createHttpApp(null as any);
      
      const infoResponse = await request(emptyApp)
        .get('/mcp/info')
        .expect(500);
      
      expect(infoResponse.body.error).toBe('Internal server error');
      expect(infoResponse.body.message).toContain('not initialized');
      
      const registerResponse = await request(emptyApp)
        .post('/mcp/register')
        .set('Authorization', `Bearer ${testToken}`)
        .expect(500);
      
      expect(registerResponse.body.error).toBe('Internal server error');
      expect(registerResponse.body.message).toContain('not initialized');
    });
  });
  
  describe('Dynamic version verification', () => {
    it('should use dynamic version from package.json', async () => {
      const response = await request(app)
        .get('/mcp/info')
        .expect(200);
      
      // Should be 0.3.1 after update, not hardcoded 0.3.0
      expect(response.body.version).toBe('0.3.1');
    });
  });
});
```

**File**: package.json (add supertest to devDependencies if not present)
```json
"@types/supertest": "^6.0.2",
"supertest": "^6.3.4"
```

### Validation Gates

```bash
# Level 1: Syntax & Type Checking
pnpm run lint
pnpm run typecheck

# Expected: No errors. Fix any issues before proceeding.

# Level 2: Unit/Integration Tests
pnpm run test:integration

# Expected: All tests passing, including new mcp-endpoints.test.ts

# Level 3: Build Verification
pnpm run build

# Expected: Successful build with no errors

# Level 4: Manual Testing
# Start server with auth
MCP_TOKEN=test-token pnpm run start:http

# Test endpoints
curl http://localhost:8081/mcp/info
# Expected: JSON with server info and tools

curl -X POST http://localhost:8081/mcp/register
# Expected: 401 Unauthorized

curl -X POST http://localhost:8081/mcp/register \
  -H "Authorization: Bearer test-token"
# Expected: JSON with capabilities

# Level 5: Claude Code Integration
# Update .claude.json with MCP server URL and test /mcp command
```

### Error Handling Strategy

1. **Server not initialized**: Return 500 with descriptive message
2. **Package.json read failure**: Caught by try/catch, return 500
3. **Missing auth token**: Return 401 (existing middleware)
4. **Invalid requests**: Express handles with 400
5. **Unexpected errors**: Logged and return 500 with message

## Task Summary (Implementation Order)

1. ✅ Update package.json version to 0.3.1
2. ✅ Add getPackageMetadata() to src/utils.ts
3. ✅ Update BridgeServer constructor to use dynamic version
4. ✅ Update MCP status tool to use dynamic version
5. ✅ Add toolRegistry export to src/mcp-tools.ts
6. ✅ Push tool info to registry after each registerTool()
7. ✅ Import dependencies in src/mcp-http-transport.ts
8. ✅ Add GET /mcp/info endpoint
9. ✅ Add POST /mcp/register endpoint
10. ✅ Create tests/integration/mcp-endpoints.test.ts
11. ✅ Run validation gates
12. ✅ Test with Claude Code

## Quality Score: 9/10

High confidence for one-pass implementation because:
- All patterns are from existing codebase
- Clear error handling strategy
- Comprehensive tests included
- Step-by-step implementation order
- Validation gates at each level

The only uncertainty (-1 point) is the exact Claude Code integration behavior, which requires live testing.