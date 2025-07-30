name: "BLE WebSocket Bridge v0.4.0 - State Machine & Resource Management Refactor"
description: |

## Purpose
Implement a robust state machine architecture with proper resource management, connection control, and client idle timeout handling to ensure reliable single-client operation for the BLE WebSocket Bridge.

## Core Principles
1. **Context is King**: Include ALL necessary documentation, examples, and caveats
2. **Validation Loops**: Provide executable tests/lints the AI can run and fix
3. **Information Dense**: Use keywords and patterns from the codebase
4. **Progressive Success**: Start simple, validate, then enhance
5. **Global rules**: Be sure to follow all rules in CLAUDE.md

---

## Goal
Refactor the BLE WebSocket Bridge to implement proper state management, connection lifecycle control, and idle timeout handling. The system must enforce single-client operation with proper cleanup, prevent race conditions, and handle client idle timeouts gracefully.

## Why
- Current implementation suffers from race conditions and resource leaks
- Multiple clients can attempt simultaneous connections leading to undefined behavior
- No proper connection state management or idle timeout handling
- Need reliable single-client operation with automatic cleanup

## What
Implement a state machine with three states (IDLE, ACTIVE, EVICTING), connection mutex for single-client enforcement, idle timeout system with eviction warnings, and token-based force cleanup capabilities.

### Success Criteria
- [ ] No race conditions during concurrent connection attempts
- [ ] Proper client idle timeout with configurable duration (default 45s)
- [ ] Token-based force cleanup working reliably
- [ ] All state transitions working correctly
- [ ] Complete resource cleanup preventing memory leaks
- [ ] Connection establishment within 30 seconds
- [ ] System stable after 1000+ connect/disconnect cycles
- [ ] All existing MCP tools continue to work
- [ ] Tests complete in under 2 minutes

## All Needed Context

### Documentation & References (list all context needed to implement the feature)
```yaml
# MUST READ - Include these in your context window
- url: https://medium.com/@robinviktorsson/a-guide-to-the-state-design-pattern-in-typescript-and-node-js-with-practical-examples-20e92ff472df
  why: State pattern implementation in TypeScript with practical examples
  
- url: https://refactoring.guru/design-patterns/state/typescript/example
  why: TypeScript state pattern with Context class management
  
- url: https://www.npmjs.com/package/mutex-server
  why: TypeScript WebSocket mutex implementation patterns
  
- url: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakMap
  why: WeakMap for connection management without memory leaks
  
- file: src/bridge-server.ts
  why: Current implementation to refactor, connection handling patterns
  
- file: src/noble-transport.ts
  why: BLE transport layer, tryClaimConnection pattern, cleanup methods
  
- file: tests/integration/device-interaction.test.ts
  why: Test patterns, connection factory usage, expected behavior

- doc: https://github.com/websockets/ws#how-to-detect-and-close-broken-connections
  section: Connection health and timeout detection
  critical: Ping-pong mechanism for connection health

- doc: https://medium.com/voodoo-engineering/websockets-on-production-with-node-js-bdc82d07bb9f
  section: Best practices for WebSocket in production
  critical: Idle connection management, heartbeat patterns
```

### Current Codebase tree (run `tree` in the root of the project) to get an overview of the codebase
```bash
src/
├── bridge-server.ts      # WebSocket server, main refactor target
├── index.ts             # Exports
├── log-buffer.ts        # Log management
├── logger.ts            # Logging utilities
├── mcp-http-transport.ts# MCP transport
├── mcp-tools.ts         # MCP tool registration
├── mock-bluetooth.ts    # Browser mock
├── noble-transport.ts   # BLE transport layer
├── start-server.ts      # Server entry point
├── utils.ts             # Utilities
└── ws-transport.ts      # WebSocket client transport

tests/
├── connection-factory.ts # Connection test utilities
├── e2e/                 # Playwright tests
├── integration/         # Integration tests
├── stress/              # Stress tests
├── test-config.ts       # Test configuration
├── unit/                # Unit tests
└── vitest-setup.ts      # Test setup
```

