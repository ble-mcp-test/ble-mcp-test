name: "Client-Side Session Manager Support - Context-Rich with Validation Loops (TypeScript/Node.js)"
description: |
  Add session UUID support to client-side WebSocket transport, examples, and mock implementations
  to leverage the existing server-side session architecture for connection persistence.

---

## Goal
Enhance client-side code with session UUID support to enable persistent BLE connections that survive WebSocket disconnects, leveraging the already-implemented server-side session architecture.

## Why
- **Server Architecture Ready**: Session manager, BLE sessions, and WebSocket handlers already implemented server-side
- **Client Gap**: Client code still creates ephemeral connections without session awareness
- **User Value**: Enable session persistence, reconnection, and multi-connection scenarios
- **Developer Experience**: Simple API addition (`session` parameter) with full backward compatibility

## What
Add session support to client libraries while maintaining 100% backward compatibility:

### Current Client Behavior:
```javascript
// Creates ephemeral connection - BLE dies when WebSocket closes
await transport.connect({ device: 'CS108', service: '9800', write: '9900', notify: '9901' });
```

### Enhanced Client Behavior:
```javascript  
// Session-aware connection - BLE persists across WebSocket reconnects
await transport.connect({ 
  device: 'CS108', service: '9800', write: '9900', notify: '9901',
  session: 'my-persistent-session'  // NEW: Session persistence
});
```

### Success Criteria
- [ ] WebSocketTransport accepts `session` parameter in connect options
- [ ] Auto-generates session IDs when `generateSession: true` 
- [ ] URL construction includes `?session=uuid` parameter
- [ ] Examples demonstrate session persistence and reconnection
- [ ] MockBluetooth supports session URLs for web applications
- [ ] 100% backward compatibility - existing code works unchanged
- [ ] Comprehensive test coverage for session scenarios

## All Needed Context

### Documentation & References
```yaml
# Server-Side Session Architecture (Already Implemented)
- file: src/session-manager.ts
  why: Shows how server handles session routing and lifecycle
  critical: getOrCreateSession(sessionId, config) - client must provide sessionId

- file: src/bridge-server.ts  
  why: Shows URL parameter parsing and session ID generation
  lines: 50-54
  critical: Auto-generates sessionId = `${config.devicePrefix}-${Date.now()}` for legacy clients

- file: src/ble-session.ts
  why: Shows session persistence features - grace periods, idle timeouts
  critical: BLE connection survives WebSocket disconnects

- file: src/ws-handler.ts
  why: Shows WebSocket-to-session attachment pattern
  critical: Multiple WebSockets can attach to same BLE session

# Client-Side Files to Enhance
- file: src/ws-transport.ts
  why: Core WebSocket client - needs session parameter support
  lines: 23-29
  critical: URL construction pattern to follow

- file: src/mock-bluetooth.ts  
  why: Web Bluetooth mock - needs session URL support
  lines: 348-370
  critical: MockBluetooth constructor pattern

- file: test-single-connection.js
  why: Primary example showing connection pattern
  lines: 17-24
  critical: URLSearchParams construction to enhance

# Testing Patterns
- file: tests/integration/mcp-tools.test.ts
  why: Shows Vitest testing patterns with beforeAll/afterAll
  critical: Use describe/it pattern, BridgeServer setup/teardown

# UUID Generation Best Practices
- url: https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID
  why: Native crypto.randomUUID() compatibility and requirements
  critical: Requires HTTPS context in browsers, localhost exempt

- url: https://nodejs.org/api/crypto.html
  why: Node.js crypto module for UUID generation  
  critical: Available in Node.js 15.6.0+, stable in 18+
```

### Current Codebase Tree (Key Files)
```bash
src/
├── ws-transport.ts          # MODIFY: Add session support
├── mock-bluetooth.ts        # MODIFY: Add session URL support  
├── session-manager.ts       # REFERENCE: Server session patterns
├── bridge-server.ts         # REFERENCE: URL parsing patterns
├── ble-session.ts          # REFERENCE: Session lifecycle
└── ws-handler.ts           # REFERENCE: WebSocket-session attachment

examples/
├── force-cleanup-example.js           # UPDATE: Add session awareness
├── force-cleanup-simple.html          # UPDATE: Web session demo  
└── session-persistence-demo.js        # CREATE: New comprehensive example

test-single-connection.js    # UPDATE: Demonstrate session persistence
```

