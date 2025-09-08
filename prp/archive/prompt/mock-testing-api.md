name: "Mock Testing API Refactor - Device-Agnostic Testing Interface"
description: |

## Purpose
Create a comprehensive testing API in the Web Bluetooth mock to eliminate eval indirection, provide clean device-agnostic interfaces, and standardize E2E testing patterns across the codebase.

## Core Principles
1. **Device Agnostic**: Mock stays generic, test helpers handle device specifics
2. **No Eval Injection**: Testing API built into mock itself  
3. **Clean Separation**: E2E tests use helpers, not mock directly
4. **Progressive Enhancement**: Remove battery testing, use predictable trigger status

---

## Goal
Transform the Web Bluetooth mock to include a built-in testing API accessible via `navigator.bluetooth.testing` that eliminates the need for eval-based test helpers and provides a clean, device-agnostic interface for round-trip testing and notification simulation.

## Why
- **Eliminate eval indirection**: Current `getBrowserSendTestCommand()` uses string injection which is fragile and hard to debug
- **Standardize testing patterns**: Inconsistent test helpers across E2E tests create maintenance burden
- **Enable predictable testing**: Replace battery voltage (varies) with trigger status (predictable 0xA001 response)
- **Improve developer experience**: Clean destructuring API `const {testCommand, simulateNotification} = navigator.bluetooth.testing`

## What
Add a testing namespace to MockBluetooth class with:
1. `testCommand()` - Send any Uint8Array command and validate response
2. `simulateNotification()` - Inject fake device notifications for event testing
3. `utils` object with `toHex()`, `fromHex()`, `equals()` binary helpers

### Success Criteria
- [ ] Testing API accessible via `navigator.bluetooth.testing` when mock is injected
- [ ] All E2E tests use testTriggerStatus() helper (no direct mock access)
- [ ] All battery voltage testing removed, replaced with trigger status (0xA001)
- [ ] Unit tests cover all new API methods with 100% coverage
- [ ] New E2E test validates simulateNotification functionality
- [ ] Clean build/lint/typecheck with zero errors

## All Needed Context

### Documentation & References
```yaml
# MUST READ - Core Web Bluetooth API
- url: https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API
  why: Understand BluetoothRemoteGATTCharacteristic event patterns
  
- url: https://webbluetoothcg.github.io/web-bluetooth/#notification-events
  section: Notification event structure and handling
  critical: Event.target.value structure for mock compatibility

# MUST READ - Playwright Context Bridging  
- url: https://playwright.dev/docs/evaluating
  why: page.evaluate() context boundaries between Node.js and browser
  critical: Cannot share imports, must pass serializable data
  
# Current Implementation Patterns
- file: /home/mike/ble-mcp-test/src/mock-bluetooth.ts
  why: Current simulateNotification on characteristic (lines 104-116), injection patterns (lines 631-687)
  pattern: Multi-fallback navigator.bluetooth replacement strategy
  
- file: /home/mike/ble-mcp-test/tests/e2e/test-helpers.ts  
  why: Current sendTestCommand with eval injection (lines 168-287), validation patterns
  gotcha: getBrowserSendTestCommand returns string for page.evaluate()
  
- file: /home/mike/ble-mcp-test/tests/unit/uuid-normalization.test.ts
  why: Unit test structure with Vitest (describe/it/expect patterns)
  pattern: Environment variable testing, beforeEach/afterEach cleanup
  
- file: /home/mike/ble-mcp-test/tests/e2e/test-config.ts
  why: E2E configuration patterns, getBleConfig() structure  
  pattern: Environment-driven config with smart dev/CI detection

- file: /home/mike/ble-mcp-test/src/cs108-commands.ts
  why: Current command byte definitions, to be simplified/removed
  critical: Trigger status command: [0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x01]
```