### Desired Codebase tree with files to be added and responsibility of file
```bash
src/
├── bridge-server.ts        # Enhanced with state machine integration
├── connection-context.ts   # NEW: Per-connection state management
├── connection-mutex.ts     # NEW: Single-connection enforcement
├── state-machine.ts        # NEW: IDLE/ACTIVE/EVICTING states
├── index.ts               # Updated exports
├── log-buffer.ts          # Unchanged
├── logger.ts              # Unchanged
├── mcp-http-transport.ts  # Unchanged
├── mcp-tools.ts           # Unchanged
├── mock-bluetooth.ts      # Unchanged
├── noble-transport.ts     # Enhanced with mutex integration
├── start-server.ts        # Unchanged
├── utils.ts               # Unchanged
└── ws-transport.ts        # Unchanged

tests/
├── connection-factory.ts   # Updated for token support
├── unit/
│   ├── connection-context.test.ts  # NEW
│   ├── connection-mutex.test.ts    # NEW
│   └── state-machine.test.ts       # NEW
└── integration/
    └── idle-timeout.test.ts        # NEW
```

### Known Gotchas of our codebase & Library Quirks
```typescript
// CRITICAL: We use pnpm exclusively - NEVER use npm or npx commands
// CRITICAL: Noble.js async/await patterns only - no callbacks in connection flow
// CRITICAL: UUID normalization required for Noble.js (platform-specific)
// CRITICAL: WebSocket close event must clean up BLE connection
// CRITICAL: Noble.js listener accumulation causes memory leaks
// CRITICAL: Force cleanup requires Noble.js reset on Linux
// CRITICAL: Environment variables must be parsed to numbers
// CRITICAL: State transitions must be atomic to prevent race conditions
```

## Implementation Blueprint

### Data models and structure

Create the core data models, ensuring type safety and consistency.
```typescript
// State machine states
export enum ServerState {
  IDLE = 'IDLE',        // No active connections
  ACTIVE = 'ACTIVE',    // BLE connection active
  EVICTING = 'EVICTING' // Idle timeout triggered
}

// Connection context interface
export interface ConnectionContext {
  token: string;
  ws: WebSocket;
  connectedAt: Date;
  lastActivity: Date;
  idleTimer?: NodeJS.Timeout;
  isCleaningUp: boolean;
}

// WebSocket message types with token
export interface ConnectedMessage {
  type: 'connected';
  device: string;
  token: string;
  timestamp: string;
}

export interface EvictionWarningMessage {
  type: 'eviction_warning';
  grace_period_ms: number;
  reason: string;
}

export interface ForceCleanupMessage {
  type: 'force_cleanup';
  token: string;
}

// State transition validation
export type StateTransition = {
  from: ServerState;
  to: ServerState;
  allowed: boolean;
};
```

### list of tasks to be completed to fulfill the PRP in the order they should be completed

