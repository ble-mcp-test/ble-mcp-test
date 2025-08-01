name: "Session Manager Architecture Refactor - Context-Rich with Validation Loops (TypeScript/Node.js)"
description: |
  Refactor monolithic bridge-server.ts into clean single-responsibility classes with session persistence
  to solve WebSocket disconnect cycles that tear down BLE connections unnecessarily.

---

## Goal
Refactor the 301-line monolithic `bridge-server.ts` into a clean, testable architecture with persistent BLE sessions that survive WebSocket disconnects. Enable clients to reconnect to existing BLE connections using session identifiers.

## Why
- **Current Problem**: WebSocket clients connect → receive data → disconnect rapidly (~5 seconds), creating connect/disconnect loops that tear down healthy BLE connections
- **User Impact**: Inventory operations work but connection status is unreliable, causing confusion
- **Technical Debt**: 301-line monolithic class mixing HTTP server, WebSocket handling, BLE transport, and state management
- **Testability**: Cannot unit test individual components due to tight coupling

## What
Transform the architecture from 1:1 WebSocket-to-BLE coupling to persistent session-based connections:

### Current Flow (Problematic):
```
WebSocket connects → Create BLE connection → WebSocket disconnects → Destroy BLE connection
```

### New Flow (Persistent):
```  
WebSocket connects → Route to Session → Reuse/Create BLE connection → WebSocket disconnects → Start grace period → WebSocket reconnects → Resume existing session
```

### Success Criteria
- [ ] BridgeServer reduced to ~50 lines (HTTP server + routing only)
- [ ] WebSocket disconnects don't kill BLE connections during grace period  
- [ ] Clients can reconnect to existing sessions using session ID
- [ ] Each class has single responsibility and can be unit tested
- [ ] No regression in connection speed or throughput
- [ ] All existing tests pass

## All Needed Context

### Documentation & References
```yaml
# MUST READ - Include these in your context window
- file: /home/mike/ble-mcp-test/src/bridge-server.ts
  why: Current monolithic implementation to refactor - contains all WebSocket handling logic
  
- file: /home/mike/ble-mcp-test/src/ble-session.ts  
  why: Already implements session persistence with grace periods and idle timeouts - just needs integration
  
- file: /home/mike/ble-mcp-test/src/ws-transport.ts
  why: Defines WSMessage interface and WebSocket message patterns to follow
  
- file: /home/mike/ble-mcp-test/src/noble-transport.ts
  why: Shows EventEmitter patterns for transport classes
  
- file: /home/mike/ble-mcp-test/tests/unit/log-buffer.test.ts
  why: Example of proper Vitest unit testing patterns with beforeEach/describe/it
  
- url: https://medium.com/voodoo-engineering/websockets-on-production-with-node-js-bdc82d07bb9f
  why: WebSocket session management best practices and connection lifecycle patterns
  
- url: https://dev.to/aaravjoshi/6-essential-websocket-patterns-for-real-time-applications-39gf  
  section: Session persistence and reconnection patterns
  critical: Grace period handling prevents unnecessary resource cleanup
```

### Current Codebase Structure
```bash
src/
├── bridge-server.ts       # 301 lines - MONOLITHIC (to be refactored)
├── ble-session.ts         # 202 lines - ALREADY EXISTS (minor updates)
├── noble-transport.ts     # EventEmitter pattern for BLE transport
├── ws-transport.ts        # WSMessage interface and WebSocket patterns
├── shared-state.ts        # State management for observability
├── bluetooth-errors.ts    # HCI error code translation
└── utils.ts               # Utility functions
```

### Desired Codebase Structure  
```bash
src/
├── bridge-server.ts       # ~50 lines - HTTP server + routing only
├── session-manager.ts     # ~80 lines - NEW - Session lifecycle management
├── ws-handler.ts          # ~120 lines - NEW - Individual WebSocket handling  
├── ble-session.ts         # ~200 lines - EXISTING - Minor updates for integration
└── (all other files unchanged)
```

### Known Gotchas & Library Quirks
```typescript
// CRITICAL: This project uses pnpm EXCLUSIVELY  
// NEVER use npm or yarn commands - always use pnpm

// CRITICAL: WebSocket message format is already defined
interface WSMessage {
  type: 'data' | 'connected' | 'disconnected' | 'error' | 'eviction_warning' | 'keepalive_ack';
  seq?: number;
  data?: number[];
  device?: string;
  error?: string;
}

// CRITICAL: BleSession already handles grace periods and idle timeouts
// Environment variables (in seconds):
// BLE_MCP_GRACE_PERIOD=60 - Keep BLE alive after WebSocket disconnect  
// BLE_MCP_IDLE_TIMEOUT=180 - Cleanup sessions with no TX activity

// CRITICAL: EventEmitter pattern used for transport classes
// Both NobleTransport and BleSession extend EventEmitter

// CRITICAL: URL parameter parsing for session ID
// Format: ws://localhost:8080?device=X&service=Y&session=Z
// If no session param, generate UUID for backward compatibility

// CRITICAL: SharedState integration for observability
// All state changes must update SharedState for MCP tools
```

