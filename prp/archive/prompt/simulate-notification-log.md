name: "PRP for simulate-notification-log - Enhanced Debugging for BLE Mock Testing"
description: |

## Purpose
Add comprehensive logging to the simulateNotification method in the BLE mock testing API to improve debugging capabilities and provide clear visibility into notification simulation events.

## Core Principles
1. **Context is King**: Include ALL necessary documentation, examples, and caveats
2. **Validation Loops**: Provide executable tests/lints the AI can run and fix
3. **Information Dense**: Use keywords and patterns from the codebase
4. **Progressive Success**: Start simple, validate, then enhance
5. **Global rules**: Be sure to follow all rules in CLAUDE.md

---

## Goal
Add detailed console logging to the simulateNotification method that clearly shows:
- When a notification is being dispatched with full details (characteristic UUID, data length, hex data)
- Confirmation that the notification event was successfully dispatched
- This provides essential debugging visibility for a test utility

## Why
- **Debugging purpose**: The whole point of ble-mcp-test is to help diagnose BLE communication issues
- **Test-only tool**: Not user-facing, so verbose logging isn't a UX concern
- **Development environment**: Tests benefit from instrumentation by default
- **No performance concerns**: Test tools can be verbose without impacting production
- **Issue diagnosis**: When trigger simulation fails, detailed logs are essential to identify where the problem occurs

## What
Add two console.log statements to the simulateNotification method in src/mock-bluetooth.ts:
1. Log at the beginning showing notification dispatch details
2. Log at the end confirming successful dispatch

### Success Criteria
- [x] Console logs added to simulateNotification method
- [x] Logs show characteristic UUID, data length, and hex-formatted data
- [x] All existing tests continue to pass
- [x] TypeScript compilation succeeds with no errors
- [x] ESLint passes with no errors
- [x] Browser bundle builds successfully
- [x] CHANGELOG.md updated to reflect the change in v0.7.2
- [x] E2E tests that use simulateNotification show the new logs

## All Needed Context

### Documentation & References
```yaml
# MUST READ - Include these in your context window
- file: /home/mike/ble-mcp-test/src/mock-bluetooth.ts
  why: Main file to modify - contains simulateNotification method at line 465
  
- file: /home/mike/ble-mcp-test/tests/e2e/notification-simulation.spec.ts
  why: E2E tests that verify simulateNotification works correctly
  
- file: /home/mike/ble-mcp-test/tests/unit/testing-api.test.ts
  why: Unit tests for the testing API including simulateNotification

- file: /home/mike/ble-mcp-test/CLAUDE.md
  why: Project conventions - use pnpm, never npm/npx
  
- file: /home/mike/ble-mcp-test/CHANGELOG.md
  why: Need to update for v0.7.2 (not yet published)
```

### Current Codebase Structure (relevant files)
```bash
src/
├── mock-bluetooth.ts     # Contains simulateNotification method (line 465)
└── ws-transport.ts       # WebSocket transport (imported by mock-bluetooth)

tests/
├── e2e/
│   ├── notification-simulation.spec.ts  # E2E tests for notification simulation
│   └── test-config.ts                   # Test helpers including testSimulateNotification
└── unit/
    └── testing-api.test.ts              # Unit tests for testing API
```

### Existing Code Context

Current simulateNotification implementation (src/mock-bluetooth.ts:465-490):
```typescript
simulateNotification: async (options: SimulateNotificationOptions): Promise<void> => {
  // Delay handling
  if (options.delay && options.delay > 0) {
    await new Promise(resolve => setTimeout(resolve, options.delay));
  }
  
  // Directly update the characteristic value and dispatch the event
  const characteristic = options.characteristic as any;
  
  // Update the characteristic's value
  characteristic.value = new DataView(options.data.buffer);
  
  // Create and dispatch the characteristicvaluechanged event
  const event = new CustomEvent('characteristicvaluechanged', {
    detail: { target: characteristic }
  });
  
  // Set the target property on the event
  Object.defineProperty(event, 'target', {
    value: { value: characteristic.value },
    writable: false
  });
  
  // Dispatch the event
  characteristic.dispatchEvent(event);
},
```

Existing toHex utility (src/mock-bluetooth.ts:493):
```typescript
toHex: (data: Uint8Array): string => {
  return Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
},
```

