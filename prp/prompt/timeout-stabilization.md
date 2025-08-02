name: "Timeout Stabilization and Zombie Connection Cleanup"
description: |
  Stabilize timeout handling throughout the BLE-MCP bridge to eliminate zombie connections, ensure proper Noble resource cleanup, and provide robust connection lifecycle management with comprehensive device availability scanning.

## Core Principles
1. **Context is King**: Include ALL necessary documentation, examples, and caveats
2. **Validation Loops**: Provide executable tests/lints the AI can run and fix
3. **Information Dense**: Use keywords and patterns from the codebase
4. **Progressive Success**: Start simple, validate, then enhance
5. **Global rules**: Be sure to follow all rules in CLAUDE.md

---

## Goal
Eliminate zombie connections and stabilize timeout handling across grace periods, idle disconnects, and Noble resource cleanup while ensuring E2E tests continue to pass and implementing the specific fixes identified in the timeout-stabilization spec.

## Why
- **Business value**: TrakRF and E2E test users continue to see connection issues that block testing
- **User impact**: Zombie connections prevent device reconnection and cause test failures  
- **Problems this solves**:
  - Grace and idle timeout processes leave zombie Noble connections active
  - Connection pooling reports "no connection" but Noble still has active connection
  - Device availability checks are inconsistent after timeout cleanup
  - Resource leaks accumulate during stress testing
  - E2E tests fail due to connection state inconsistencies
  - Recent server stabilization fixes need thorough testing validation

## What
Implement comprehensive timeout stabilization with the specific fixes from the timeout-stabilization spec:
1. Archive deterministic session PRP documentation (completed feature)
2. Thoroughly test recent server stabilization fixes
3. Carefully review grace and idle timeout process flow for zombie connection issues
4. Enhance grace and idle disconnects to check for any remaining Noble resources and clean them up
5. Add timeout cleanup scanner that confirms device is available after cleanup
6. Add user notification capability for unavailable devices (future enhancement)

### Success Criteria
- [ ] All E2E tests pass consistently (no zombie connection failures)
- [ ] Grace period cleanup verifies Noble resources are actually freed
- [ ] Idle timeout scanner confirms device availability after cleanup
- [ ] Connection pooling state matches actual Noble connection state
- [ ] Stress tests show no resource leak accumulation
- [ ] Device reconnection works reliably after timeout cleanup
- [ ] Timeout processes include user notification capability for unavailable devices
- [ ] Deterministic session PRP docs properly archived

## All Needed Context

