name: "Session Manager Follow-On - Fix Session Reuse and Idle Timeout Bugs"
description: |

## Purpose
Fix critical session management bugs that prevent proper session reuse and idle timeout functionality in the BLE WebSocket bridge server.

## Core Principles
1. **Context is King**: Include ALL necessary documentation, examples, and caveats
2. **Validation Loops**: Provide executable tests/lints the AI can run and fix
3. **Information Dense**: Use keywords and patterns from the codebase
4. **Progressive Success**: Start simple, validate, then enhance
5. **Global rules**: Be sure to follow all rules in CLAUDE.md

---

## Goal
Fix two critical bugs in the session management system:
1. Session reuse is broken - server rejects reconnections with the same session ID
2. Idle timeout never triggers - sessions stay alive indefinitely

## Why
- **Business value**: Customers are experiencing connection failures when their apps reload/reconnect
- **User impact**: Session persistence is a key feature for maintaining stable BLE connections
- **Problems this solves**: 
  - Client apps that properly persist session IDs can't reconnect to their existing sessions
  - Stale sessions accumulate on the server, consuming resources indefinitely

## What
Fix the session management logic to:
1. Allow reconnection to existing sessions using the same session ID
2. Properly track idle time and clean up inactive sessions after the configured timeout

### Success Criteria
- [ ] Client can reconnect to an existing session using the same session ID
- [ ] Session idle timeout properly triggers after configured duration of inactivity
- [ ] Existing grace period functionality continues to work correctly
- [ ] All existing tests pass plus new tests for fixed functionality

## All Needed Context

### Documentation & References
```yaml
# MUST READ - Include these in your context window
- url: https://github.com/websockets/ws#how-to-detect-and-close-broken-connections
  why: WebSocket connection lifecycle and reconnection patterns
  
- url: https://softwareengineering.stackexchange.com/questions/434117/websocket-client-reconnection-best-practices
  why: Session persistence patterns and best practices
  
- file: src/session-manager.ts
  why: Contains the bug in getOrCreateSession() that rejects same session ID
  critical: Line 36 checks for ANY session with transport, should allow same sessionId
  
- file: src/ble-session.ts
  why: Contains idle timeout bug in resetIdleTimer() method
  critical: Timer is reset to full duration instead of tracking cumulative idle time

- file: src/bridge-server.ts
  why: Shows how WebSocket connections are routed to sessions
  critical: Line 33 extracts session ID from URL params

- file: CLAUDE.md
  why: Project conventions - use pnpm, never npm/npx
```

### Current Codebase Context

#### Bug 1: Session Reuse Rejection
In `src/session-manager.ts` lines 32-41:
```typescript
// Check if any other session has a BLE transport (connected or in grace period)
const activeSessions = Array.from(this.sessions.values());
const sessionWithTransport = activeSessions.find(s => s.getStatus().hasTransport);

if (sessionWithTransport && sessionWithTransport.sessionId !== sessionId) {
  // Reject new session - device is busy
  console.log(`[SessionManager] Rejecting new session ${sessionId} - device busy with session ${sessionWithTransport.sessionId} (grace period: ${status.hasGracePeriod})`);
  return null;
}
```
The bug is that it finds ANY session with transport, then only checks if it's different. It should allow reconnection when the session ID matches.

#### Bug 2: Idle Timeout Reset
In `src/ble-session.ts` lines 131-141:
```typescript
private resetIdleTimer(): void {
  if (this.idleTimer) {
    clearTimeout(this.idleTimer);
  }
  
  this.idleTimer = setTimeout(() => {
    const idleTime = Math.round((Date.now() - this.lastTxTime) / 1000);
    console.log(`[Session:${this.sessionId}] Idle timeout (${idleTime}s since last TX) - cleaning up`);
    this.cleanup('idle timeout');
  }, this.idleTimeoutSec * 1000);
}
```
The timer is always set to the full `idleTimeoutSec` duration, so it never expires if there's any activity.

