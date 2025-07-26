## FEATURE: Comprehensive HTTP Endpoint Testing
Add OpenAPI documentation for MCP http endpoint

Add comprehensive test coverage for all HTTP endpoints in the MCP server implementation. Currently, the HTTP endpoints (health check, MCP operations, SSE streaming) have no test coverage, which poses risks for reliability and regression detection.

### Objectives:
- Add Supertest testing library for HTTP endpoint testing
- Create comprehensive test suite for all existing HTTP endpoints
- Ensure authentication, CORS, and error handling work correctly
- Establish patterns for future HTTP endpoint testing

### Endpoints to Test:
1. **GET /health** - Health check endpoint
   - Test successful response format
   - Verify MCP transport status reporting
   - Test with different server configurations

2. **POST /mcp** - Main MCP message handling
   - Test with valid authentication
   - Test without authentication (should fail)
   - Test session creation and management
   - Test request/response handling
   - Test error scenarios

3. **GET /mcp** - SSE streaming endpoint
   - Test SSE connection setup
   - Test session validation
   - Test missing session handling
   - Test streaming functionality

4. **DELETE /mcp** - Session termination
   - Test successful session cleanup
   - Test with invalid session ID
   - Test transport cleanup

### Test Coverage Requirements:
- Authentication scenarios (with/without token, invalid token)
- CORS header validation
- Content-Type headers
- Error response formats
- Edge cases (malformed requests, server not initialized)
- Session lifecycle management

## EXAMPLES:
Reference implementation patterns from:
- Existing integration tests: `tests/integration/mcp-tools.test.ts`
- Express app setup: `src/mcp-http-transport.ts`
- Error handling patterns from existing endpoints

Example test structure:
```typescript
describe('HTTP Endpoints', () => {
  let app: Express;
  let server: BridgeServer;
  
  beforeAll(async () => {
    server = new BridgeServer();
    await server.start(0);
    app = createHttpApp(server.getMcpServer(), 'test-token');
  });
  
  describe('GET /health', () => {
    it('should return server health status', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);
      
      expect(response.body.status).toBe('ok');
      expect(response.body.mcp).toBeDefined();
    });
  });
});
```

## DOCUMENTATION:
- Supertest documentation: https://github.com/ladjs/supertest
- Express testing best practices: https://expressjs.com/en/guide/testing.html
- Vitest documentation: https://vitest.dev/guide/

## OTHER CONSIDERATIONS:
- Should not interfere with existing WebSocket tests
- Tests should be independent and not require external services
- Consider adding GitHub Actions workflow for automated testing
- May uncover bugs in existing untested code - be prepared for fixes
- Consider adding test coverage reporting
- Future consideration: API documentation generation from tests