### Documentation & References
```yaml
# CRITICAL EXTERNAL CONTEXT - Noble.js Issues & Patterns
- url: https://github.com/noble/noble/issues/636
  why: Documents memory leak issues in Noble.js with UUID array growth and peripheral caching
  critical: "UUID is pushed into an array, but nothing ever removes them. Peripheral objects accumulate in hashes by UUID"
  
- url: https://github.com/noble/noble/issues/244  
  why: EventEmitter memory leak - "possible EventEmitter memory leak detected. 11 read listeners added"
  pattern: "dev.on('disconnect',onDisconnect); function onDisconnect() { dev.off('disconnect',onDisconnect); }"
  
- url: https://github.com/noble/noble/issues/363
  why: Persistent services issue - "Noble cleans up the GATT instance on disconnect to save memory"
  critical: "The list of GATT handles in the master object is removed after a disconnect"

- url: https://punchthrough.com/manage-ble-connection/
  why: BLE Connection Management Guide - timeout configuration best practices
  timeout_ranges: "Supervision Timeout 100ms-32s, Connection Interval <100ms default"
  power_trade_offs: "Longer connection interval + higher peripheral latency = lower power but higher latency"

- url: https://medium.com/@amr258144/connection-pooling-in-node-js-ea4421c72dc
  why: Node.js connection pooling patterns applicable to BLE resource management
  patterns: "Connection timeout ~2s, idle timeout 30s, wait queue management"

# CODEBASE CRITICAL FILES
- file: src/ble-session.ts
  why: Contains current grace period and idle timeout implementation
  critical: Lines 125-145 startGracePeriod(), 150-166 resetIdleTimer(), 171-212 cleanup()
  
- file: src/session-manager.ts  
  why: Session lifecycle management and stale session cleanup
  critical: Lines 133-164 checkStaleSessions(), 168-196 forceCleanupDevice()
  
- file: src/noble-transport.ts
  why: Noble resource management and cleanup patterns
  critical: Lines 285-326 forceCleanup(), 328-385 graceful cleanup(), 28-78 resetNobleStack()
  
- file: src/ws-handler.ts
  why: WebSocket lifecycle and force cleanup commands
  critical: Lines 111-138 handleForceCleanup(), session manager integration
  
- file: tests/integration/abrupt-disconnect.test.ts
  why: Shows current testing patterns for connection cleanup validation
  critical: Lines 86-106 cleanup verification, 107-147 device availability testing
  
- file: scripts/check-device-available.js
  why: Device availability scanning implementation
  critical: Lines 29-77 device discovery with timeout, 79-91 cleanup patterns
  
- file: docs/NOBLE-DISCOVERASYNC-LEAK.md
  why: Documents known Noble.js memory leak in discoverAsync() with scanStop listeners
  critical: "Each call to generator.next() adds 3 event listeners that are never cleaned up"
  workaround: "Remove all scanStop listeners after scan completion"
  
- file: LINUX_STABILITY_REPORT.md
  why: Current timeout configuration working well under stress
  config: "GRACE_PERIOD=60s, IDLE_TIMEOUT=300s, NOBLE_RESET_DELAY=5000ms"
  
- file: CLAUDE.md
  why: Project conventions - MANDATORY pnpm usage, E2E testing PRIMARY PURPOSE
  critical: "If it doesn't work with Playwright E2E tests, we have FAILED"

# FILES TO ARCHIVE
- file: prp/spec/deterministic-session-ids.md
  why: Completed feature that should be moved to archive
  action: "git mv to prp/archive/spec/"
  
- file: prp/prompt/deterministic-session-ids.md
  why: Completed PRP that should be moved to archive
  action: "git mv to prp/archive/prompt/"
```

### Current Codebase Structure
```bash
src/
├── ble-session.ts         # 241 lines - Timeout logic needs enhancement
├── noble-transport.ts     # 386 lines - Resource cleanup patterns
├── session-manager.ts     # 213 lines - Stale session detection
├── ws-handler.ts          # 172 lines - Force cleanup coordination  
├── utils.ts               # withTimeout utility for clean timeouts
└── scripts/
    └── check-device-available.js  # Device scanning pattern to integrate
```

### Desired Enhancement Points
```bash
src/
├── ble-session.ts         # Enhanced cleanup() and resetIdleTimer() methods
├── noble-transport.ts     # Add verifyResourceCleanup() method
├── session-manager.ts     # Enhanced checkStaleSessions() with device verification
└── scripts/
    └── verify-cleanup.js  # New standalone cleanup verification script
```

### Known Gotchas & Library Quirks
```typescript
// CRITICAL: Noble.js event listener accumulation (3 per discoverAsync call)
// Solution: aggressive removeAllListeners() after operations
noble.removeAllListeners('scanStop');

// CRITICAL: Peripheral objects persist in Noble's internal cache
// Solution: Access noble._peripherals and manually clear after disconnect

// CRITICAL: HCI-level listeners accumulate (25+ observed in stress tests)  
// Solution: Monitor noble.listenerCount('warning') and clean up

// CRITICAL: Linux BlueZ timing sensitivity under load
// Solution: Implement adaptive timeouts based on system load

// CRITICAL: Use @stoprocent/noble v0.1.14 exclusively
// Solution: ALWAYS await Noble operations, NEVER mix callbacks with promises

// CRITICAL: CS108 requires allowDuplicates: true which increases scan load
// Solution: Proper cleanup after each scan operation
```