### Current Codebase Tree
```bash
/home/mike/ble-mcp-test/
├── src/
│   ├── mock-bluetooth.ts         # Current mock implementation
│   ├── mock-browser-entry.ts     # Browser bundle exports
│   ├── ws-transport.ts           # WebSocket communication
│   └── cs108-commands.ts         # Command definitions (to be simplified)
├── tests/
│   ├── unit/                     # Vitest unit tests
│   ├── e2e/                      # Playwright E2E tests 
│   │   ├── test-helpers.ts       # Current eval-based helpers
│   │   └── *.spec.ts             # 10 E2E test files to update
│   └── test-config.ts            # Shared test configuration
├── examples/                     # Client examples to update
└── docs/                         # Documentation to update
```

### Desired Codebase Tree with New Files
```bash
/home/mike/ble-mcp-test/
├── src/
│   ├── mock-bluetooth.ts         # MODIFIED: Add testing namespace
│   ├── mock-browser-entry.ts     # MODIFIED: Export testing API
│   └── cs108-commands.ts         # SIMPLIFIED: Remove unused commands
├── tests/
│   ├── unit/
│   │   └── testing-api.test.ts   # NEW: Unit tests for testing API
│   └── e2e/
│       ├── test-helpers.ts       # MODIFIED: Simple testTriggerStatus() wrapper
│       ├── notification-simulation.spec.ts  # NEW: Test simulateNotification
│       └── *.spec.ts            # MODIFIED: All use testTriggerStatus()
├── examples/
│   ├── test-helpers.html         # NEW: testCommand usage
│   ├── smoke-test.html           # NEW: Quick validation
│   └── simulate-events.html      # NEW: Notification simulation
└── docs/
    └── TESTING-API.md            # NEW: Comprehensive guide
```

### Known Gotchas & Library Quirks
```typescript
// CRITICAL: pnpm only - NEVER use npm commands
// Package manager: pnpm (see CLAUDE.md rules)

// CRITICAL: ES modules with .js imports in TypeScript
// Pattern: import { WebSocketTransport } from './ws-transport.js';

// CRITICAL: Playwright page.evaluate() context boundaries
// Cannot share imports between Node.js test context and browser context
// Must pass all data as serializable arguments to page.evaluate()

// CRITICAL: Navigator replacement multi-fallback pattern (mock-bluetooth.ts:663-686)
// Try direct assignment, then defineProperty, then create new navigator
// This handles different browser security policies

// GOTCHA: MockBluetooth class needs testing property for API exposure
// Current pattern: Class properties become available on navigator.bluetooth instance

// GOTCHA: Trigger status (0xA001) vs Battery (0xA000)
// Trigger status always returns 0 when not pressed (predictable)
// Battery voltage varies with charge level (unpredictable for testing)

// CRITICAL: TypeScript strict mode - explicit return types required
// Pattern: async function testCommand(options: TestOptions): Promise<TestResult>

// GOTCHA: Vitest global test functions vs imports
// Use globals: true in vitest config, no need to import describe/it/expect
```

## Implementation Blueprint

### Data Models and Structure
Create TypeScript interfaces for the new testing API ensuring type safety.

```typescript
// Core testing API interfaces
interface TestCommandOptions {
  device: BluetoothDevice;
  writeCharacteristic: BluetoothRemoteGATTCharacteristic; 
  notifyCharacteristic: BluetoothRemoteGATTCharacteristic;
  command: Uint8Array;
  timeout?: number;
  validateResponse?: (data: Uint8Array) => boolean;
}

interface TestResult {
  success: boolean;
  response?: Uint8Array;
  responseHex?: string;
  error?: string;
  timeout?: boolean;
}

interface SimulateNotificationOptions {
  characteristic: BluetoothRemoteGATTCharacteristic;
  data: Uint8Array;
  delay?: number;
}

interface TestingUtils {
  toHex(data: Uint8Array): string;
  fromHex(hex: string): Uint8Array;
  equals(a: Uint8Array, b: Uint8Array): boolean;
}

interface BluetoothTesting {
  testCommand(options: TestCommandOptions): Promise<TestResult>;
  simulateNotification(options: SimulateNotificationOptions): Promise<void>;
  utils: TestingUtils;
}
```