```yaml
Task 1: Create StateMachine class
CREATE src/state-machine.ts:
  - IMPLEMENT state tracking with IDLE, ACTIVE, EVICTING states
  - VALIDATE transitions: IDLE ↔ ACTIVE → EVICTING → IDLE
  - LOG all state changes with timestamps
  - EXPOSE getCurrentState() method

Task 2: Create ConnectionMutex class  
CREATE src/connection-mutex.ts:
  - IMPLEMENT atomic tryClaimConnection(token) method
  - TRACK active connection token
  - IMPLEMENT release(token) with token validation
  - PREVENT race conditions with synchronous state checks

Task 3: Create ConnectionContext class
CREATE src/connection-context.ts:
  - MANAGE token, WebSocket reference, idle timer
  - IMPLEMENT resetIdleTimer() method
  - HANDLE cleanup on timeout with eviction flow
  - INTEGRATE with ConnectionMutex for atomic release

Task 4: Update BridgeServer constructor and state
MODIFY src/bridge-server.ts:
  - ADD stateMachine, connectionMutex, currentContext properties
  - INITIALIZE CLIENT_IDLE_TIMEOUT from environment (default 45000ms)
  - REMOVE isCleaningUp flag (replaced by state machine)
  - LOG timeout configuration on startup

Task 5: Enhance connection establishment flow
MODIFY src/bridge-server.ts connection handler:
  - CHECK state machine allows new connection (IDLE state)
  - USE connectionMutex.tryClaimConnection() before BLE connect
  - CREATE ConnectionContext on successful connection
  - TRANSITION state machine to ACTIVE
  - GENERATE token using crypto.randomUUID()
  - UPDATE connected message to include token

Task 6: Implement activity tracking
MODIFY src/bridge-server.ts message handlers:
  - IDENTIFY activity messages (data, disconnect, cleanup, force_cleanup, check_pressure, keepalive)
  - CALL connectionContext.resetIdleTimer() on activity
  - PRESERVE existing message handling logic
  - ADD keepalive message type handler

Task 7: Implement idle timeout and eviction
MODIFY src/connection-context.ts:
  - START idle timer on connection creation
  - ON timeout: transition state to EVICTING
  - SEND eviction_warning message
  - START 5-second grace period timer
  - IF no keepalive: perform force cleanup
  - TRANSITION back to IDLE state

Task 8: Implement token-based force cleanup
MODIFY src/bridge-server.ts force_cleanup handler:
  - VALIDATE token matches current connection
  - USE connectionContext cleanup method
  - ENSURE mutex is released
  - TRANSITION state machine to IDLE
  - ERROR if invalid token

Task 9: Update NobleTransport integration
MODIFY src/noble-transport.ts:
  - INTEGRATE tryClaimConnection with ConnectionMutex
  - ENSURE performCompleteCleanup releases mutex
  - PRESERVE existing cleanup levels
  - MAINTAIN pressure monitoring

Task 10: Add comprehensive tests
CREATE tests/unit/state-machine.test.ts:
  - TEST valid state transitions
  - TEST invalid transition rejection
  - TEST state change logging

CREATE tests/unit/connection-mutex.test.ts:
  - TEST single connection enforcement
  - TEST token validation
  - TEST concurrent claim attempts

CREATE tests/unit/connection-context.test.ts:
  - TEST idle timer functionality
  - TEST activity reset behavior
  - TEST cleanup flow

CREATE tests/integration/idle-timeout.test.ts:
  - TEST full idle timeout flow
  - TEST keepalive prevents eviction
  - TEST force cleanup with token

Task 11: Update documentation
MODIFY README.md:
  - DOCUMENT new message types
  - EXPLAIN idle timeout behavior
  - PROVIDE migration guide
  - UPDATE environment variables

Task 12: Performance and stress testing
RUN tests/stress/connection-stress.test.ts:
  - VERIFY 1000+ connection cycles
  - CHECK memory stability
  - VALIDATE state consistency
```