### Desired Codebase Tree with Session Support
```bash  
src/
├── ws-transport.ts          # Enhanced with session methods
├── mock-bluetooth.ts        # Session-aware constructor
└── (server files unchanged) # Session architecture already complete

examples/
├── force-cleanup-example.js        # Session-aware cleanup
├── force-cleanup-simple.html       # localStorage session persistence
└── session-persistence-demo.js     # Full session lifecycle demo

tests/
└── integration/
    └── session-client.test.ts      # Client session test scenarios
```

### Known Gotchas & Library Quirks
```typescript
// CRITICAL: crypto.randomUUID() requires HTTPS in browsers (localhost exempt)
// PATTERN: Check availability before using
const generateSessionId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return 'session-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
};

// CRITICAL: Server auto-generates sessions for backward compatibility  
// PATTERN: From bridge-server.ts:52 - sessionId = `${config.devicePrefix}-${Date.now()}`
// Client should follow same pattern for consistency

// CRITICAL: URL parameter order from existing ws-transport.ts:24-28
// PATTERN: device, service, write, notify, then session
// Must preserve existing parameter order for compatibility

// CRITICAL: MockBluetooth constructor pattern from mock-bluetooth.ts:351-353
// PATTERN: constructor(serverUrl?, bleConfig?) - add session to bleConfig

// GOTCHA: WebSocket reconnection must preserve session ID
// Server expects same sessionId for reconnection to work
```

## Implementation Blueprint

### Data Models and Structure
```typescript
// Enhanced connection options interface
interface ConnectionOptions {
  device?: string;
  service?: string;  
  write?: string;
  notify?: string;
  session?: string;        // NEW: Explicit session ID
  generateSession?: boolean; // NEW: Auto-generate session ID
}

// Session utility functions
function generateSessionId(): string {
  // Cross-platform UUID generation with fallback
}

function isValidSessionId(sessionId: string): boolean {
  // Basic validation for session ID format
}
```

### Task List (Implementation Order)

```yaml
Task 1 - Enhance WebSocketTransport with Session Support:
MODIFY src/ws-transport.ts:
  - FIND interface definition around line 23
  - ADD session and generateSession parameters to ConnectionOptions
  - MODIFY connect() method around lines 23-29
  - ADD session parameter to URL construction after notify parameter
  - ADD private sessionId property to store current session
  - ADD getSessionId() and reconnectToSession() methods
  - PRESERVE existing parameter order and behavior

Task 2 - Add Session Utility Functions:
CREATE src/session-utils.ts:
  - IMPLEMENT generateSessionId() with crypto.randomUUID() fallback
  - IMPLEMENT isValidSessionId() for basic validation
  - IMPLEMENT cross-platform UUID generation
  - EXPORT utility functions for reuse

Task 3 - Update Test Connection Example:
MODIFY test-single-connection.js:
  - FIND URLSearchParams construction around line 17
  - ADD session parameter demonstration
  - ADD reconnection demo showing session persistence
  - PRESERVE existing functionality
  - ADD logging to show session ID usage

Task 4 - Enhance MockBluetooth for Web Apps:
MODIFY src/mock-bluetooth.ts:
  - FIND MockBluetooth constructor around line 351
  - ADD sessionId option to constructor options
  - MODIFY WebSocketTransport creation to pass session config
  - ADD injectWebBluetoothMock session parameter
  - PRESERVE existing API compatibility

Task 5 - Create Session Persistence Example:
CREATE examples/session-persistence-demo.js:
  - DEMONSTRATE connect → disconnect → reconnect to same session
  - SHOW multiple WebSocket connections to same session
  - INCLUDE error handling and session cleanup
  - MIRROR pattern from test-single-connection.js

Task 6 - Update Force Cleanup Examples:
MODIFY examples/force-cleanup-example.js:
  - ADD session awareness to cleanup operations
  - SHOW session-specific cleanup vs global cleanup
  - PRESERVE existing cleanup functionality

MODIFY examples/force-cleanup-simple.html:
  - ADD localStorage session persistence
  - DEMONSTRATE web session management
  - ADD session ID display in UI

Task 7 - Add Integration Tests:
CREATE tests/integration/session-client.test.ts:
  - TEST session persistence across reconnections
  - TEST multiple connections to same session
  - TEST auto-generation of session IDs
  - TEST backward compatibility
  - MIRROR patterns from existing test files
```