## Implementation Blueprint

### Enhanced Resource Verification System

Add comprehensive Noble.js resource state verification to timeout cleanup:

```typescript
interface NobleResourceState {
  peripheralCount: number;
  listenerCounts: Record<string, number>;
  scanningActive: boolean;
  hciConnections: number;
  cacheSize: number;
}

class ResourceVerificationManager {
  static async verifyCleanup(deviceId?: string): Promise<NobleResourceState>;
  static async forceCleanupResources(deviceId?: string): Promise<void>;
  static async scanDeviceAvailability(devicePrefix: string, timeoutMs: number): Promise<boolean>;
}
```

### Device Availability Integration

Integrate device scanning pattern from check-device-available.js into timeout cleanup:

```typescript
// Pattern from scripts/check-device-available.js - lines 29-77
async function verifyDeviceAvailable(devicePrefix: string): Promise<boolean> {
  // Use existing patterns: noble.startScanningAsync([], true)
  // Implement timeout and cleanup like check-device-available.js
  // Return true if device responds, false if unavailable
}
```

### Implementation Order

```yaml
Task 1: Archive Completed Deterministic Session PRP Documentation
ACTION: Move completed feature files to archive
  - EXECUTE: git mv prp/spec/deterministic-session-ids.md prp/archive/spec/
  - EXECUTE: git mv prp/prompt/deterministic-session-ids.md prp/archive/prompt/
  - COMMIT: "docs: archive deterministic session PRP - feature completed"
  
Task 2: Enhance Noble Resource Verification in BleSession cleanup()
MODIFY src/ble-session.ts:
  - ENHANCE cleanup() method at lines 171-212
  - ADD verifyNobleCleanup() method with scanStop listener leak detection
  - ADD verifyDeviceAvailability() method using check-device-available.js pattern
  - ADD notifyDeviceStuck() method for user guidance
  - ADD progressive cleanup escalation (graceful → aggressive → manual intervention)

Task 3: Enhance NobleTransport with Resource Leak Detection
MODIFY src/noble-transport.ts:
  - ADD auditNobleResources() method for pre/post cleanup analysis
  - ENHANCE cleanup() method with resource leak detection
  - ENHANCE forceCleanup() method with aggressive listener cleanup
  - ADD scanStop listener cleanup (from docs/NOBLE-DISCOVERASYNC-LEAK.md patterns)

Task 4: Enhanced Session Manager with Zombie Detection
MODIFY src/session-manager.ts:
  - ADD performVerifiedCleanup() method with Noble resource verification
  - ADD verifySessionCleanup() method with device availability check
  - ADD triggerNobleReset() method for escalated cleanup
  - ENHANCE checkStaleSessions() with zombie session detection (hasTransport but not connected)

Task 5: Create Comprehensive Timeout Stabilization Tests
CREATE tests/integration/timeout-stabilization.test.ts:
  - TEST grace period timeout with Noble resource cleanup verification
  - TEST idle timeout with device availability confirmation
  - TEST zombie session detection and cleanup
  - USE shortened timeouts via environment variables for testing
  
Task 6: Add Testing Environment Configuration
MODIFY .env.local.example:
  - ADD BLE_SESSION_GRACE_PERIOD_SEC=5 for testing
  - ADD BLE_SESSION_IDLE_TIMEOUT_SEC=10 for testing
  - DOCUMENT timeout configuration for development vs production
```

## Code Examples and Patterns

### Noble Resource State Verification Pattern
```typescript
// Pattern from listener-leak-analysis.md and noble-transport.ts
static async getResourceState(): Promise<NobleResourceState> {
  return {
    peripheralCount: Object.keys((noble as any)._peripherals || {}).length,
    listenerCounts: {
      discover: noble.listenerCount('discover'),
      scanStop: noble.listenerCount('scanStop'),
      stateChange: noble.listenerCount('stateChange'),
      warning: noble.listenerCount('warning')
    },
    scanningActive: noble._discovering || false,
    hciConnections: (noble as any)._bindings?.listenerCount?.('warning') || 0
  };
}
```