### Per task pseudocode as needed added to each task
```typescript

// Task 1: StateMachine implementation
export class StateMachine {
  private state: ServerState = ServerState.IDLE;
  private logger: Logger;
  
  constructor() {
    this.logger = new Logger('StateMachine');
  }
  
  transition(to: ServerState): void {
    // VALIDATE transition is allowed
    const allowed = this.isTransitionAllowed(this.state, to);
    if (!allowed) {
      throw new Error(`Invalid state transition: ${this.state} -> ${to}`);
    }
    
    // LOG state change
    this.logger.info(`State transition: ${this.state} -> ${to}`);
    this.state = to;
  }
  
  private isTransitionAllowed(from: ServerState, to: ServerState): boolean {
    // IDLE can go to ACTIVE
    // ACTIVE can go to IDLE or EVICTING
    // EVICTING can only go to IDLE
    // Implement transition matrix
  }
}

// Task 3: ConnectionContext idle timer management
export class ConnectionContext {
  private idleTimeout: number;
  private idleTimer?: NodeJS.Timeout;
  private evictionTimer?: NodeJS.Timeout;
  
  constructor(ws: WebSocket, token: string, idleTimeout: number, 
              private stateMachine: StateMachine,
              private connectionMutex: ConnectionMutex) {
    this.token = token;
    this.ws = ws;
    this.idleTimeout = idleTimeout;
    this.connectedAt = new Date();
    this.lastActivity = new Date();
    this.startIdleTimer();
  }
  
  resetIdleTimer(): void {
    // CLEAR existing timer
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    
    // UPDATE activity timestamp
    this.lastActivity = new Date();
    
    // START new timer
    this.startIdleTimer();
  }
  
  private startIdleTimer(): void {
    this.idleTimer = setTimeout(() => {
      // TRANSITION to EVICTING state
      this.stateMachine.transition(ServerState.EVICTING);
      
      // SEND eviction warning
      this.ws.send(JSON.stringify({
        type: 'eviction_warning',
        grace_period_ms: 5000,
        reason: 'idle_timeout'
      }));
      
      // START grace period timer
      this.evictionTimer = setTimeout(() => {
        // PERFORM force cleanup
        this.cleanup('idle_timeout_eviction');
      }, 5000);
    }, this.idleTimeout);
  }
  
  async cleanup(reason: string): Promise<void> {
    // PREVENT concurrent cleanup
    if (this.isCleaningUp) return;
    this.isCleaningUp = true;
    
    // CLEAR all timers
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.evictionTimer) clearTimeout(this.evictionTimer);
    
    // RELEASE mutex
    this.connectionMutex.release(this.token);
    
    // CLOSE WebSocket
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    
    // TRANSITION state to IDLE
    this.stateMachine.transition(ServerState.IDLE);
  }
}

// Task 5: Enhanced connection flow with token
// In bridge-server.ts connection handler
const token = crypto.randomUUID();
if (!this.connectionMutex.tryClaimConnection(token)) {
  ws.send(JSON.stringify({ 
    type: 'error', 
    error: 'Another connection is active' 
  }));
  ws.close();
  return;
}

// Create context AFTER successful BLE connection
this.currentContext = new ConnectionContext(
  ws, 
  token, 
  this.idleTimeout,
  this.stateMachine,
  this.connectionMutex
);

// Send connected message with token
ws.send(JSON.stringify({ 
  type: 'connected', 
  device: this.transport.getDeviceName(),
  token: token,
  timestamp: new Date().toISOString()
}));
```

### Integration Points
```yaml
ENVIRONMENT:
  - add to: .env.example
  - variable: "CLIENT_IDLE_TIMEOUT=45000  # Client idle timeout in milliseconds"
  
CONFIG:
  - add to: src/bridge-server.ts constructor
  - pattern: "this.idleTimeout = parseInt(process.env.CLIENT_IDLE_TIMEOUT || '45000', 10);"
  
EXPORTS:
  - add to: src/index.ts  
  - exports: "export { StateMachine, ServerState } from './state-machine.js';"
  - exports: "export { ConnectionMutex } from './connection-mutex.js';"
  - exports: "export { ConnectionContext } from './connection-context.js';"

MESSAGE_PROTOCOL:
  - update: WebSocket message types in comments
  - add: keepalive, eviction_warning message types
  - update: connected message to include token
  - update: force_cleanup to require token
```

## Validation Loop

### Level 1: Syntax & Style
```bash
# Run these FIRST - fix any errors before proceeding
pnpm run lint              # ESLint with auto-fix
pnpm run typecheck         # TypeScript type checking

# Expected: No errors. If errors, READ the error and fix.
```