### Per Task Pseudocode

```typescript
// Task 1: WebSocketTransport Enhancement
class WebSocketTransport {
  private sessionId?: string;
  
  async connect(options?: ConnectionOptions): Promise<void> {
    // PATTERN: Preserve existing URL construction from lines 24-28
    const url = new URL(this.serverUrl);
    if (options?.device) url.searchParams.set('device', options.device);
    if (options?.service) url.searchParams.set('service', options.service);
    if (options?.write) url.searchParams.set('write', options.write);
    if (options?.notify) url.searchParams.set('notify', options.notify);
    
    // NEW: Session handling
    if (options?.session) {
      this.sessionId = options.session;
      url.searchParams.set('session', options.session); 
    } else if (options?.generateSession) {
      this.sessionId = generateSessionId();
      url.searchParams.set('session', this.sessionId);
    }
    
    // PRESERVE: Existing connection logic unchanged
    this.ws = new WebSocket(url.toString());
    // ... rest of connection logic identical
  }
  
  getSessionId(): string | undefined {
    return this.sessionId;
  }
  
  async reconnectToSession(sessionId: string): Promise<void> {
    // PATTERN: Reuse connect() with explicit session
    return this.connect({ session: sessionId });
  }
}

// Task 2: Session Utilities  
function generateSessionId(): string {
  // CRITICAL: Check crypto.randomUUID() availability 
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // FALLBACK: Match server pattern from bridge-server.ts:52
  return 'client-session-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// Task 4: MockBluetooth Enhancement
class MockBluetooth {
  constructor(
    private serverUrl?: string, 
    options?: { 
      service?: string; 
      write?: string; 
      notify?: string;
      sessionId?: string;        // NEW
      autoGenerateSession?: boolean; // NEW
    }
  ) {
    // PRESERVE: Existing bleConfig pattern
    this.bleConfig = options;
  }
}

// PATTERN: Enhanced injection function
function injectWebBluetoothMock(
  wsUrl: string, 
  options?: { 
    sessionId?: string,
    mockDevices?: any[] 
  }
): void {
  // MODIFY: Pass session options to MockBluetooth constructor
  const mockBluetooth = new MockBluetooth(wsUrl, { 
    sessionId: options?.sessionId,
    autoGenerateSession: !options?.sessionId 
  });
  // ... rest unchanged
}
```

### Integration Points
```yaml
URL_CONSTRUCTION:
  - pattern: "ws://localhost:8080?device=X&service=Y&write=Z&notify=W&session=UUID"
  - preserve: Existing parameter order from ws-transport.ts:24-28
  - add_after: notify parameter (maintains compatibility)

SESSION_STORAGE:
  - browser: "localStorage.setItem('bleSessionId', sessionId)"
  - pattern: "Persist across page reloads for web applications"
  
BACKWARD_COMPATIBILITY:
  - existing: "All current code works without modification"
  - server: "Auto-generates session IDs for legacy clients"
  - no_breaking: "No changes to existing method signatures"
```

## Validation Loop

### Level 1: Syntax & Style
```bash
# Run these FIRST - fix any errors before proceeding
pnpm run lint              # ESLint for code style
pnpm run typecheck         # TypeScript type checking

# Expected: No errors. If errors, READ the error and fix.
```

