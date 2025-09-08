name: "Fix Characteristic Refresh - Remove refreshCharacteristics Method to Prevent Zombie Connections"
description: |

## Purpose
Completely remove the `refreshCharacteristics()` method and all its usages to prevent subscription accumulation and zombie connections. This PRP provides comprehensive context for AI agents to implement the fix with sufficient validation to achieve working code through iterative refinement.

## Core Principles
1. **Context is King**: Include ALL necessary documentation, examples, and caveats
2. **Validation Loops**: Provide executable tests/lints the AI can run and fix
3. **Information Dense**: Use keywords and patterns from the codebase
4. **Progressive Success**: Start simple, validate, then enhance
5. **Global rules**: Be sure to follow all rules in CLAUDE.md

---

## Goal
Completely remove the `refreshCharacteristics()` method from the codebase to eliminate the root cause of zombie connections. Follow CLAUDE.md principle: "DELETE don't deprecate" - remove problematic code entirely rather than avoid calling it.

## Why
- **Root Cause Elimination**: `refreshCharacteristics()` fundamentally cannot work safely - it always creates new Noble objects
- **Zombie Prevention**: Each call creates new characteristic objects causing subscription accumulation
- **Clean Code**: Follow CLAUDE.md "DELETE don't deprecate" principle - remove problematic patterns entirely
- **Future-Proof**: Prevents accidental misuse by future developers
- **Simpler Codebase**: Less code to maintain and debug

## What
Remove the `refreshCharacteristics()` method from all layers: noble-transport.ts, ble-session.ts, and bridge-server.ts. Trust existing characteristic references during session reuse.

### Success Criteria
- [ ] `refreshCharacteristics()` method removed from noble-transport.ts
- [ ] `refreshCharacteristics()` wrapper removed from ble-session.ts  
- [ ] `refreshCharacteristics()` call removed from bridge-server.ts
- [ ] Session reuse works without any refresh mechanism
- [ ] No accumulation of Noble characteristic objects or subscriptions
- [ ] Metrics track session reuse for monitoring
- [ ] E2E tests pass consistently without zombie connections
- [ ] All validation gates pass (lint, typecheck, build, tests)

## All Needed Context

### Documentation & References
```yaml
# MUST READ - Include these in your context window
- file: src/bridge-server.ts
  lines: 125-143
  why: Contains the refreshCharacteristics() call that must be removed
  critical: This call triggers the problematic method

- file: src/noble-transport.ts  
  lines: 408-463
  why: Contains the refreshCharacteristics() method that must be deleted entirely
  critical: Each discoverCharacteristicsAsync() creates new objects - fundamentally unsafe

- file: src/ble-session.ts
  lines: 125-135
  why: Contains the session wrapper that must be removed
  critical: This wrapper enables the problematic call

- file: src/connection-metrics.ts
  lines: 94-100
  why: Shows existing session reuse tracking pattern to extend
  critical: Need to add recordSessionReuseWithoutRefresh() method

- file: tests/e2e/session-management.spec.ts
  why: E2E tests that validate session reuse behavior
  critical: Must continue passing after removing refresh entirely

- docfile: CLAUDE.md
  lines: 40-45, 134-135
  why: Noble.js async patterns and "DELETE don't deprecate" principle
  critical: Use ONLY async/await patterns, delete problematic code don't avoid it
```

### Current Codebase Structure (relevant files)
```bash
src/
├── bridge-server.ts     # Remove refresh call (line 132)
├── noble-transport.ts   # DELETE refreshCharacteristics method (lines 408-463) 
├── ble-session.ts      # DELETE refreshCharacteristics wrapper (lines 127-133)
├── connection-metrics.ts # Add new tracking method
└── session-manager.ts   # Session reuse logic (reference existing pattern)

tests/
├── e2e/session-management.spec.ts  # Must continue passing
└── unit/                           # Unit tests to verify no regressions
```