## Implementation Blueprint

### Data Models and Structure
```typescript
// Session management interfaces
interface SessionConfig {
  sessionId: string;
  bleConfig: BleConfig;
  sharedState?: SharedState;
}

interface SessionStatus {
  sessionId: string;
  connected: boolean;
  deviceName: string | null;
  activeWebSockets: number;
  idleTime: number;
  hasGracePeriod: boolean;
}

// WebSocket handler state  
interface WebSocketState {
  connected: boolean;
  lastMessage: Date;
  messageCount: number;
}
```

### List of Tasks to Complete (In Order)

```yaml
Task 1 - Extract WebSocketHandler:
  CREATE src/ws-handler.ts:
    - MIRROR EventEmitter pattern from: src/noble-transport.ts lines 24-27
    - COPY WebSocket message handling from: src/bridge-server.ts lines 119-136
    - COPY WebSocket close handling from: src/bridge-server.ts lines 138-150
    - MODIFY to delegate BLE operations to BleSession instead of NobleTransport
    - PRESERVE existing WSMessage interface from src/ws-transport.ts

Task 2 - Create SessionManager:
  CREATE src/session-manager.ts:
    - IMPLEMENT session Map<string, BleSession> registry
    - COPY environment variable parsing pattern from: src/ble-session.ts lines 23-24
    - MIRROR cleanup timer patterns from: src/bridge-server.ts lines 252-271
    - ADD session lookup and creation logic
    - PRESERVE SharedState integration

Task 3 - Refactor BridgeServer:
  MODIFY src/bridge-server.ts:
    - REMOVE lines 18-26 (state management - move to SessionManager)
    - REMOVE lines 37-156 (WebSocket handling - move to WebSocketHandler)  
    - REMOVE lines 159-284 (cleanup logic - move to SessionManager)
    - KEEP lines 33-36 (WebSocket server setup)
    - ADD URL parsing for session ID with fallback to UUID
    - ADD SessionManager integration

Task 4 - Update BleSession Integration:
  MODIFY src/ble-session.ts:
    - REMOVE addWebSocket/removeWebSocket methods (WebSocketHandler will manage)
    - ADD SharedState update hooks for connection events
    - ENHANCE getStatus() method for SessionManager
    - PRESERVE existing timeout and grace period logic

Task 5 - Add Comprehensive Tests:
  CREATE src/session-manager.test.ts:
    - MIRROR test structure from: tests/unit/log-buffer.test.ts
    - TEST session creation, lookup, and cleanup
    - TEST timeout handling and grace periods
    
  CREATE src/ws-handler.test.ts:
    - TEST WebSocket message parsing and validation
    - TEST connection lifecycle events
    - MOCK BleSession for isolated testing
```

### Task 1 Pseudocode - WebSocketHandler
```typescript
export class WebSocketHandler extends EventEmitter {
  constructor(
    private ws: WebSocket,
    private session: BleSession,
    private sharedState?: SharedState
  ) {
    super();
    this.setupWebSocketHandlers();
    this.session.addWebSocket(ws); // BleSession tracks active WebSockets
  }

  private setupWebSocketHandlers(): void {
    // PATTERN: Copy exact message handling from bridge-server.ts lines 119-136
    this.ws.on('message', async (message) => {
      try {
        const msg: WSMessage = JSON.parse(message.toString());
        if (msg.type === 'data' && msg.data) {
          const data = new Uint8Array(msg.data);
          // DELEGATE to session instead of direct transport
          await this.session.write(data);
        }
      } catch (error) {
        this.handleError(error);
      }
    });

    // PATTERN: Copy close handling from bridge-server.ts lines 138-143
    this.ws.on('close', () => {
      this.session.removeWebSocket(this.ws); // Session handles grace period
      this.emit('close');
    });

    // PATTERN: Session data forwarding to WebSocket
    this.session.on('data', (data: Uint8Array) => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'data', data: Array.from(data) }));
      }
    });
  }
}
```

### Task 2 Pseudocode - SessionManager  
```typescript
export class SessionManager {
  private sessions = new Map<string, BleSession>();
  
  getOrCreateSession(sessionId: string, config: BleConfig): BleSession {
    // PATTERN: Session lookup with creation fallback
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new BleSession(sessionId, config, this.sharedState);
      this.sessions.set(sessionId, session);
      
      // PATTERN: Auto-cleanup on session cleanup event
      session.once('cleanup', () => {
        this.sessions.delete(sessionId);
      });
    }
    return session;
  }

  attachWebSocket(session: BleSession, ws: WebSocket): WebSocketHandler {
    return new WebSocketHandler(ws, session, this.sharedState);
  }
}
```