### Example Client Logs Showing the Bug
```
=== Test 1: First Connection (Success) ===
[MockBluetooth] Generated new session: 127.0.0.1-chrome-OXNC
[MockGATT] WebSocket connect options: {"device":"6c79b82603a7","session":"127.0.0.1-chrome-OXNC"}
Connected to 6c79b82603a7

=== Page Reload ===

=== Test 2: After Reload (Failed) ===
[MockBluetooth] Reusing stored session: 127.0.0.1-chrome-OXNC
[MockGATT] WebSocket connect options: {"device":"6c79b82603a7","session":"127.0.0.1-chrome-OXNC"}
ERROR: Device is busy with another session
```

### Known Gotchas of our codebase & Library Quirks
```typescript
// CRITICAL: This project uses pnpm exclusively - NEVER use npm or npx
// CRITICAL: WebSocket 'ws' library doesn't auto-reconnect - manual handling required
// CRITICAL: Noble.js requires async/await patterns - no callback mixing
// CRITICAL: Session manager is stateful - must handle cleanup properly
// CRITICAL: Grace period and idle timeout are configured via environment variables
```

## Implementation Blueprint

### Data models and structure
No new data models needed - fixing existing logic only.

### List of tasks to be completed in order

```yaml
Task 1: Fix Session Reuse Bug in SessionManager
MODIFY src/session-manager.ts:
  - FIND pattern: "getOrCreateSession" method
  - FIX logic to allow reconnection with same session ID
  - ADD logging to show when reusing vs rejecting sessions
  - REMOVE old broken logic completely

Task 2: Fix Idle Timeout Tracking in BleSession
MODIFY src/ble-session.ts:
  - FIND pattern: "resetIdleTimer" method
  - CHANGE to track actual idle time instead of resetting
  - ADD proper idle time calculation
  - REWRITE timer logic from scratch

Task 3: Add Comprehensive Tests
CREATE tests/unit/session-reuse.test.ts:
  - TEST session reuse with same ID succeeds
  - TEST different session ID is properly rejected
  - TEST force takeover continues to work

CREATE tests/unit/idle-timeout.test.ts:
  - TEST idle timeout triggers after configured time
  - TEST activity properly extends session life
  - TEST grace period and idle timeout interact correctly

Task 4: Update Integration Tests
MODIFY tests/integration/session-persistence.test.ts:
  - ADD test for reconnection with persisted session ID
  - ADD test for idle timeout cleanup
  - VERIFY existing tests still pass

Task 5: Add E2E Test for Session Reuse
CREATE tests/e2e/session-reuse-fix.spec.ts:
  - TEST full flow: connect → disconnect → reconnect with same session
  - TEST server properly accepts reconnection
  - TEST data flow works after reconnection

Task 6: Update Examples and Documentation
MODIFY examples/minimal-session-repro.html:
  - ADD success case showing working reconnection
  - UPDATE to show both bug and fix behavior

Task 7: Piggyback execute-prp Command Update
UNSTASH and commit .claude/commands/execute-prp.md changes
```

### Per task pseudocode

```typescript
// Task 1: Fix Session Reuse in SessionManager
getOrCreateSession(sessionId: string, config: BleConfig): BleSession | null {
  let session = this.sessions.get(sessionId);
  
  if (!session) {
    // Check if device is busy with a DIFFERENT session
    const activeSessions = Array.from(this.sessions.values());
    const blockingSession = activeSessions.find(s => 
      s.getStatus().hasTransport && 
      s.sessionId !== sessionId  // Only block if DIFFERENT session
    );
    
    if (blockingSession) {
      console.log(`[SessionManager] Rejecting new session ${sessionId} - device busy with different session ${blockingSession.sessionId}`);
      return null;
    }
    
    // Create new session
    console.log(`[SessionManager] Creating new session: ${sessionId}`);
    session = new BleSession(sessionId, config, this.sharedState);
    // ... rest of creation logic
  } else {
    console.log(`[SessionManager] Reusing existing session: ${sessionId}`);
    // CRITICAL: Update config if provided (device might have changed)
    if (config && session) {
      session.updateConfig(config); // Need to add this method
    }
  }
  
  return session;
}

// Task 2: Fix Idle Timeout Tracking
private startIdleTimer(): void {
  // Start timer on session creation or after activity
  this.idleTimer = setInterval(() => {
    const idleTime = Math.round((Date.now() - this.lastTxTime) / 1000);
    
    if (idleTime >= this.idleTimeoutSec) {
      console.log(`[Session:${this.sessionId}] Idle timeout reached (${idleTime}s) - cleaning up`);
      this.cleanup('idle timeout');
    }
  }, 10000); // Check every 10 seconds
}

private resetIdleTimer(): void {
  // Just update last activity time, don't reset timer
  this.lastTxTime = Date.now();
}
```