### Known Gotchas & Library Quirks
```typescript
// CRITICAL: Noble.js characteristic lifecycle
// discoverCharacteristicsAsync() ALWAYS creates NEW objects - there's no "refresh existing"
// Multiple objects for same BLE characteristic = subscription accumulation
// refreshCharacteristics() is FUNDAMENTALLY unsafe - always causes problems

// CRITICAL: CLAUDE.md principle - "DELETE don't deprecate"
// Don't keep dead code or commented code
// Remove the entire method and all references

// CRITICAL: Session reuse already works safely
// Line src/session-manager.ts:99 shows successful session reuse
// Existing characteristic references continue working fine

// CRITICAL: If characteristics become stale (shouldn't happen)
// Proper solution: create NEW session, not refresh existing characteristics
// Trust stable BLE connections per user requirements

// CRITICAL: MetricsTracker singleton pattern
// Use MetricsTracker.getInstance() to get the instance
// Follow existing pattern in connection-metrics.ts lines 95-100

// CRITICAL: Package manager - use pnpm EXCLUSIVELY
// NEVER use npm, npx, or yarn
```

## Implementation Blueprint

### Task 1: Remove refreshCharacteristics Method from Noble Transport
```yaml
MODIFY src/noble-transport.ts:
  - DELETE entire refreshCharacteristics method (lines 408-463)
  - REMOVE method from class - complete elimination
  - DO NOT leave comments or traces
  - PRESERVE all other methods unchanged
```

### Task 2: Remove refreshCharacteristics Wrapper from BLE Session
```yaml
MODIFY src/ble-session.ts:
  - DELETE entire refreshCharacteristics method (lines 127-133)
  - REMOVE method from class interface
  - DO NOT leave comments or traces
  - PRESERVE all other session methods
```

### Task 3: Remove refreshCharacteristics Call from Bridge Server
```yaml
MODIFY src/bridge-server.ts:
  - FIND lines 131-137: the try/catch block calling refreshCharacteristics()
  - REPLACE with: trust existing transport without any refresh
  - ADD console.log for session reuse without refresh
  - ADD metrics tracking call
  - PRESERVE all other session reuse logic
```

### Task 4: Add Metrics Method for Session Reuse Tracking  
```yaml
MODIFY src/connection-metrics.ts:
  - FIND existing recordSessionReuse method around line 95
  - ADD new method: recordSessionReuseWithoutRefresh(sessionId: string)
  - FOLLOW existing pattern for session reuse tracking
  - LOG warning if session reused more than 10 times
  - UPDATE interface if needed
```

### Detailed Implementation

#### Task 1 Pseudocode:
```typescript
// In src/noble-transport.ts - DELETE ENTIRE METHOD
// Remove lines 408-463 completely
// DO NOT replace with anything - complete removal
// The method is fundamentally unsafe and cannot be fixed
```

#### Task 2 Pseudocode:
```typescript
// In src/ble-session.ts - DELETE ENTIRE METHOD  
// Remove lines 127-133 completely
// DO NOT replace with anything - complete removal
// This wrapper enabled the problematic call
```

#### Task 3 Pseudocode:
```typescript
// In src/bridge-server.ts around line 125-143
if (status.hasTransport) {
  // Session has existing transport - reuse it WITHOUT any refresh
  console.log(`[Bridge] Session ${sessionId} has existing transport, reusing connection to ${status.deviceName || 'unnamed'} without refresh`);
  deviceName = status.deviceName || 'unnamed';
  
  // Track session reuse without refresh for monitoring
  MetricsTracker.getInstance().recordSessionReuseWithoutRefresh(sessionId);
  
  // Trust existing characteristic references - no refresh needed or possible
  console.log(`[Bridge] Trusting existing characteristics for session ${sessionId}`);
}
```

#### Task 4 Pseudocode:
```typescript
// In src/connection-metrics.ts, add method after line 100
recordSessionReuseWithoutRefresh(sessionId: string): void {
  this.metrics.totalReconnections++;
  const count = this.metrics.reconnectionsPerSession.get(sessionId) || 0;
  const newCount = count + 1;
  this.metrics.reconnectionsPerSession.set(sessionId, newCount);
  
  // Log warning if session reused many times (potential staleness)
  if (newCount > 10) {
    console.warn(`[Metrics] Session ${sessionId} reused ${newCount} times - monitor for characteristic staleness`);
  }
}
```