### Integration Points
```yaml
URL_PARSING:
  - extract from: src/bridge-server.ts lines 38-39
  - pattern: "const url = new URL(req.url || '', 'http://localhost');"
  - add: "const sessionId = url.searchParams.get('session') || crypto.randomUUID();"
  
SHARED_STATE:
  - integrate with: src/shared-state.ts  
  - pattern: "this.sharedState?.setConnectionState({ connected: true, deviceName })"
  - ensure: All connection state changes update SharedState for MCP observability

ERROR_HANDLING:
  - use: src/bluetooth-errors.ts translateBluetoothError()
  - pattern: Existing error translation and logging from bridge-server.ts
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
// CREATE session-manager.test.ts with these test cases:
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionManager } from '../src/session-manager.js';

describe('SessionManager', () => {
  let manager: SessionManager;
  
  beforeEach(() => {
    manager = new SessionManager();
  });

  it('should create new session for unknown session ID', () => {
    const config = { devicePrefix: 'test', serviceUuid: '1234', writeUuid: '5678', notifyUuid: '9012' };
    const session = manager.getOrCreateSession('test-session', config);
    
    expect(session.sessionId).toBe('test-session');
    expect(manager.getAllSessions()).toHaveLength(1);
  });

  it('should reuse existing session for known session ID', () => {
    const config = { devicePrefix: 'test', serviceUuid: '1234', writeUuid: '5678', notifyUuid: '9012' };
    const session1 = manager.getOrCreateSession('test-session', config);
    const session2 = manager.getOrCreateSession('test-session', config);
    
    expect(session1).toBe(session2);
    expect(manager.getAllSessions()).toHaveLength(1);
  });

  it('should clean up expired sessions', async () => {
    const config = { devicePrefix: 'test', serviceUuid: '1234', writeUuid: '5678', notifyUuid: '9012' };
    const session = manager.getOrCreateSession('test-session', config);
    
    // Simulate session cleanup
    session.emit('cleanup', { sessionId: 'test-session', reason: 'test' });
    
    expect(manager.getAllSessions()).toHaveLength(0);
  });
});

// CREATE ws-handler.test.ts with these test cases:
describe('WebSocketHandler', () => {
  it('should forward BLE data to WebSocket', async () => {
    const mockWs = { 
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      on: vi.fn() 
    };
    const mockSession = { 
      addWebSocket: vi.fn(),
      on: vi.fn(),
      write: vi.fn()
    };
    
    const handler = new WebSocketHandler(mockWs, mockSession);
    
    // Simulate BLE data from session
    const dataHandler = mockSession.on.mock.calls.find(call => call[0] === 'data')[1];
    dataHandler(new Uint8Array([1, 2, 3]));
    
    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'data', data: [1, 2, 3] })
    );
  });
});
```

```bash
# Run and iterate until passing:
pnpm run test
# If failing: Read error, understand root cause, fix code, re-run
```

### Level 3: Integration Test
```bash
# Build and verify structure
pnpm run build

# Start the service  
pnpm run start

# Test session persistence (in another terminal)
# Connect with session ID
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: test" \
  "ws://localhost:8080?device=6c79b82603a7&service=9800&write=9900&notify=9901&session=test-session-123"

# Expected: Connection successful, BLE device connects
# Disconnect and reconnect with same session - should reuse BLE connection
```

## Final Validation Checklist
- [ ] All tests pass: `pnpm run test`
- [ ] No linting errors: `pnpm run lint` 
- [ ] No type errors: `pnpm run typecheck`
- [ ] Build succeeds: `pnpm run build`
- [ ] WebSocket connections with session ID work
- [ ] WebSocket reconnection reuses existing BLE connection
- [ ] Grace period prevents immediate BLE disconnection
- [ ] Idle timeout cleans up abandoned sessions
- [ ] MCP observability tools show correct connection state
- [ ] Existing tests continue to pass
- [ ] No regression in connection performance

---

## Anti-Patterns to Avoid
- ❌ Don't break existing WebSocket message format (WSMessage interface)
- ❌ Don't change BleSession's timeout logic - it's already well designed
- ❌ Don't create new EventEmitter patterns - follow existing ones
- ❌ Don't bypass SharedState updates - MCP tools depend on them
- ❌ Don't use npm/npx - always use pnpm
- ❌ Don't skip validation steps - run lint/typecheck after each change
- ❌ Don't mix session management with WebSocket handling - keep separated
- ❌ Don't ignore backward compatibility - existing clients should work

## Migration Safety
- All changes are additive and backward compatible
- Existing clients without session ID continue to work (UUID fallback)
- No breaking changes to WebSocket protocol
- Graceful degradation if session features fail