### Level 2: Unit Tests - Session Features
```typescript
// CREATE tests/integration/session-client.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketTransport } from '../../src/ws-transport.js';
import { BridgeServer } from '../../src/bridge-server.js';

describe('Client Session Management', () => {
  let bridgeServer: BridgeServer;
  let port = 8087;
  
  beforeAll(async () => {
    bridgeServer = new BridgeServer();
    await bridgeServer.start(port);
  });
  
  afterAll(async () => {
    await bridgeServer.stop();
  });

  it('should accept explicit session ID in connect options', async () => {
    const transport = new WebSocketTransport(`ws://localhost:${port}`);
    const sessionId = 'test-session-' + Date.now();
    
    await transport.connect({
      device: 'CS108',
      service: '9800',
      write: '9900', 
      notify: '9901',
      session: sessionId
    });
    
    expect(transport.getSessionId()).toBe(sessionId);
    transport.disconnect();
  });

  it('should auto-generate session ID when generateSession is true', async () => {
    const transport = new WebSocketTransport(`ws://localhost:${port}`);
    
    await transport.connect({
      device: 'CS108',
      service: '9800',
      write: '9900',
      notify: '9901', 
      generateSession: true
    });
    
    const sessionId = transport.getSessionId();
    expect(sessionId).toBeDefined();
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(10);
    transport.disconnect();
  });

  it('should maintain backward compatibility without session params', async () => {
    const transport = new WebSocketTransport(`ws://localhost:${port}`);
    
    // This should still work exactly as before
    await transport.connect({
      device: 'CS108',
      service: '9800',
      write: '9900',
      notify: '9901'
    });
    
    expect(transport.isConnected()).toBe(true);
    transport.disconnect();
  });

  it('should support session reconnection', async () => {
    const sessionId = 'reconnect-test-' + Date.now();
    const transport1 = new WebSocketTransport(`ws://localhost:${port}`);
    const transport2 = new WebSocketTransport(`ws://localhost:${port}`);
    
    // Connect with explicit session
    await transport1.connect({
      device: 'CS108',
      service: '9800',
      write: '9900',
      notify: '9901',
      session: sessionId
    });
    
    transport1.disconnect();
    
    // Reconnect to same session
    await transport2.reconnectToSession(sessionId);
    expect(transport2.getSessionId()).toBe(sessionId);
    
    transport2.disconnect();
  });
});
```

```bash
# Run session tests specifically
pnpm run test tests/integration/session-client.test.ts
# Expected: All tests passing
```

### Level 3: Example Integration Tests
```bash
# Test updated examples work
node test-single-connection.js
# Expected: Shows session ID usage in output

node examples/session-persistence-demo.js  
# Expected: Demonstrates connect → disconnect → reconnect

# Test web example (open in browser)
# Expected: localStorage session persistence works
```

### Level 4: Backward Compatibility Tests
```bash
# Run existing integration tests to ensure no regressions
pnpm run test:integration
# Expected: All existing tests still pass

# Specifically test WebSocket transport
pnpm run test tests/integration/ -t "WebSocket"
# Expected: No failures from session changes
```

## Final Validation Checklist
- [ ] All tests pass: `pnpm run test`
- [ ] No linting errors: `pnpm run lint`  
- [ ] No type errors: `pnpm run typecheck`
- [ ] Build succeeds: `pnpm run build`
- [ ] Existing examples work unchanged: `node test-single-connection.js`
- [ ] New session example works: `node examples/session-persistence-demo.js`
- [ ] Mock Bluetooth web demo works: open `examples/force-cleanup-simple.html`
- [ ] Backward compatibility verified: existing client code unchanged
- [ ] Session persistence works: reconnect preserves BLE connection

---

## Anti-Patterns to Avoid
- ❌ Don't break existing API - session support must be additive
- ❌ Don't change server-side code - session architecture already implemented  
- ❌ Don't hardcode session IDs in examples - use generation patterns
- ❌ Don't ignore crypto.randomUUID() browser requirements - provide fallbacks
- ❌ Don't skip backward compatibility tests - existing code must work
- ❌ Don't create new WebSocket connection patterns - follow ws-transport.ts
- ❌ Don't modify core WebSocket message handling - only URL construction