### List of Tasks (Implementation Order)

```yaml
Task 1 - Add Testing API to MockBluetooth Class:
  MODIFY src/mock-bluetooth.ts:
    - FIND: "export class MockBluetooth" (line ~373)
    - ADD: testing property after bleConfig property  
    - CREATE: testCommand() method with timeout and validation
    - CREATE: simulateNotification() method with delay support
    - CREATE: utils object with binary helpers
    - PRESERVE: all existing mock functionality

Task 2 - Remove Old simulateNotification from Characteristic:
  MODIFY src/mock-bluetooth.ts:
    - FIND: "simulateNotification(data: Uint8Array)" in MockBluetoothRemoteGATTCharacteristic (~line 104)
    - REMOVE: entire method implementation
    - PRESERVE: handleTransportMessage() and triggerNotification() methods
    - UPDATE: JSDoc comments to reference new API

Task 3 - Update Browser Bundle Exports:
  MODIFY src/mock-browser-entry.ts:
    - VERIFY: testing API is accessible when MockBluetooth is exported
    - ENSURE: WebBleMock global includes testing functionality
    - TEST: navigator.bluetooth.testing is available after injection

Task 4 - Create Unit Tests for Testing API:
  CREATE tests/unit/testing-api.test.ts:
    - TEST: testCommand success scenario with mock characteristics
    - TEST: testCommand timeout scenario  
    - TEST: testCommand with custom validateResponse function
    - TEST: simulateNotification triggers event listeners
    - TEST: simulateNotification with delay timing
    - TEST: utils.toHex() hex conversion accuracy
    - TEST: utils.fromHex() parsing with various formats  
    - TEST: utils.equals() comparison edge cases
    - VERIFY: API accessible after mock injection in browser context

Task 5 - Refactor E2E Test Helpers:
  MODIFY tests/e2e/test-helpers.ts:
    - REMOVE: getBrowserSendTestCommand() eval injection function
    - REMOVE: sendTestCommand() complex implementation  
    - CREATE: testTriggerStatus() wrapper using navigator.bluetooth.testing
    - USE: 0xA001 trigger status command (predictable response)
    - VALIDATE: response bytes 8-10 should be [0xA0, 0x01, 0x00]
    - PRESERVE: validateBatteryResponse() for backward compatibility

Task 6 - Update All E2E Test Files:
  MODIFY tests/e2e/*.spec.ts (10 files):
    - REPLACE: sendTestCommand() calls with testTriggerStatus()
    - REMOVE: all getBrowserSendTestCommand() usage
    - REMOVE: all battery voltage command testing  
    - UPDATE: test assertions for trigger status responses
    - PRESERVE: all existing test logic and structure
    - FILES: cleanup-state-integrity.spec.ts, core-session-reuse.spec.ts, 
             disconnect-reconnect-same-session.spec.ts, real-device-session.spec.ts,
             session-pool-behavior.spec.ts, uuid-format-compatibility.spec.ts, etc.

Task 7 - Create E2E Test for Notification Simulation:
  CREATE tests/e2e/notification-simulation.spec.ts:
    - TEST: simulateNotification triggers characteristicvaluechanged event
    - TEST: notification data matches injected data exactly
    - TEST: delayed notifications work with timing
    - TEST: multiple notifications in sequence
    - VERIFY: same event listener patterns as real device responses

Task 8 - Simplify Command Definitions:
  MODIFY src/cs108-commands.ts:
    - REMOVE: unused battery command exports
    - PRESERVE: TRIGGER_STATUS_COMMAND for test-helpers.ts
    - UPDATE: JSDoc to reflect new testing patterns
    - CONSIDER: this file may become unnecessary if only one command used
```

### Per Task Pseudocode

