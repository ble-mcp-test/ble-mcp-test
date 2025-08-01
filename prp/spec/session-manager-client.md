# Client-Side Session Manager Support

## **Problem Statement**

The server-side session manager architecture has been successfully implemented, but client-side code still lacks session awareness. Current client implementations:

- Generate new connections without session persistence
- Cannot reconnect to existing BLE sessions
- Miss opportunities for session sharing across multiple WebSocket connections
- Lack examples demonstrating session management benefits

This prevents users from leveraging the full power of the new session architecture.

## **Solution: Add Session Support to Client Libraries**

Update client-side code to support session UUIDs, enabling session persistence, reconnection, and multi-connection scenarios.

## **Architecture Overview**

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Client App     │───▶│ WebSocketTransport│───▶│  BridgeServer   │
│  (User Code)    │    │ (Enhanced w/     │    │ (Session-aware) │
│                 │    │  Session Support)│    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ Session Config  │    │ URL Parameters  │    │ SessionManager  │
│ - sessionId     │    │ ?session=uuid   │    │ (Server-side)   │
│ - persistence   │    │ ?device=...     │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## **Component Specifications**

### **1. Enhanced WebSocketTransport**
**File:** `src/ws-transport.ts` (update existing)

**New Interface:**
```typescript
interface ConnectionOptions {
  device?: string;
  service?: string;
  write?: string;
  notify?: string;
  session?: string;        // NEW: Session ID for persistence
  generateSession?: boolean; // NEW: Auto-generate session ID
}

class WebSocketTransport {
  private sessionId?: string;
  
  connect(options?: ConnectionOptions): Promise<void>
  getSessionId(): string | undefined
  reconnectToSession(sessionId: string): Promise<void>
}
```

**Enhanced Behavior:**
- Accept `session` parameter in connect options
- Auto-generate session IDs when `generateSession: true`
- Store session ID for reconnection scenarios
- Add URL parameter `?session=uuid` to WebSocket connection

### **2. Updated Connection Examples**
**Files:** Update existing examples and create new ones

**Examples to Update:**
- `test-single-connection.js` - Add session persistence demo
- `examples/force-cleanup-example.js` - Session-aware cleanup
- `examples/force-cleanup-simple.html` - Web session management

**New Example:** `examples/session-persistence-demo.js`
- Demonstrate connection → disconnect → reconnect to same session
- Show multiple WebSocket connections to same session
- Illustrate session cleanup and management

### **3. Enhanced Mock Bluetooth Support**
**File:** `src/mock-bluetooth.ts` (update existing)

**Updates Needed:**
```typescript
class MockBluetooth {
  constructor(
    wsUrl: string, 
    options?: { 
      sessionId?: string,
      autoGenerateSession?: boolean 
    }
  )
}

// Update injection function
function injectWebBluetoothMock(
  wsUrl: string, 
  options?: { 
    sessionId?: string,
    mockDevices?: any[] 
  }
): void
```

**Enhanced Behavior:**
- Support session IDs in constructor
- Pass session parameter to WebSocket URL
- Enable session persistence for web applications

## **Implementation Examples**

### **Basic Session Usage**
```javascript
// Auto-generate session for persistence
const transport = new WebSocketTransport();
await transport.connect({
  device: 'CS108',
  service: '9800',
  write: '9900', 
  notify: '9901',
  generateSession: true  // Auto-generate session ID
});

console.log('Session ID:', transport.getSessionId());
// Later: reconnect to same session
await transport.reconnectToSession(transport.getSessionId());
```

### **Explicit Session Management**
```javascript
// Use specific session ID
const sessionId = 'my-persistent-session-' + Date.now();
const transport = new WebSocketTransport();
await transport.connect({
  device: 'CS108',
  service: '9800',
  write: '9900',
  notify: '9901', 
  session: sessionId
});

// Multiple connections to same session
const transport2 = new WebSocketTransport();
await transport2.connect({
  device: 'CS108',
  service: '9800', 
  write: '9900',
  notify: '9901',
  session: sessionId  // Reuse same session
});
```

### **Web Application Example**
```html
<script>
// Session-aware web application
const sessionId = localStorage.getItem('bleSessionId') || 
                 'web-session-' + Date.now();
localStorage.setItem('bleSessionId', sessionId);

WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
  sessionId: sessionId
});

// Now navigator.bluetooth uses persistent session
const device = await navigator.bluetooth.requestDevice({
  filters: [{ name: 'CS108' }]
});
</script>
```

## **URL Parameter Format**

