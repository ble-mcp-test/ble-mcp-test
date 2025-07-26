## FEATURE:
### Update package version to 0.3.1 (do this first)
- Update version in package.json from "0.3.0" to "0.3.1"
- This ensures tests can verify dynamic version loading (not hardcoded values)

### Create a shared utility function to dynamically read package metadata from package.json at runtime
- Create a single `getPackageMetadata()` function that returns name, version, and description
- Replace all hardcoded version strings ('0.3.0') with dynamic values from this function
- Replace all hardcoded description strings with dynamic values from this function
- Locations that need updating:
    - `BridgeServer` constructor (src/bridge-server.ts:32)
    - MCP status tool response (src/mcp-tools.ts:161)
    - New `/mcp/register` and `/mcp/info` endpoints
- Cache the metadata since these values never change during application lifecycle

### TOOL REGISTRY:
Since the MCP SDK doesn't expose registered tools publicly, maintain a parallel registry:
- Create `const toolRegistry: Array<{name: string, description: string}> = [];` at the top of `mcp-tools.ts`
- After each `server.registerTool()`, add: `toolRegistry.push({name, description: title});` // Use the title field for concise descriptions
- Export `toolRegistry` for use in the `/mcp/info` endpoint

### Add MCP Dynamic Registration endpoints to the current MCP implementation to resolve claude code 404 errors
- add missing standard mcp endpoint GET `/mcp/info` to existing MCP http service.
  - See example response in the Examples section
  - Endpoint must return a server information block 
  - Endpoint must return a dynamically generated list of available tools using the `title` field (not `description`) for concise tool descriptions
  - Add a tool registry object to the server that is built at tool registration time see implementation example below
  - Endpoint should allow caching
    - res.set('Cache-Control', 'public, max-age=3600'); // /mcp/info - cache 1 hour 
  - Endpoint must not require authentication
- add missing standard mcp endpoint POST `/mcp/register` to existing MCP http service. 
  - See example response in the Examples section
  - Endpoint should NOT allow caching 
    - res.set('Cache-Control', 'no-cache, no-store'); // /mcp/register - never cache
  - Endpoint should require authentication
  - Fully implementing authentication, authorization, and session tracking are out of scope for this release
  - Endpoint should just return a static capabilities response. No session or client ID details are needed at this time 
- 
- Endpoints must retrieve package metadata from getPackageMetadata function that is being added in this feature cycle
- Endpoints should implement the same CORS settings as the top level `/mcp` endpoint
- Endpoints must Return Content-Type: application/json
- Endpoints do not need to worry about sessions or SSE
- ERROR HANDLING:
  - Use the same error response format as existing MCP endpoints in `mcp-http-transport.ts`
  - 401: `{ "error": "Unauthorized" }`
  - 404: `{ "error": "Resource not found" }`
  - 500: `{ "error": "Internal server error", "message": "error details" }`
- Add new endpoints in `createHttpApp()` function in `src/mcp-http-transport.ts`
- Place them AFTER the authentication middleware definition but BEFORE existing MCP endpoints
- Import `getPackageMetadata` directly in `mcp-http-transport.ts`

### ENDPOINT IMPLEMENTATION ORDER:
1. Import getPackageMetadata utility
2. Add `/mcp/info` endpoint (no auth)
3. Add `/mcp/register` endpoint (with auth)
4. Existing `/mcp` endpoints follow

### VALIDATION:
- Endpoints should verify MCP server is initialized before accessing toolRegistry
- Return 500 error if server initialization failed

### TESTING:
- Update existing integration tests to cover new endpoints
- Test auth requirements and error cases