```typescript
// Task 1 - Testing API Implementation
export class MockBluetooth {
  // ... existing properties ...
  
  public readonly testing = {
    testCommand: async (options: TestCommandOptions): Promise<TestResult> => {
      // PATTERN: Input validation first (like existing codebase)
      if (!options.device || !options.writeCharacteristic || !options.notifyCharacteristic) {
        throw new Error('Missing required options');
      }
      
      // PATTERN: Promise-based timeout handling (like ws-transport.ts:65-68)
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          // Cleanup and resolve with timeout
          resolve({ success: false, timeout: true, error: 'Command timeout' });
        }, options.timeout || 2000);
        
        // PATTERN: Event listener cleanup (like current test-helpers.ts:118-122)
        const handler = (event) => {
          clearTimeout(timeout);
          const data = new Uint8Array(event.target.value.buffer);
          
          // FEATURE: Custom validation function
          const isValid = options.validateResponse ? 
            options.validateResponse(data) : data.length > 0;
            
          resolve({
            success: isValid,
            response: data,
            responseHex: this.testing.utils.toHex(data),
            error: isValid ? undefined : 'Invalid response format'
          });
        };
        
        // Setup listener and send command
        options.notifyCharacteristic.addEventListener('characteristicvaluechanged', handler, { once: true });
        options.writeCharacteristic.writeValue(options.command).catch((error) => {
          clearTimeout(timeout);
          resolve({ success: false, error: error.message });
        });
      });
    },
    
    simulateNotification: async (options: SimulateNotificationOptions): Promise<void> => {
      // PATTERN: Delay handling (like existing mock patterns)
      if (options.delay && options.delay > 0) {
        await new Promise(resolve => setTimeout(resolve, options.delay));
      }
      
      // CRITICAL: Reuse existing triggerNotification pattern from characteristic
      // Find the characteristic in the device's registered characteristics
      // and call triggerNotification directly
    },
    
    utils: {
      toHex: (data: Uint8Array): string => {
        // PATTERN: Existing hex conversion (like test-helpers.ts:207-210)
        return Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
      },
      
      fromHex: (hex: string): Uint8Array => {
        // Handle "A7 B3 02" format and "A7B302" format
        const cleaned = hex.replace(/\s+/g, '');
        const bytes = [];
        for (let i = 0; i < cleaned.length; i += 2) {
          bytes.push(parseInt(cleaned.substr(i, 2), 16));
        }
        return new Uint8Array(bytes);
      },
      
      equals: (a: Uint8Array, b: Uint8Array): boolean => {
        return a.length === b.length && a.every((val, i) => val === b[i]);
      }
    }
  };
}

// Task 5 - Simplified Test Helper
export async function testTriggerStatus(page: Page): Promise<TestResult> {
  return page.evaluate(async (config) => {
    const { testCommand } = navigator.bluetooth.testing;
    
    // PATTERN: Standard BLE connection setup (from existing E2E tests)
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [config.service] }]
    });
    await device.gatt.connect();
    
    const service = await device.gatt.getPrimaryService(config.service);
    const writeChar = await service.getCharacteristic(config.write);
    const notifyChar = await service.getCharacteristic(config.notify);
    
    // CRITICAL: Use 0xA001 trigger status command (predictable response)
    const TRIGGER_STATUS_CMD = new Uint8Array([0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x01]);
    
    return testCommand({
      device,
      writeCharacteristic: writeChar,
      notifyCharacteristic: notifyChar,
      command: TRIGGER_STATUS_CMD,
      timeout: 2000,
      validateResponse: (data) => {
        // CRITICAL: Trigger status response validation
        // Response format: 11 bytes, bytes 8-10 should be [0xA0, 0x01, 0x00]
        return data.length === 11 && data[8] === 0xA0 && data[9] === 0x01 && data[10] === 0x00;
      }
    });
  }, getBleConfig());
}
```

