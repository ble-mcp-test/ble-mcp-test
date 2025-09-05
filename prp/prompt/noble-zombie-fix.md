name: "Noble Zombie Connection Fix - Complete BLE State Cleanup"
description: |

## Purpose
Fix incomplete Noble BLE cleanup that creates zombie connections, preventing device discovery. Build upon the existing `completeNobleReset()` implementation to ensure comprehensive cleanup and proper error reporting.

## Core Principles
1. **Context is King**: Noble is a singleton managing hardware - state must be pristine between connections
2. **Validation Loops**: Test zombie detection and recovery with real scenarios
3. **Information Dense**: Document Noble's internal state management quirks
4. **Progressive Success**: Cleanup has been partially implemented - complete remaining tasks
5. **Global rules**: Follow all rules in CLAUDE.md (use pnpm, never npm)

---

## Goal
Ensure Noble BLE stack is completely cleaned up on disconnect, preventing zombie connections that block device discovery. When zombies are detected, attempt recovery and provide clear, actionable error messages.

## Why
- Bridge server leaves Noble in corrupted state after disconnect
- Users experience "device not found" errors when device is actually available
- Only solution currently is restarting the entire service
- Affects all E2E tests and production usage with CS108 devices

## What
Complete the Noble cleanup implementation to:
1. Fully reset Noble state on every disconnect and connection failure
2. Detect zombie connections proactively
3. Attempt automatic recovery before failing
4. Provide clear error messages with recovery instructions
5. Update version to 0.5.15 with changelog

### Success Criteria
- [x] Noble state completely reset after disconnect (completeNobleReset implemented)
- [x] WebSocket error codes 4001-4005 implemented
- [ ] Zombie detection triggers recovery attempt
- [ ] Clear error message when zombie cannot be recovered
- [ ] Version bumped to 0.5.15
- [ ] Changelog updated
- [ ] Tests verify zombie prevention

## All Needed Context

### Documentation & References
```yaml
# Noble.js internals and state management
- url: https://github.com/abandonware/noble/blob/master/lib/noble.js
  why: Understanding Noble's singleton state and internal caches (_peripherals, _services, etc.)
  
- file: src/noble-transport.ts
  why: Current implementation with completeNobleReset() already added
  critical: Lines 105-146 contain the completeNobleReset implementation
  
- file: src/constants.ts
  why: WebSocket close codes already implemented (4001-4005)
  critical: BLEConnectionError class and error mapping already exist

- file: src/session-manager.ts
  why: Zombie detection and cleanup logic
  critical: Lines 179-203 handle zombie detection with ZombieDetector

- file: src/zombie-detector.ts
  why: Existing zombie detection implementation
  critical: checkForZombie() method with severity levels

- doc: prp/spec/ble-mcp-test-zombie-fix.md
  why: Original specification with requirements
```

### Current State Analysis
```typescript
// ALREADY IMPLEMENTED:
// 1. completeNobleReset() in noble-transport.ts:105-146
//    - Clears all Noble JavaScript state
//    - Removes all event listeners
//    - Resets to pristine state

// 2. WebSocket error codes in constants.ts:8-23
//    - HARDWARE_NOT_FOUND: 4001
//    - GATT_CONNECTION_FAILED: 4002 (for zombies)
//    - SERVICE_NOT_FOUND: 4003
//    - CHARACTERISTICS_NOT_FOUND: 4004
//    - BLE_DISCONNECTED: 4005

// 3. Noble reset on disconnect in noble-transport.ts:789-795
//    - Calls completeNobleReset() after every disconnect

// 4. Noble reset on failure in noble-transport.ts:396-401
//    - Calls completeNobleReset() after connection failures

// STILL NEEDED:
// 1. Wait for peripheral disconnect event before marking as disconnected
// 2. Specific zombie error message
// 3. Recovery attempt before rejection
// 4. Version bump to 0.5.15
// 5. Changelog entry
```