### Integration Points
```yaml
METRICS:
  - add to: MetricsTracker class
  - pattern: Follow existing recordSessionReuse method
  - purpose: Track session reuse without refresh for monitoring

LOGGING:
  - add to: bridge-server.ts session reuse block
  - pattern: Use existing console.log format with [Bridge] prefix
  - purpose: Visibility into session reuse without refresh

TESTS:
  - verify: tests/e2e/session-management.spec.ts continues passing
  - verify: No new test failures in unit tests
  - ensure: Zombie connections are eliminated

CLEANUP:
  - remove: All references to refreshCharacteristics
  - remove: All refresh-related code and comments
  - result: Clean codebase with problematic pattern eliminated
```

## Validation Loop

### Level 1: Syntax & Style
```bash
# Run these FIRST - fix any errors before proceeding
pnpm run lint              # ESLint with auto-fix
pnpm run typecheck         # TypeScript type checking

# Expected: No errors. If errors, READ the error and fix.
# May need to remove imports or references to deleted method
```

### Level 2: Unit Tests
```bash
# Run unit tests to ensure no regressions
pnpm run test:unit

# Expected: All unit tests pass
# If failing: Check if tests were calling refreshCharacteristics - remove those calls
```

### Level 3: Integration & E2E Tests
```bash
# Run E2E tests to verify session reuse works without refresh
pnpm run test:e2e

# Focus on session-management.spec.ts - this must pass
# Expected: Session reuse test passes without any refresh mechanism
# If failing: Check console logs for session reuse behavior
```

### Level 4: Build & Service Restart
```bash
# Build the project
pnpm run build

# Restart PM2 service to load changes
pnpm build && pnpm pm2:restart

# Expected: Clean build and successful service restart
```

### Level 5: Manual Verification
```bash
# Check service status
pnpm pm2:status

# View metrics to confirm tracking
pnpm run metrics

# Expected: Service running, metrics showing session reuse without refresh
```

## Final Validation Checklist
- [ ] All tests pass: `pnpm run test`
- [ ] No linting errors: `pnpm run lint`  
- [ ] No type errors: `pnpm run typecheck`
- [ ] Build succeeds: `pnpm run build`
- [ ] E2E tests pass: `pnpm run test:e2e`
- [ ] Session reuse works without any refresh mechanism
- [ ] No zombie connection warnings in logs
- [ ] Metrics track session reuse properly
- [ ] Service restarts cleanly: `pnpm pm2:restart`
- [ ] No references to refreshCharacteristics remain in codebase

---

## Anti-Patterns to Avoid
- ❌ Don't keep the method "just in case" - it's fundamentally unsafe
- ❌ Don't leave commented code or TODO comments about refresh
- ❌ Don't try to "fix" the method - deletion is the only safe approach
- ❌ Don't change session management logic - only remove refresh capability
- ❌ Don't skip metrics tracking - monitoring is critical
- ❌ Don't ignore E2E test results - they validate the fix
- ❌ Don't use npm/npx - always use pnpm
- ❌ Don't create alternative refresh mechanisms - trust existing characteristics

## Risk Mitigation & Rationale
- **Why Complete Removal**: refreshCharacteristics() is fundamentally unsafe - Noble.js only creates new objects, never refreshes existing ones
- **If Characteristics Become Stale**: Create a new session instead of trying to refresh - this is the proper BLE pattern
- **Trust Stable Connections**: Per user requirements, BLE connections are stable - characteristic staleness should not occur
- **Monitoring**: Metrics will detect excessive session reuse for investigation
- **Testing**: E2E tests validate that existing characteristics continue working indefinitely
- **Clean Architecture**: Removing unsafe patterns prevents future bugs and makes codebase more maintainable