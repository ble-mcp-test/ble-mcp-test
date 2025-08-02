name: "Timeout Stabilization & Zombie Connection Elimination - Context-Rich with Validation Loops (TypeScript/Node.js)"
description: |
  Eliminate zombie BLE connections through enhanced timeout cleanup processes that verify Noble.js resource
  state and device availability, preventing scenarios where SessionManager reports disconnected but Noble
  maintains active BLE connections.

---

## Goal
Eliminate zombie BLE connections by enhancing grace period and idle timeout cleanup processes to include Noble.js resource verification and device availability scanning, ensuring complete session lifecycle management.

## Why
- **Zombie Connection Problem**: Sessions show as disconnected in SessionManager but Noble.js still maintains BLE connection, preventing reconnection
- **Incomplete Cleanup**: Current timeout processes don't verify that Noble.js resources (peripherals, listeners, HCI connections) are actually released
- **Device State Unknown**: No verification that BLE device is still available/responsive during cleanup operations
- **Production Reliability**: TrakRF and E2E test users need bulletproof connection lifecycle management
- **Recent Improvements**: Previous fixes enhanced grace/idle coordination but need deeper Noble.js integration

## What
Transform timeout cleanup from simple timer-based disconnection to comprehensive resource verification:

### Current Flow (Incomplete):
```
Grace/Idle timeout expires → Disconnect transport → Clear timers → Emit cleanup event
```

### Enhanced Flow (Comprehensive):
```
Grace/Idle timeout expires → Scan Noble resources → Verify device availability → 
Aggressive cleanup if needed → Confirm resource release → Log status → Emit cleanup event
```

### Success Criteria
- [ ] Zero zombie connections where SessionManager != Noble.js state
- [ ] Timeout cleanup verifies Noble.js peripheral/listener cleanup  
- [ ] Device availability verification during cleanup operations
- [ ] Enhanced logging for debugging timeout edge cases
- [ ] Graceful degradation when device becomes unavailable
- [ ] All existing E2E tests pass with enhanced cleanup
- [ ] Future-ready for user notification system

## All Needed Context

### Documentation & References
```yaml
# MUST READ - Include these in your context window
- file: /home/mike/ble-mcp-test/src/ble-session.ts
  why: Current timeout implementation with grace/idle coordination - need to enhance cleanup methods
  
- file: /home/mike/ble-mcp-test/src/noble-transport.ts  
  why: Noble.js resource management patterns, forceCleanup implementation, listener cleanup
  
- file: /home/mike/ble-mcp-test/scripts/check-device-available.js
  why: Device availability scanning pattern to integrate into timeout cleanup
  
- file: /home/mike/ble-mcp-test/docs/NOBLE-DISCOVERASYNC-LEAK.md
  why: Critical Noble.js listener leak issues and cleanup patterns to avoid
  
- file: /home/mike/ble-mcp-test/docs/HIGH-LOAD-ANALYSIS.md
  why: System load impact on BLE operations, timing sensitivity on Linux
  
- file: /home/mike/ble-mcp-test/listener-leak-analysis.md
  why: Specific resource pressure and cleanup strategies already implemented
  
- file: /home/mike/ble-mcp-test/src/session-manager.ts
  why: Session lifecycle management and stale session cleanup patterns
  
- url: https://github.com/noble/noble/issues/363
  why: Persistent services/characteristics across disconnect/reconnect patterns
  
- url: https://github.com/noble/noble/issues/268  
  why: Connection drops and LMP Response Timeout handling best practices
  
- url: https://www.npmjs.com/package/noble-connection-timeout
  section: Timeout wrapper implementation patterns
  critical: Manual timeout handling since Noble has no built-in timeouts
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

### List of Tasks to Complete (In Order)

```yaml
Task 1: Enhance NobleTransport with resource verification
MODIFY src/noble-transport.ts:
  - ADD static method verifyResourceCleanup()
  - ADD static method getResourceState() 
  - ADD static method scanDeviceAvailability()
  - MIRROR pattern from scripts/check-device-available.js for scanning
  - USE existing forceCleanup() patterns for aggressive resource cleanup