### **Current (Backward Compatible):**
```
ws://localhost:8080?device=CS108&service=9800&write=9900&notify=9901
```

### **Enhanced with Session:**
```
ws://localhost:8080?device=CS108&service=9800&write=9900&notify=9901&session=my-session-id
```

### **Session Generation:**
```javascript
// Client generates UUID for session persistence
const sessionId = 'cs108-session-' + crypto.randomUUID();
const url = `ws://localhost:8080?device=CS108&service=9800&write=9900&notify=9901&session=${sessionId}`;
```

## **Benefits Delivered**

### **Session Persistence:**
- WebSocket disconnects don't kill BLE connections
- Clients can reconnect to existing sessions
- Graceful handling of network interruptions

### **Multi-Connection Support:**
- Multiple WebSocket connections can share same BLE session
- Useful for applications with multiple components needing BLE access
- Load balancing across connections

### **Enhanced Developer Experience:**
- Simple API: just add `session` parameter
- Backward compatibility: existing code works unchanged
- Clear examples showing session management patterns

### **Production-Ready Features:**
- Session timeout configuration
- Automatic cleanup of expired sessions
- Robust error handling and recovery

## **Migration Strategy**

### **Phase 1: Core Transport Updates**
1. Update `WebSocketTransport.connect()` to accept session parameter
2. Add session ID to WebSocket URL construction
3. Implement session storage and retrieval methods

### **Phase 2: Example Updates** 
1. Update `test-single-connection.js` with session demo
2. Enhance force-cleanup examples with session awareness
3. Add comprehensive session persistence example

### **Phase 3: Web Integration**
1. Update `mock-bluetooth.ts` with session support
2. Enhance web examples with localStorage persistence
3. Add browser-specific session management utilities

### **Phase 4: Documentation and Testing**
1. Update README with session usage examples
2. Add integration tests for session scenarios
3. Create troubleshooting guide for session issues

## **Backward Compatibility**

### **Existing Code Unchanged:**
```javascript
// This continues to work exactly as before
const transport = new WebSocketTransport();
await transport.connect({
  device: 'CS108',
  service: '9800',
  write: '9900',
  notify: '9901'
  // No session parameter = auto-generated session ID
});
```

### **Server Handles Missing Sessions:**
- Server auto-generates session IDs for legacy clients
- Maintains same connection behavior for existing applications
- No breaking changes to WebSocket protocol

## **Testing Strategy**

### **Session Persistence Tests:**
```javascript
// Test: Connect → Disconnect → Reconnect to same session
it('should reconnect to existing session', async () => {
  const sessionId = 'test-session-' + Date.now();
  
  // Connect with session ID
  await transport1.connect({ ...config, session: sessionId });
  const deviceName1 = await waitForConnection();
  
  // Disconnect WebSocket (but BLE stays alive)
  transport1.disconnect();
  
  // Reconnect to same session
  await transport2.connect({ ...config, session: sessionId });
  const deviceName2 = await waitForConnection();
  
  expect(deviceName1).toBe(deviceName2); // Same device
});
```

### **Multi-Connection Tests:**
```javascript
// Test: Multiple WebSockets to same session
it('should support multiple connections to same session', async () => {
  const sessionId = 'shared-session-' + Date.now();
  
  // Connect two transports to same session
  await Promise.all([
    transport1.connect({ ...config, session: sessionId }),
    transport2.connect({ ...config, session: sessionId })
  ]);
  
  // Both should connect to same BLE device
  expect(transport1.isConnected()).toBe(true);
  expect(transport2.isConnected()).toBe(true);
});
```

## **Success Criteria**

1. **Backward Compatibility**: All existing client code works unchanged
2. **Session Persistence**: WebSocket reconnects preserve BLE connections
3. **Multi-Connection Support**: Multiple WebSockets can share sessions
4. **Simple API**: Adding session support requires minimal code changes
5. **Clear Examples**: Comprehensive examples demonstrate all session features
6. **Production Ready**: Robust error handling and timeout management

## **Risks and Mitigations**

### **Risk: Complex Session Management**
**Mitigation**: Provide simple defaults and clear examples. Most users won't need advanced features.

### **Risk: Session ID Collisions** 
**Mitigation**: Use crypto.randomUUID() for generation. Provide guidance on session naming.

### **Risk: Memory Leaks from Long-Lived Sessions**
**Mitigation**: Server-side timeout management already implemented. Document session cleanup best practices.

### **Risk: Debugging Complexity**
**Mitigation**: Enhanced logging with session IDs. Clear error messages for session-related issues.