### Known Gotchas & Library Quirks
```typescript
// CRITICAL: Noble maintains singleton state in JavaScript, not native code
// - Process restart clears state, so we mimic this with completeNobleReset()
// - Noble._peripherals accumulates without bounds
// - Event listeners leak if not removed properly
// - peripheral.disconnect() is async but doesn't always emit 'disconnect' event

// GOTCHA: Noble's disconnect can hang
// - Must use timeout when waiting for disconnect event
// - After timeout, force cleanup anyway

// GOTCHA: WebSocket close codes 4000-4999 are application-specific
// - We use 4002 for zombie/GATT failures per spec
```

## Implementation Blueprint

### Tasks to Complete (in order)

```yaml
Task 1: Enhance disconnect to wait for event
MODIFY src/noble-transport.ts:
  - FIND: async disconnect(): Promise<void>
  - ENHANCE: Wait for peripheral 'disconnect' event with timeout
  - PATTERN: Use Promise.race with timeout like in cleanup()

Task 2: Add zombie-specific error handling
MODIFY src/ble-session.ts:
  - FIND: connect() method error handling
  - ADD: Zombie detection before throwing error
  - EMIT: WebSocket code 4002 with specific message

Task 3: Implement recovery attempt
MODIFY src/session-manager.ts:
  - FIND: checkStaleSessions zombie detection
  - ENHANCE: When zombie detected, attempt recovery
  - CALL: NobleTransport.completeNobleReset() for recovery

Task 4: Add specific zombie error message
MODIFY src/constants.ts:
  - ADD: ZOMBIE_STATE error code if not present
  - UPDATE: Error messages with actionable instructions
  - MESSAGE: "BLE connection in zombie state - restart ble-mcp-test service"

Task 5: Update version to 0.5.15
MODIFY package.json:
  - CHANGE: version from 0.5.14 to 0.5.15

Task 6: Update changelog
MODIFY CHANGELOG.md:
  - ADD: Entry for 0.5.15 with zombie fix details
  - INCLUDE: All improvements made

Task 7: Create CS108 commands constants
CREATE src/cs108-commands.ts:
  - DEFINE: Common CS108 command bytes
  - EXPORT: getBatteryVoltageCommand() function
  - PATTERN: Follow existing constants.ts pattern

Task 8: Replace duplicate command definitions
MODIFY tests/e2e/zombie-reproduction.spec.ts:
  - IMPORT: CS108 commands from constants
  - REPLACE: hardcoded batteryCmd with imported constant
  
MODIFY tests/e2e/malformed-command-test.spec.ts:
  - IMPORT: CS108 commands from constants
  - REPLACE: validBatteryCmd with imported constant
  
MODIFY tests/integration/*.test.ts:
  - FIND: All files with battery command bytes
  - REPLACE: with imported constants

Task 9: Add zombie recovery test
CREATE tests/integration/zombie-recovery.test.ts:
  - TEST: Create zombie state
  - VERIFY: Recovery is attempted
  - CHECK: Error message is actionable
  - USE: CS108 command constants
```

### Pseudocode for Key Changes

```typescript
// Task 7: CS108 Commands Constants
// src/cs108-commands.ts
export const CS108_COMMANDS = {
  // Header bytes that all commands start with
  HEADER: [0xA7, 0xB3],
  
  // Common command codes
  BATTERY_VOLTAGE: 0xA000,
  INVENTORY_START: 0x8001,
  INVENTORY_STOP: 0x8100,
} as const;

export function getBatteryVoltageCommand(): Uint8Array {
  // Full battery voltage command with checksum
  return new Uint8Array([
    0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00
  ]);
}

export function createCommand(commandCode: number, data?: number[]): Uint8Array {
  // Helper to create CS108 commands with proper format
  // Implementation would calculate checksum, etc.
}

// Task 1: Enhanced disconnect with event wait
async disconnect(): Promise<void> {
  if (this.peripheral && this.peripheral.state === 'connected') {
    // Wait for disconnect event with timeout
    await Promise.race([
      new Promise<void>((resolve) => {
        this.peripheral.once('disconnect', () => {
          console.log('[Noble] Disconnect event received');
          resolve();
        });
        this.peripheral.disconnectAsync().catch(() => {});
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          console.warn('[Noble] Disconnect event timeout - forcing cleanup');
          resolve();
        }, 5000);
      })
    ]);
  }
  
  // Always do complete cleanup
  await this.cleanup({ force: false, verifyResources: true });
  await NobleTransport.completeNobleReset();
}

// Task 2: Zombie-specific error
catch (error) {
  // Check if Noble is in zombie state
  const zombieResult = ZombieDetector.getInstance().checkForZombie();
  if (zombieResult.isZombie) {
    throw new BLEConnectionError(
      'GATT_CONNECTION_FAILED',
      'BLE connection in zombie state - restart ble-mcp-test service'
    );
  }
  // ... existing error handling
}

// Task 3: Recovery attempt in SessionManager
if (zombieResult.isZombie && zombieResult.severity === 'high') {
  console.log('[SessionManager] Attempting zombie recovery...');
  // Try complete Noble reset
  await NobleTransport.completeNobleReset();
  
  // Test if recovery worked by attempting scan
  const canScan = await NobleTransport.checkDeviceAvailability(devicePrefix, 2000);
  if (canScan) {
    console.log('[SessionManager] Zombie recovery successful!');
  } else {
    console.error('[SessionManager] Zombie recovery failed - service restart required');
  }
}
```