Task 2: Enhance BleSession timeout cleanup
MODIFY src/ble-session.ts:
  - MODIFY cleanup() method at line 171
  - ADD Noble resource verification before transport.disconnect()
  - ADD device availability check during cleanup
  - ADD enhanced logging for resource state
  - PRESERVE existing grace/idle timer coordination

Task 3: Enhance SessionManager stale session detection  
MODIFY src/session-manager.ts:
  - MODIFY checkStaleSessions() method at line 143
  - ADD Noble resource state verification to stale session detection
  - ADD device availability verification for stuck sessions
  - PRESERVE existing periodic cleanup timer (30s interval)

Task 4: Add cleanup verification script
CREATE scripts/verify-cleanup.js:
  - MIRROR structure from scripts/check-device-available.js
  - ADD comprehensive resource state reporting
  - ADD device availability verification
  - USE existing Noble.js patterns for scanning and cleanup

Task 5: Enhance logging and monitoring
MODIFY src/ble-session.ts, src/session-manager.ts:
  - ADD resource state logging to all cleanup operations
  - ADD device availability status to session status reports
  - ADD timeout reason classification (grace vs idle vs stale vs zombie)
  - PRESERVE existing log buffer integration

Task 6: Add integration tests for timeout scenarios
CREATE tests/integration/timeout-stability.test.ts:
  - TEST zombie connection detection and cleanup
  - TEST device unavailable scenarios
  - TEST resource leak prevention
  - MIRROR patterns from tests/integration/session-manager-integration.test.ts
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

### Level 1: Syntax & Type Checking (MUST PASS)
```bash
pnpm run lint && pnpm run typecheck
# Expected: No errors. Fix any TypeScript or ESLint issues before proceeding.
```

### Level 2: Unit Tests (MUST PASS)
```bash
pnpm run test
# Expected: All existing tests pass. New resource verification logic doesn't break existing functionality.
```

### Level 3: Integration Tests (MUST PASS)  
```bash
pnpm run test:integration
# Expected: Session management and connection lifecycle tests pass with enhanced cleanup.
```

### Level 4: E2E Tests (MUST PASS)
```bash
pnpm run test:e2e
# Expected: Playwright E2E tests pass, demonstrating stable connection lifecycle.
```

### Level 5: Resource Verification (NEW)
```bash
# Test new cleanup verification script
node scripts/verify-cleanup.js
# Expected: Reports clean Noble resource state with no leaked peripherals/listeners.

# Test device availability verification  
BLE_MCP_DEVICE_IDENTIFIER=CS108 node scripts/verify-cleanup.js --check-device
# Expected: Device found and responsive, or clear unavailable status.
```

### Level 6: Stress Testing (MANUAL)
```bash
# Run zombie connection stress test
pnpm run test:stress -- --grep "zombie"
# Expected: No zombie connections persist after stress test completion.

# Run resource leak detection
pnpm run test:stress -- --grep "resource"  
# Expected: Noble resource counts return to baseline after test completion.
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

## Migration and Deployment

### Backward Compatibility
- All existing session management APIs remain unchanged
- Enhanced logging is additive, doesn't break existing patterns
- Cleanup verification runs alongside existing cleanup, not replacing it

### Configuration
- New environment variables for timeout tuning:
  - `BLE_CLEANUP_VERIFICATION_TIMEOUT` (default: 3000ms)
  - `BLE_DEVICE_AVAILABILITY_TIMEOUT` (default: 5000ms) 
  - `BLE_RESOURCE_CLEANUP_AGGRESSIVE` (default: false)

### Rollout Strategy
1. Deploy with enhanced logging enabled for monitoring
2. Verify resource cleanup improvements in production logs
3. Enable aggressive cleanup mode after confidence established
4. Add user notification system for device unavailability (future)

This comprehensive approach eliminates zombie connections while maintaining the stability and performance that TrakRF and E2E testing users depend on.