### Device Availability Verification Pattern  
```typescript
// Mirror pattern from scripts/check-device-available.js lines 44-77
static async scanDeviceAvailability(devicePrefix: string, timeoutMs: number = 5000): Promise<boolean> {
  if (noble.state !== 'poweredOn') {
    await noble.waitForPoweredOnAsync();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      noble.removeAllListeners('discover');
      noble.stopScanningAsync().catch(() => {});
      resolve(false);
    }, timeoutMs);

    noble.on('discover', (peripheral) => {
      const id = peripheral.id;
      const name = peripheral.advertisement.localName || '';
      
      if (id.startsWith(devicePrefix) || name.startsWith(devicePrefix)) {
        clearTimeout(timeout);
        noble.removeAllListeners('discover');
        noble.stopScanningAsync().catch(() => {});
        resolve(true);
      }
    });

    noble.startScanningAsync([], true).catch(() => resolve(false));
  });
}
```

### Enhanced Cleanup Integration Pattern
```typescript
// Enhance existing cleanup() method in ble-session.ts around line 171
private async cleanup(reason: string, error?: any): Promise<void> {
  console.log(`[Session:${this.sessionId}] Starting enhanced cleanup (reason: ${reason})`);
  
  // Get initial resource state for logging
  const initialState = await NobleTransport.getResourceState();
  console.log(`[Session:${this.sessionId}] Initial Noble resources:`, initialState);
  
  // Check device availability if we have device info
  let deviceAvailable = false;
  if (this.deviceName && this.config?.devicePrefix) {
    deviceAvailable = await NobleTransport.scanDeviceAvailability(this.config.devicePrefix, 3000);
    console.log(`[Session:${this.sessionId}] Device ${this.deviceName} available: ${deviceAvailable}`);
  }

  // Standard cleanup (existing pattern)
  // ... existing timer and transport cleanup ...

  // Verify Noble resource cleanup
  await NobleTransport.verifyResourceCleanup(this.deviceName);
  
  // Final resource state verification
  const finalState = await NobleTransport.getResourceState();
  console.log(`[Session:${this.sessionId}] Final Noble resources:`, finalState);
  
  // Log cleanup summary
  const resourcesDelta = initialState.peripheralCount - finalState.peripheralCount;
  console.log(`[Session:${this.sessionId}] Cleanup complete - freed ${resourcesDelta} peripherals, device available: ${deviceAvailable}`);
  
  this.emit('cleanup', { sessionId: this.sessionId, reason, error, deviceAvailable, resourceState: finalState });
}
```

## Validation Gates

### Level 1: Syntax & Type Checking
```bash
# Run these FIRST - fix any errors before proceeding
pnpm run lint            # ESLint for code style
pnpm run typecheck       # TypeScript type checking

# Expected: No errors. If errors, READ the error and fix.
```

### Level 2: Unit Tests
```bash
# Run unit tests to verify basic functionality
pnpm run test:unit

# Expected: All unit tests passing
```

### Level 3: Integration Tests  
```bash
# Run integration tests including new timeout stabilization tests
pnpm run test:integration

# Expected: All integration tests passing, including timeout cleanup verification
```

### Level 4: E2E Tests (CRITICAL - PRIMARY PURPOSE)
```bash
# Critical: E2E tests must pass - this is the PRIMARY PURPOSE
pnpm exec playwright test

# Expected: All Playwright tests pass, session persistence works
# If E2E tests fail, we have FAILED the primary mission
```

### Level 5: Stress Tests
```bash
# Verify no resource leaks under stress
pnpm run test:stress

# Expected: No memory leaks, Noble listener counts stay low
# Watch for "MaxListenersExceededWarning" - should not occur
```

### Level 6: Manual Device Availability Test
```bash
# Test device scanning and availability detection
pnpm run check:device

# Expected: Device found and available
# If device not found, follow printed guidance for user actions
```