### Known Gotchas
```typescript
// CRITICAL: Must use pnpm - NEVER use npm or yarn commands
// Example: pnpm run test, NOT npm test

// PATTERN: Existing console.log patterns in the codebase use prefixes like:
// console.log('[MockBluetooth] ...') 
// console.log('[MockGATT] ...')
// We'll use: console.log('ble-mcp-test: ...') as specified

// NOTE: The characteristic object has a uuid property that contains the UUID string
// NOTE: Array.from() is used to convert Uint8Array to regular array for mapping
```

## Implementation Blueprint

### Task List

```yaml
Task 1:
MODIFY src/mock-bluetooth.ts:
  - FIND simulateNotification method (line 465)
  - ADD first console.log after delay handling (around line 469)
  - ADD second console.log after dispatchEvent (around line 489)
  - PRESERVE all existing functionality

Task 2:
UPDATE CHANGELOG.md:
  - FIND version 0.7.2 section
  - ADD entry about enhanced logging for simulateNotification
  - KEEP existing 0.7.2 entries (version not yet published)

Task 3:
VALIDATE implementation:
  - RUN pnpm run lint
  - RUN pnpm run typecheck
  - RUN pnpm run build
  - RUN pnpm run test:e2e (subset that tests notification simulation)
```

### Implementation Details

```typescript
// Task 1: Add logging to simulateNotification method

simulateNotification: async (options: SimulateNotificationOptions): Promise<void> => {
  // Delay handling
  if (options.delay && options.delay > 0) {
    await new Promise(resolve => setTimeout(resolve, options.delay));
  }
  
  // ADD THIS: Log notification dispatch details
  console.log('ble-mcp-test: dispatching notify event', {
    characteristic: options.characteristic.uuid,
    dataLength: options.data.length,
    data: Array.from(options.data).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')
  });
  
  // Directly update the characteristic value and dispatch the event
  const characteristic = options.characteristic as any;
  
  // Update the characteristic's value
  characteristic.value = new DataView(options.data.buffer);
  
  // Create and dispatch the characteristicvaluechanged event
  const event = new CustomEvent('characteristicvaluechanged', {
    detail: { target: characteristic }
  });
  
  // Set the target property on the event
  Object.defineProperty(event, 'target', {
    value: { value: characteristic.value },
    writable: false
  });
  
  // Dispatch the event
  characteristic.dispatchEvent(event);
  
  // ADD THIS: Log successful dispatch
  console.log('ble-mcp-test: notify event dispatched successfully');
},
```

## Validation Loop

### Level 1: Syntax & Style
```bash
# Run these FIRST - fix any errors before proceeding
pnpm run lint              # ESLint for code style
pnpm run typecheck         # TypeScript type checking

# Expected: No errors. If errors, READ the error and fix.
```

### Level 2: Build Verification
```bash
# Build the project including browser bundle
pnpm run build

# Verify build output
ls -la dist/
ls -la dist/browser/

# Expected: Compiled JS files in dist/ and browser bundle in dist/browser/
```

### Level 3: Test Notification Simulation
```bash
# Run the specific E2E tests for notification simulation
pnpm exec playwright test notification-simulation.spec.ts

# Expected: All tests pass AND console logs visible in test output showing:
# - "ble-mcp-test: dispatching notify event" with data details
# - "ble-mcp-test: notify event dispatched successfully"
```

### Level 4: Full Test Suite
```bash
# Run all tests to ensure no regression
pnpm run test:run          # Unit and integration tests
pnpm run test:e2e          # All E2E tests

# Expected: All tests passing
```

## Final Validation Checklist
- [ ] All tests pass: `pnpm run test`
- [ ] No linting errors: `pnpm run lint`
- [ ] No type errors: `pnpm run typecheck`
- [ ] Build succeeds: `pnpm run build`
- [ ] Browser bundle created: `ls dist/browser/web-ble-mock.js`
- [ ] E2E tests show new logs: `pnpm exec playwright test notification-simulation.spec.ts`
- [ ] CHANGELOG.md updated for v0.7.2
- [ ] Logs are informative showing UUID, data length, and hex data
- [ ] No version bump needed (0.7.2 not yet published)

---

## Anti-Patterns to Avoid
- ❌ Don't use npm/npx - always use pnpm
- ❌ Don't skip validation - run all checks
- ❌ Don't modify the core notification logic - only add logging
- ❌ Don't use different log format than specified
- ❌ Don't forget to update CHANGELOG.md
- ❌ Don't bump version (0.7.2 already set but not published)

## Score: 9/10
High confidence in one-pass implementation. This is a straightforward logging addition with:
- Clear requirements and examples provided
- Existing patterns to follow
- Simple insertion points identified
- Comprehensive validation steps
- No complex logic changes required