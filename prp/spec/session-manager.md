# Session Manager Architecture Refactor

## **Problem Statement**

The current `bridge-server.ts` is becoming monolithic with 300+ lines handling:
- HTTP WebSocket server setup
- Individual WebSocket connection lifecycle  
- BLE transport management
- Connection state transitions
- Error handling and recovery

This makes it difficult to:
- Add session persistence (surviving WebSocket disconnects)
- Test individual components in isolation
- Maintain clean separation of concerns
- Extend with new features

## **Solution: Extract Transport Layers**

Refactor into clean, single-responsibility classes with proper separation of concerns.

## **Architecture Overview**

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   BridgeServer  │───▶│ SessionManager  │───▶│   BleSession    │
│   (HTTP Server) │    │  (Routing)      │    │ (BLE Transport) │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  WebSocketHandler│    │ Session Lookup  │    │  Noble Transport│
│ (WS Lifecycle)  │    │  & Cleanup      │    │   & Timeouts    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## **Component Specifications**

### **1. BridgeServer (Simplified)**
**Responsibility:** HTTP server and initial routing only

**File:** `src/bridge-server.ts` (~50 lines)

**Interface:**
```typescript
class BridgeServer {
  private wss: WebSocketServer;
  private sessionManager: SessionManager;
  
  async start(port: number): Promise<void>
  async stop(): Promise<void>
}
```

**Behavior:**
- Start WebSocket server on specified port
- Parse URL parameters: `?device=X&service=Y&session=Z`
- Route new WebSocket connections to SessionManager
- Handle server-level errors and shutdown

### **2. SessionManager (New)**
**Responsibility:** Session lifecycle and routing

**File:** `src/session-manager.ts` (~50 lines)

**Interface:**
```typescript
class SessionManager {
  private sessions = new Map<string, BleSession>();
  
  getOrCreateSession(sessionId: string, config: BleConfig): BleSession
  attachWebSocket(session: BleSession, ws: WebSocket): WebSocketHandler
  cleanupExpiredSessions(): void
  getAllSessions(): BleSession[]
}
```

**Behavior:**
- Maintain session registry with automatic cleanup
- Create new BleSession instances on demand
- Route WebSocket connections to appropriate sessions
- Handle session expiration and resource cleanup

### **3. WebSocketHandler (New)**
**Responsibility:** Individual WebSocket connection lifecycle

**File:** `src/ws-handler.ts` (~100 lines)

**Interface:**
```typescript
class WebSocketHandler {
  constructor(ws: WebSocket, session: BleSession, sharedState?: SharedState)
  
  private handleMessage(message: string): Promise<void>
  private handleClose(): void
  private handleError(error: Error): void
  cleanup(): void
}
```

**Behavior:**
- Handle WebSocket message parsing and validation
- Delegate BLE operations to BleSession
- Manage WebSocket-specific error handling
- Coordinate with BleSession for connection lifecycle

### **4. BleSession (Existing - Minor Updates)**
**Responsibility:** Persistent BLE connection with timeout management

**File:** `src/ble-session.ts` (~200 lines)

**Updates Needed:**
- Remove WebSocket-specific logic (moved to WebSocketHandler)
- Enhance session status reporting
- Add SharedState integration hooks

## **Data Flow**

### **New Connection:**
1. **WebSocket connects** → BridgeServer
2. **Parse URL params** → Extract sessionId, device config
3. **Route to SessionManager** → `getOrCreateSession(sessionId, config)`
4. **Create/Reuse BleSession** → Connect to BLE device if needed
5. **Create WebSocketHandler** → Attach WS to session
6. **Start communication** → BLE data flows through session to WebSocket

### **WebSocket Disconnect:**
1. **WebSocket closes** → WebSocketHandler.handleClose()
2. **Notify BleSession** → Remove WebSocket from active set
3. **Start grace period** → Keep BLE alive for reconnection
4. **Cleanup if expired** → SessionManager removes expired sessions

### **Session Reconnection:**
1. **WebSocket connects with same sessionId** → BridgeServer
2. **SessionManager finds existing session** → Reuse BleSession
3. **Cancel grace period** → Attach new WebSocket to existing BLE connection
4. **Resume communication** → No BLE reconnection needed

## **Configuration**

### **Environment Variables:**
```bash
# Session timeouts (in seconds)
BLE_MCP_GRACE_PERIOD=60        # Keep BLE alive after WebSocket disconnect
BLE_MCP_IDLE_TIMEOUT=180       # Cleanup sessions with no TX activity

# Connection recovery
BLE_MCP_RECOVERY_DELAY=3000    # Delay between failed connection attempts
```

## **Benefits**

### **Separation of Concerns:**
- **BridgeServer**: HTTP server only
- **SessionManager**: Session routing only  
- **WebSocketHandler**: WebSocket protocol only
- **BleSession**: BLE transport only

### **Testability:**
- Each component can be unit tested in isolation
- Mock interfaces for component interaction testing
- Clear boundaries for integration testing

### **Maintainability:**
- Single responsibility per class
- Clear interfaces and dependencies
- Easy to add features to specific layers

### **Session Persistence:**
- WebSocket disconnects don't tear down BLE connections
- Clients can reconnect to existing sessions
- Configurable grace periods and idle timeouts

## **Implementation Plan**

### **Phase 1: Extract WebSocketHandler**
1. Create `src/ws-handler.ts`
2. Move WebSocket event handling from BridgeServer
3. Update BridgeServer to use WebSocketHandler

### **Phase 2: Create SessionManager**
1. Create `src/session-manager.ts`
2. Implement session registry and lifecycle
3. Update BridgeServer to use SessionManager

### **Phase 3: Integrate BleSession**
1. Update BleSession for new architecture
2. Implement session persistence logic
3. Add comprehensive testing

### **Phase 4: Cleanup and Testing**
1. Remove old monolithic code
2. Add unit tests for each component
3. Integration testing for full flow

## **Migration Strategy**

### **Backward Compatibility:**
- Existing clients without sessionId continue to work
- Graceful degradation to current behavior
- No breaking changes to WebSocket protocol

### **Rollout:**
- Deploy with feature flag for session management
- Monitor existing connections remain stable
- Gradually enable session features

## **Success Criteria**

1. **Clean Architecture**: Each class has single responsibility
2. **Session Persistence**: WebSocket disconnects don't kill BLE connections  
3. **Testability**: Components can be tested in isolation
4. **Performance**: No regression in connection speed or throughput
5. **Reliability**: Robust error handling and recovery
6. **Observability**: Clear logging and status reporting

## **Risks and Mitigations**

### **Risk: Complex State Management**
**Mitigation**: Clear state ownership - BleSession owns BLE state, WebSocketHandler owns WS state

### **Risk: Session Leaks**
**Mitigation**: Comprehensive timeout handling and cleanup monitoring

### **Risk: Race Conditions**
**Mitigation**: Clear async boundaries and event-driven architecture

### **Risk: Performance Overhead**
**Mitigation**: Lightweight session objects and efficient routing