### Level 7: Timeout Cleanup Verification (NEW)
```bash
# Test timeout cleanup with short timeouts for development
BLE_SESSION_GRACE_PERIOD_SEC=5 BLE_SESSION_IDLE_TIMEOUT_SEC=10 pnpm run test:integration -- --grep "timeout"

# Expected: Timeout tests pass with proper Noble resource cleanup and device availability verification
# No zombie connections, Noble listener counts remain low
```

## Edge Cases and Error Handling

### Device Becomes Unavailable During Operation
- Cleanup should detect and log device unavailability
- No infinite retry loops waiting for unreachable devices
- Graceful session termination with proper error reporting

### Noble State Corruption Under Load
- Resource verification should detect corrupted state
- Aggressive cleanup with Noble stack reset if needed
- Fallback to noble.reset() for complete state restoration

### Concurrent Cleanup Operations
- Prevent multiple cleanup operations on same session
- Coordinate cleanup across session manager and individual sessions
- Atomic resource verification to prevent race conditions

### System Resource Exhaustion
- Detect high resource pressure using existing patterns
- Prioritize cleanup of oldest/stale sessions first
- Emergency cleanup mode for critical resource situations

## Success Metrics

### Functional Requirements
- [ ] Zero zombie connections in 100-session stress test
- [ ] Device availability correctly detected in 95%+ scenarios
- [ ] Resource leaks eliminated (Noble listener count returns to baseline)
- [ ] All existing E2E tests pass without modification

### Performance Requirements  
- [ ] Cleanup verification adds <500ms to session cleanup time
- [ ] Device availability check completes within 5s timeout
- [ ] No measurable impact on connection establishment speed
- [ ] Memory usage remains stable during extended operation

### Reliability Requirements
- [ ] Handles device power-off scenarios gracefully
- [ ] Recovers from Noble state corruption automatically
- [ ] Maintains stability under high CPU load (npm publish scenario)
- [ ] Prevents cascade failures when cleanup operations fail

## Error Handling Strategy

### Progressive Cleanup Escalation
1. **Graceful cleanup** - Standard timeout-based disconnect with Noble verification
2. **Verified cleanup** - Check Noble resources and device availability after graceful cleanup  
3. **Aggressive cleanup** - Force disconnect + Noble stack reset + comprehensive listener cleanup
4. **Manual intervention** - Log detailed instructions for user actions when automated cleanup fails

### Noble Resource Leak Prevention
- Monitor scanStop listener count (trigger cleanup when > 90, per docs/NOBLE-DISCOVERASYNC-LEAK.md)
- Monitor discover listener count (max 10 before cleanup)
- Clean up abandoned scan operations after device discovery
- Verify scanning state consistency after cleanup operations

### Device Availability Verification
- Quick scan after cleanup to verify device visibility (5s timeout max)
- Non-blocking verification - log for monitoring but don't fail cleanup
- Clear user guidance when device becomes unavailable
- Future-ready for user notification API integration

## Success Metrics

### Critical Success Indicators
- **Zero zombie connections** detected in monitoring logs
- **All E2E tests pass** consistently - this is the PRIMARY PURPOSE  
- **Noble listener counts** remain below thresholds under stress (scanStop < 90, discover < 10)
- **Device availability** verified after all timeout cleanup scenarios
- **Resource leak prevention** - no MaxListenersExceededWarning during extended testing

### Implementation Validation
- **Deterministic session PRP docs** properly archived to indicate feature completion
- **Grace period cleanup** verifies Noble resources are actually freed
- **Idle timeout scanner** confirms device availability after cleanup  
- **Connection pooling state** matches actual Noble connection state consistently
- **User notification capability** implemented for device unavailability scenarios

This comprehensive timeout stabilization ensures robust BLE connection lifecycle management while maintaining the tool's PRIMARY PURPOSE of reliable E2E testing with Playwright.