### Level 2: Unit Tests each new feature/file/function use existing test patterns
```typescript
// Test state machine transitions
import { describe, it, expect } from 'vitest';
import { StateMachine, ServerState } from '../src/state-machine.js';

describe('StateMachine', () => {
    it('should start in IDLE state', () => {
        const sm = new StateMachine();
        expect(sm.getCurrentState()).toBe(ServerState.IDLE);
    });

    it('should allow IDLE -> ACTIVE transition', () => {
        const sm = new StateMachine();
        expect(() => sm.transition(ServerState.ACTIVE)).not.toThrow();
        expect(sm.getCurrentState()).toBe(ServerState.ACTIVE);
    });

    it('should reject IDLE -> EVICTING transition', () => {
        const sm = new StateMachine();
        expect(() => sm.transition(ServerState.EVICTING)).toThrow('Invalid state transition');
    });
});

// Test connection mutex
describe('ConnectionMutex', () => {
    it('should allow first connection to claim', () => {
        const mutex = new ConnectionMutex();
        const token = 'test-token-1';
        expect(mutex.tryClaimConnection(token)).toBe(true);
    });

    it('should reject second connection attempt', () => {
        const mutex = new ConnectionMutex();
        mutex.tryClaimConnection('token-1');
        expect(mutex.tryClaimConnection('token-2')).toBe(false);
    });

    it('should allow new connection after release', () => {
        const mutex = new ConnectionMutex();
        const token1 = 'token-1';
        mutex.tryClaimConnection(token1);
        mutex.release(token1);
        expect(mutex.tryClaimConnection('token-2')).toBe(true);
    });
});

// Test idle timeout flow
describe('ConnectionContext idle timeout', () => {
    it('should send eviction warning after idle timeout', async () => {
        // Mock WebSocket
        const ws = { 
            send: vi.fn(), 
            readyState: WebSocket.OPEN,
            close: vi.fn()
        };
        
        const context = new ConnectionContext(
            ws as any, 
            'test-token',
            100, // 100ms timeout for testing
            stateMachine,
            mutex
        );
        
        // Wait for idle timeout
        await new Promise(resolve => setTimeout(resolve, 150));
        
        // Should have sent eviction warning
        expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('eviction_warning'));
    });
});
```

```bash
# Run and iterate until passing:
pnpm run test src/state-machine.test.ts
pnpm run test src/connection-mutex.test.ts
pnpm run test src/connection-context.test.ts
# If failing: Read error, understand root cause, fix code, re-run
```

### Level 3: Integration Test
```bash
# Build and start the service
pnpm run build
pnpm run start

# Test connection with device
curl -X GET "ws://localhost:8080/?device=CS108&service=9800&write=9801&notify=9801"

# Test idle timeout (wait 45+ seconds without activity)
# Expected: eviction_warning message after 45s

# Test keepalive prevents eviction
wscat -c "ws://localhost:8080/?device=CS108&service=9800&write=9801&notify=9801"
# Send: {"type": "keepalive"} every 30 seconds
# Expected: connection stays active

# Test force cleanup with token
# Send: {"type": "force_cleanup", "token": "your-connection-token"}
# Expected: force_cleanup_complete message
```

### Level 4: Stress Test
```bash
# Run connection stress test
pnpm run test tests/stress/connection-stress.test.ts

# Expected: 
# - 1000+ successful connections
# - No memory growth
# - Consistent state transitions
```

## Final validation Checklist
- [ ] All tests pass: `pnpm run test`
- [ ] No linting errors: `pnpm run lint`
- [ ] No type errors: `pnpm run typecheck`
- [ ] Build succeeds: `pnpm run build`
- [ ] Idle timeout works correctly (45s default)
- [ ] Keepalive prevents eviction
- [ ] Force cleanup with valid token works
- [ ] Force cleanup with invalid token rejected
- [ ] State transitions logged correctly
- [ ] No race conditions with concurrent connections
- [ ] Memory usage stable over 1000 cycles
- [ ] All existing MCP tools still work
- [ ] README.md updated with new protocol

---

## Anti-Patterns to Avoid
- ❌ Don't allow state transitions without validation
- ❌ Don't forget to clear timers on cleanup
- ❌ Don't allow multiple concurrent connections
- ❌ Don't skip token validation on force cleanup
- ❌ Don't use callbacks in Noble.js connection flow
- ❌ Don't hardcode timeout values
- ❌ Don't catch all exceptions - be specific
- ❌ Don't use npm/npx - always use pnpm
- ❌ Don't create race conditions with async state checks
- ❌ Don't leak event listeners or timers