## EXAMPLES:
### dynamic package metadata approach:
```typescript
// src/utils.ts - add this function
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

Error reported by claude code from the /mcp slash command service details
```
│ Ble-mcp-test MCP Server                                                                                              │
│                                                                                                                      │
│ Status: ✘ failed                                                                                                     │
│ URL: http://cheetah.local:8081/mcp                                                                                   │
│ Config location: /home/mike/.claude.json [project: /home/mike/trakrf-handheld]                                       │
│                                                                                                                      │
│ Error: Dynamic client registration failed: HTTP 404
```

Tool registry implementation example. If no tools registered: Return empty tools array
```typescript
const toolRegistry: Array<{name: string, description: string}> = [];

// In registerMcpTools, after each server.registerTool:
toolRegistry.push({ name: 'get_logs', description: 'Get BLE Communication Logs' }); // Use title, not description
```

sample response from `/mcp/info`
```
{
  "name": "ble-mcp-test",
  "version": "0.3.1",
  "description": "BLE testing bridge with MCP support",
  "tools": [
    {
      "name": "status",
      "description": "Get bridge server status"
    },
    {
      "name": "get_connection_state",
      "description": "Get current BLE connection state"
    },
    {
      "name": "scan_devices",
      "description": "Scan for available BLE devices"
    },
    {
      "name": "get_logs",
      "description": "Get recent BLE communication logs"
    },
    {
      "name": "search_packets",
      "description": "Search for hex patterns in packets"
    }
  ]
}
```

sample response from `/mcp/register`
```
{
  "name": "ble-mcp-test",
  "version": "0.3.1",
  "capabilities": {
    "tools": true,
    "resources": false,
    "prompts": false
  }
}
```

## DOCUMENTATION:
Notes from claude code conversation:
1. Discovery Phase: The /mcp/info endpoint is used for initial discovery before authentication.
   It allows clients to see what tools and capabilities are available.
2. Registration Phase: The /mcp/register endpoint requires authentication, ensuring only
   authorized clients can register to use the service.
3. MCP Design Pattern:
    - /mcp/info - Public metadata about the server (no auth)
    - /mcp/register - Registration endpoint (auth required)
    - /mcp - Authenticated SSE endpoint for tool calls (auth required)

This makes the security model consistent: discovery is open, but any actual interaction requires authentication.

Recommended implementation:
```javascript
// Public - no auth
app.get('/mcp/info', (req, res) => {
  const metadata = getPackageMetadata();
  res.json({
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    tools: toolRegistry  // From exported toolRegistry
  });
});

// Same auth as /mcp
app.post('/mcp/register', authenticate, (req, res) => {
  const metadata = getPackageMetadata();
  res.json({
    name: metadata.name,
    version: metadata.version,
    capabilities: {
      tools: true,
      resources: false,
      prompts: false
    }
  });
});

// Same auth requirement
app.get('/mcp', authenticate, (req, res) => {
// SSE connection
});
```

This matches how Claude Code expects to interact with MCP servers during the discovery phase.

## IMPLEMENTATION NOTES:
- Set explicit Content-Type and Cache-Control headers on responses:
  ```javascript
  // For /mcp/info
  res.set('Content-Type', 'application/json');
  res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
  
  // For /mcp/register
  res.set('Content-Type', 'application/json');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  ```
- Validate MCP server is initialized before accessing toolRegistry:
  ```javascript
  if (!server || !toolRegistry) {
    return res.status(500).json({ 
      error: 'Internal server error', 
      message: 'MCP server not initialized' 
    });
  }
  ```
- Import toolRegistry from mcp-tools.ts: `import { toolRegistry } from './mcp-tools.js';`

## TEST REQUIREMENTS:
- Add integration tests for new endpoints in `tests/integration/mcp-endpoints.test.ts`
- Test cases should cover:
  1. GET /mcp/info returns correct metadata and tool list (no auth)
  2. GET /mcp/info returns proper cache headers
  3. POST /mcp/register requires authentication (401 without token)
  4. POST /mcp/register returns capabilities with valid auth
  5. POST /mcp/register returns no-cache headers
  6. Both endpoints return 500 if server not initialized
  7. Tool registry updates correctly when tools are registered
- Update existing MCP tests to use dynamic version from getPackageMetadata()