### Integration Points
```yaml
ENVIRONMENT VARIABLES:
  - BLE_SESSION_GRACE_PERIOD_SEC: Grace period duration (default 60)
  - BLE_SESSION_IDLE_TIMEOUT_SEC: Idle timeout duration (default 300)
  
WEBSOCKET URL PARAMS:
  - session: Session ID to reuse or create
  - force: Force takeover of busy device
  
LOGGING:
  - Add clear logs showing session reuse vs creation
  - Log idle time checks for debugging
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
```bash
# Run new session reuse tests
pnpm run test tests/unit/session-reuse.test.ts

# Run new idle timeout tests  
pnpm run test tests/unit/idle-timeout.test.ts

# Run all unit tests to ensure no regression
pnpm run test:unit

# Expected: All tests passing
```

### Level 3: Integration Tests
```bash
# Start bridge server in test mode
BLE_SESSION_IDLE_TIMEOUT_SEC=10 pnpm run start

# In another terminal, run integration tests
pnpm run test:integration

# Expected: All tests pass, including new reconnection tests
```

### Level 4: E2E Tests
```bash
# Ensure bridge server is running
pnpm run start

# Run E2E tests including new session reuse test
pnpm exec playwright test tests/e2e/session-reuse-fix.spec.ts

# Test with the reproduction example
# Open examples/minimal-session-repro.html and verify:
# 1. First connection succeeds
# 2. After reload, reconnection succeeds with same session ID
# 3. No "Device is busy" errors
```

### Level 5: Manual Verification
```bash
# Start server with debug logging
BLE_SESSION_IDLE_TIMEOUT_SEC=30 BLE_SESSION_GRACE_PERIOD_SEC=15 pnpm run start

# Watch logs for:
# - "[SessionManager] Reusing existing session: XXX" on reconnect
# - "[Session:XXX] Idle timeout reached (30s) - cleaning up" after inactivity

# Test with real client application to verify fix
```

## Final Validation Checklist
- [ ] Session reuse works - same session ID can reconnect
- [ ] Idle timeout triggers after configured duration
- [ ] Grace period still works correctly
- [ ] All existing tests pass
- [ ] New tests cover both bug fixes
- [ ] No linting errors: `pnpm run lint`
- [ ] No type errors: `pnpm run typecheck`
- [ ] Build succeeds: `pnpm run build`
- [ ] Manual test with minimal-session-repro.html shows success
- [ ] Logs clearly show session reuse vs creation
- [ ] Version bumped to 0.5.4 in package.json

## Anti-Patterns to Avoid
- ❌ Don't break existing grace period functionality
- ❌ Don't allow multiple sessions to control the same device
- ❌ Don't use npm/npx - always use pnpm
- ❌ Don't skip tests - both bugs need test coverage
- ❌ Don't use setInterval for idle timeout if not needed
- ❌ Don't forget to clean up timers on session cleanup

---

## Confidence Score: 9/10

This PRP provides comprehensive context for fixing both session management bugs. The bugs are clearly identified with exact code locations, and we're free to completely rewrite the broken logic since this has never worked properly. No backward compatibility concerns - we move forward.