### Integration Points
```yaml
MOCK INJECTION:
  - ensure: navigator.bluetooth.testing available after injectWebBluetoothMock()
  - pattern: Add testing property to MockBluetooth class instance
  - verify: Testing API persists across page reloads in same test context

E2E TESTS:
  - update: All 10 E2E test files to use testTriggerStatus() helper
  - pattern: import { testTriggerStatus } from './test-helpers.js'
  - remove: All direct usage of navigator.bluetooth.testing in E2E tests

UNIT TESTS:
  - create: Comprehensive test coverage for new testing API
  - pattern: Mock BluetoothRemoteGATTCharacteristic for isolated testing
  - verify: API works independently of WebSocket transport

BROWSER BUNDLE:
  - ensure: testing API included in dist/mock-bluetooth.js
  - verify: Examples can access navigator.bluetooth.testing  
  - check: TypeScript definitions include testing interfaces
```

## Validation Loop

### Level 1: Syntax & Style
```bash
# Run these FIRST - fix any errors before proceeding
pnpm run typecheck         # TypeScript compilation - must pass with zero errors
pnpm run lint              # ESLint checks - must pass (may auto-fix)

# Expected: No errors. If TypeScript errors, fix interface definitions first.
# Expected: No ESLint errors. Common issues: unused imports, missing return types.
```

### Level 2: Unit Tests
```typescript
// CREATE tests/unit/testing-api.test.ts with comprehensive coverage:

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockBluetooth, injectWebBluetoothMock } from '../../src/mock-bluetooth.js';

describe('MockBluetooth Testing API', () => {
  let mockCharacteristic: any;
  let testDevice: any;
  
  beforeEach(() => {
    // PATTERN: Mock characteristic setup (like existing unit tests)
    mockCharacteristic = {
      writeValue: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    
    testDevice = { gatt: { connected: true } };
  });

  it('should expose testing API after injection', () => {
    // Mock DOM environment
    Object.defineProperty(global, 'window', {
      value: { navigator: {} },
      writable: true
    });
    
    injectWebBluetoothMock({
      sessionId: 'test',
      serverUrl: 'ws://localhost:8080',
      service: '1234'
    });
    
    expect((global.window.navigator as any).bluetooth.testing).toBeDefined();
    expect(typeof (global.window.navigator as any).bluetooth.testing.testCommand).toBe('function');
  });

  it('should handle testCommand success scenario', async () => {
    const mockBluetooth = new MockBluetooth('ws://localhost:8080', {
      sessionId: 'test',
      service: '1234',
      timeout: 5000,
      onMultipleDevices: 'error'
    });
    
    // Setup mock response
    const responseData = new Uint8Array([0xA7, 0xB3, 0x04, 0xD9, 0x82, 0x9E, 0x00, 0x00, 0xA0, 0x01, 0x00]);
    
    // Simulate successful response
    setTimeout(() => {
      const mockEvent = {
        target: { value: { buffer: responseData.buffer } }
      };
      mockCharacteristic.addEventListener.mock.calls[0][1](mockEvent);
    }, 10);
    
    const result = await mockBluetooth.testing.testCommand({
      device: testDevice,
      writeCharacteristic: mockCharacteristic,
      notifyCharacteristic: mockCharacteristic,
      command: new Uint8Array([0xA7, 0xB3, 0x02]),
      timeout: 100,
      validateResponse: (data) => data.length === 11
    });
    
    expect(result.success).toBe(true);
    expect(result.response).toEqual(responseData);
    expect(result.responseHex).toContain('A7 B3');
  });

  it('should handle testCommand timeout', async () => {
    const mockBluetooth = new MockBluetooth('ws://localhost:8080', {
      sessionId: 'test',
      service: '1234', 
      timeout: 5000,
      onMultipleDevices: 'error'
    });
    
    const result = await mockBluetooth.testing.testCommand({
      device: testDevice,
      writeCharacteristic: mockCharacteristic,
      notifyCharacteristic: mockCharacteristic,
      command: new Uint8Array([0xA7, 0xB3]),
      timeout: 50  // Short timeout
    });
    
    expect(result.success).toBe(false);
    expect(result.timeout).toBe(true);
    expect(result.error).toBe('Command timeout');
  });

  it('should convert bytes to hex correctly', () => {
    const mockBluetooth = new MockBluetooth('ws://localhost:8080', {
      sessionId: 'test',
      service: '1234',
      timeout: 5000,
      onMultipleDevices: 'error'
    });
    
    const bytes = new Uint8Array([0xA7, 0xB3, 0x02]);
    const hex = mockBluetooth.testing.utils.toHex(bytes);
    expect(hex).toBe('A7 B3 02');
  });

  it('should parse hex to bytes correctly', () => {
    const mockBluetooth = new MockBluetooth('ws://localhost:8080', {
      sessionId: 'test', 
      service: '1234',
      timeout: 5000,
      onMultipleDevices: 'error'
    });
    
    const bytes1 = mockBluetooth.testing.utils.fromHex('A7 B3 02');
    const bytes2 = mockBluetooth.testing.utils.fromHex('A7B302');
    const expected = new Uint8Array([0xA7, 0xB3, 0x02]);
    
    expect(mockBluetooth.testing.utils.equals(bytes1, expected)).toBe(true);
    expect(mockBluetooth.testing.utils.equals(bytes2, expected)).toBe(true);
  });
});
```

