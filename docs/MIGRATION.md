# Migration Guide: v0.3.x to v0.4.0

## Overview

Version 0.4.0 is a complete architectural rewrite focused on extreme simplification. The core bridge is now under 300 lines of code, down from over 3000 lines.

**⚠️ BREAKING CHANGES**: This version has NO backward compatibility with v0.3.x.

## Key Changes

### 1. Atomic State Machine

**v0.3.x**: Multiple boolean flags and complex state tracking
```javascript
// Old approach - race condition prone
if (!isConnecting && !isConnected && !isDisconnecting) {
  // Accept connection
}
```

**v0.4.0**: Single atomic state
```javascript
// New approach - one state to rule them all
type BridgeState = 'ready' | 'connecting' | 'active' | 'disconnecting';

// Only 'ready' state accepts new connections
if (this.state !== 'ready') {
  ws.send(JSON.stringify({ type: 'error', error: `Bridge is ${this.state}` }));
  ws.close();
  return;
}
```

### 2. One Connection Policy

**v0.3.x**: Complex connection management with tokens and session tracking

**v0.4.0**: First connection wins, others are rejected
- When multiple connections arrive, the first one transitions the state from 'ready' to 'connecting'
- All subsequent connections are immediately rejected
- No tokens, no session management, no complexity

### 3. Service Architecture

**v0.3.x**: Monolithic server with mixed concerns
```javascript
const server = new BleServer({
  enableMcp: true,
  enableHealthCheck: true,
  // ... many options
});
```

**v0.4.0**: Clean separation of concerns
```javascript
// Bridge server - pure WebSocket-to-BLE tunneling
const bridge = new BridgeServer();
await bridge.start(8080);

// Observability server - MCP tools and health checks  
const observability = new ObservabilityServer(sharedState);
observability.connectToBridge(bridge);
```

### 4. WebSocket Protocol Changes

**v0.3.x**: Complex protocol with many message types

**v0.4.0**: Minimal protocol
- Connection: `ws://host:8080?device=NAME&service=UUID&write=UUID&notify=UUID`
- Messages: `connected`, `data`, `disconnected`, `error`
- Health check: HTTP endpoint at `http://host:8081/health`
- Log streaming: Use MCP tools (get_logs, search_packets)

### 5. Configuration Changes

**v0.3.x**: Many configuration options
```javascript
const server = new BleServer({
  logLevel: 'debug',
  scanTimeout: 30000,
  idleTimeout: 60000,
  enableReconnect: true,
  // ... dozens more
});
```

**v0.4.0**: Minimal configuration
```javascript
const bridge = new BridgeServer(); // That's it!

// Only one env var for hardware recovery:
// BLE_MCP_RECOVERY_DELAY=5000 (milliseconds)
```

### 6. Removed Features

The following features were removed to achieve simplicity:

- ❌ Device discovery/scanning endpoint
- ❌ Reconnection logic
- ❌ Connection tokens
- ❌ Session management
- ❌ Complex state machines
- ❌ Idle timeouts
- ❌ Manual connect/disconnect commands
- ❌ Multiple concurrent connections
- ❌ Connection queueing

## Migration Steps

### 1. Update Dependencies

```bash
pnpm add ble-mcp-test@^0.4.0
```

### 2. Update Server Code

**Before (v0.3.x):**
```javascript
import { BleServer } from 'ble-mcp-test';

const server = new BleServer({
  port: 8080,
  logLevel: 'info',
  enableMcp: true
});

await server.start();
```

**After (v0.4.0):**
```javascript
import { BridgeServer, ObservabilityServer, SharedState } from 'ble-mcp-test';

// Shared state for logging
const sharedState = new SharedState();

// Start bridge server
const bridge = new BridgeServer('info', sharedState);
await bridge.start(8080);

// Optional: Add observability
const observability = new ObservabilityServer(sharedState);
observability.connectToBridge(bridge);
```

### 3. Update Client Code

The client WebSocket connection URL format remains the same, but the behavior changes:

**Connection Behavior:**
- Only one active connection allowed
- Immediate rejection if bridge is not in 'ready' state
- No reconnection - client must implement retry logic if needed

**Error Handling:**
```javascript
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'error') {
    if (msg.error.includes('only ready state accepts connections')) {
      // Bridge is busy, retry later
      setTimeout(() => reconnect(), 5000);
    }
  }
});
```

### 4. Update Tests

Test expectations need updating for the new atomic state behavior:

```javascript
// Old test - checking multiple states
expect(server.isConnected).toBe(false);
expect(server.isConnecting).toBe(false);

// New test - checking single state
const health = await getHealthCheck();
expect(health.free).toBe(true); // free = (state === 'ready')
```

## Benefits of v0.4.0

1. **Simplicity**: Core bridge under 300 lines
2. **Reliability**: Atomic state prevents race conditions  
3. **Performance**: Less code = faster execution
4. **Maintainability**: Clear separation of concerns
5. **Debuggability**: Simple state transitions with clear logging

## Need Help?

If you encounter issues during migration:

1. Check the [examples](../examples/) directory for v0.4.0 usage patterns
2. Review the [test files](../tests/integration/) for expected behavior
3. Open an issue on GitHub with your specific use case

Remember: v0.4.0 is about doing one thing well - tunneling BLE bytes over WebSocket. If you need complex features, consider staying on v0.3.x or implementing them in your application layer.