### Integration Points
```yaml
ERROR_CODES:
  - Use: GATT_CONNECTION_FAILED (4002) for zombie states
  - Message: Must be actionable - tell user to restart service
  
MCP_TOOLS:
  - check_zombie: Already implemented, returns zombie state
  - get_metrics: Shows zombieConnectionsDetected count
  
TESTS:
  - tests/e2e/zombie-reproduction.spec.ts: Existing zombie test
  - Add: Recovery verification to test suite
```

## Validation Loop

### Level 1: Syntax & Style
```bash
# Fix any TypeScript and lint errors
pnpm run lint
pnpm run typecheck

# Expected: No errors
```

### Level 2: Build Verification
```bash
# Build the project
pnpm run build

# Verify Noble changes are compiled
ls -la dist/noble-transport.js | grep -E "[0-9]+ bytes"

# Expected: File exists and is not empty
```

### Level 3: Unit Tests
```bash
# Run existing tests
pnpm run test

# Focus on transport tests
pnpm run test noble-transport

# Expected: All passing
```

### Level 4: Integration Tests
```bash
# Test zombie recovery
pnpm exec playwright test zombie-reproduction.spec.ts

# Test session management
pnpm exec playwright test session-management.spec.ts

# Expected: Tests pass with new recovery behavior
```

### Level 5: Manual Verification
```bash
# 1. Start the service
pnpm pm2:restart

# 2. Check device availability
pnpm run check:device

# 3. Connect and disconnect multiple times
# (Use a test client or E2E tests)

# 4. Check for zombies
curl http://localhost:8081/mcp/tool/check_zombie

# Expected: No zombies after multiple connect/disconnect cycles
```

## Final Validation Checklist
- [ ] All tests pass: `pnpm run test`
- [ ] No linting errors: `pnpm run lint`
- [ ] No type errors: `pnpm run typecheck`
- [ ] Build succeeds: `pnpm run build`
- [ ] E2E tests pass: `pnpm exec playwright test`
- [ ] No zombie connections after 10+ connect/disconnect cycles
- [ ] Error messages are clear and actionable
- [ ] Version updated to 0.5.15
- [ ] Changelog documents all changes
- [ ] MCP tools report zombie state correctly
- [ ] CS108 command constants used consistently
- [ ] No duplicate command definitions in tests

---

## Anti-Patterns to Avoid
- ❌ Don't skip the disconnect event wait - it's important for cleanup
- ❌ Don't ignore timeout scenarios - Noble can hang
- ❌ Don't clear Noble state during active connections
- ❌ Don't use npm/npx - always use pnpm
- ❌ Don't create new error codes - use existing 4002 for zombies
- ❌ Don't forget to update version and changelog

## Implementation Confidence Score
**9.5/10** - The core fix (`completeNobleReset()`) is already implemented and being called. Remaining tasks are minor:
- Adding error messages (trivial)
- Creating CS108 constants file (straightforward refactor)
- Version bump and changelog (administrative)

The only minor uncertainty (0.5%) is ensuring test expectations align with the fixed behavior.