```bash
# Run unit tests and iterate until passing:
pnpm run test tests/unit/testing-api.test.ts
# If failing: Read error output, check mock setup, fix API implementation
```

### Level 3: E2E Integration Test  
```bash
# Test the E2E helper works with real mock injection
pnpm exec playwright test tests/e2e/notification-simulation.spec.ts --headed

# Expected: Test passes, notifications are received and validated
# If failing: Check browser console for mock injection errors
```

### Level 4: Full E2E Test Suite
```bash
# Run all E2E tests to verify no regressions
pnpm exec playwright test

# Expected: All tests pass using new testTriggerStatus() helper  
# If failing: Update any missed sendTestCommand() references
```

### Level 5: Build Verification
```bash
# Build browser bundle and verify testing API is included
pnpm run build
pnpm run build:browser

# Check bundle size and API exports
ls -la dist/
node -e "
const fs = require('fs');
const bundle = fs.readFileSync('dist/mock-bluetooth.js', 'utf8');
console.log('Testing API included:', bundle.includes('testCommand'));
"

# Expected: Bundle builds successfully, testing API is present
```

## Final Validation Checklist
- [ ] All unit tests pass: `pnpm run test`
- [ ] No linting errors: `pnpm run lint`  
- [ ] No type errors: `pnpm run typecheck`
- [ ] Browser bundle builds: `pnpm run build:browser`
- [ ] All E2E tests pass: `pnpm exec playwright test`
- [ ] Testing API accessible in browser: `navigator.bluetooth.testing` exists after injection
- [ ] No eval() usage remaining in test files
- [ ] All battery voltage testing replaced with trigger status (0xA001)
- [ ] simulateNotification works for unsolicited events
- [ ] Examples use destructuring pattern: `const {testCommand, simulateNotification} = navigator.bluetooth.testing`

---

## Anti-Patterns to Avoid
- ❌ Don't put CS108-specific commands in MockBluetooth class - keep it device-agnostic
- ❌ Don't allow E2E tests to access navigator.bluetooth.testing directly - use test-helpers wrapper
- ❌ Don't keep eval-based injection patterns - replace with built-in API  
- ❌ Don't use battery voltage (0xA000) for testing - unpredictable responses
- ❌ Don't skip timeout handling in testCommand - critical for test reliability
- ❌ Don't forget cleanup in event listeners - prevents memory leaks in tests
- ❌ Don't hardcode WebSocket URLs - use existing configuration patterns
- ❌ Don't break backward compatibility of existing mock features - only add, don't remove core functionality