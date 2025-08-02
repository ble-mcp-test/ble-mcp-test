name: "Deterministic Session IDs for Playwright E2E Testing"
description: |

## Purpose
Implement deterministic session ID generation in E2E tests to fix the critical bug where Playwright tests fail because each test creates a fresh browser context with a new random session ID, causing the server to reject connections as "device busy".

## Core Principles
1. **Context is King**: Include ALL necessary documentation, examples, and caveats
2. **Validation Loops**: Provide executable tests/lints the AI can run and fix
3. **Information Dense**: Use keywords and patterns from the codebase
4. **Progressive Success**: Start simple, validate, then enhance
5. **Global rules**: Be sure to follow all rules in CLAUDE.md

---

## Goal
Enable deterministic session ID generation in Playwright E2E tests while maintaining backward compatibility for interactive browser usage.

## Why
- **Business value**: E2E testing with Playwright is the PRIMARY PURPOSE of this tool
- **User impact**: TrakRF and other E2E test users are currently blocked
- **Problems this solves**: 
  - Each Playwright test creates a fresh browser context, losing localStorage
  - Different test runs generate different random session IDs
  - Server rejects second session because device is "busy" with the first
  - Tests fail unpredictably when testing session persistence scenarios

## What
Implement a hierarchical session ID generation strategy that:
1. Detects when running in Playwright/test environment
2. Generates deterministic session IDs based on test context
3. Allows explicit session ID injection for special cases
4. Falls back to current random generation for interactive use

### Success Criteria
- [ ] E2E tests generate predictable, stable session IDs
- [ ] Different test files get different session IDs (test isolation)
- [ ] Same test gets same session ID on retry
- [ ] Interactive browser usage continues with random session IDs
- [ ] Support multiple override levels (window property, env var, auto-detection)
- [ ] All existing tests pass

## All Needed Context

### Documentation & References
```yaml
# MUST READ - Include these in your context window
- url: https://playwright.dev/docs/api/class-testinfo
  why: test.info().file provides test file path in Playwright context
  
- url: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/stack
  why: Error().stack for extracting test file path as fallback
  
- url: https://github.com/microsoft/playwright/issues/29045
  why: Confirms no built-in window.__playwright property
  
- file: src/mock-bluetooth.ts
  why: Contains current session ID generation in generateAutoSessionId()
  critical: Lines 376-427 show localStorage persistence logic
  
- file: tests/e2e/session-management.spec.ts
  why: Shows how E2E tests currently fail with session issues
  
- file: CLAUDE.md
  why: Project conventions - MANDATORY pnpm usage, PRIMARY PURPOSE is E2E testing
  critical: This tool MUST work with Playwright E2E tests or it has FAILED
```

### Current Codebase Context

#### Current Session ID Generation
In `src/mock-bluetooth.ts` lines 376-427:
```typescript
private generateAutoSessionId(): string {
  // Try to reuse existing session from localStorage
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('ble-mock-session-id');
      if (stored) {
        return stored;
      }
    }
  } catch (e) {
    // localStorage not available
  }
  
  const ip = this.getClientIP();
  const browser = this.getBrowser();
  const random = Math.random().toString(36).substr(2, 4).toUpperCase();
  
  const sessionId = `${ip}-${browser}-${random}`;
  // Store for next time...
  
  return sessionId;
}
```

#### Browser Detection Already Exists
In `src/mock-bluetooth.ts` line 442:
```typescript
if (ua.includes('Playwright')) return 'playwright';
```

### Environment Detection Patterns
```javascript
// Playwright detection options:
// 1. User agent includes 'Playwright' (already implemented)
// 2. Environment variable check (requires build-time injection)
// 3. Stack trace analysis for test file path
// 4. Window property injection (requires test setup)

// Priority order for session ID:
// 1. window.BLE_TEST_SESSION_ID (explicit injection)
// 2. Derived from test file path if in Playwright
// 3. Current random generation (fallback)
```

### Stack Trace Parsing Example
```javascript
// Get test file from stack trace
function getTestFilePath(): string | null {
  const stack = new Error().stack;
  if (!stack) return null;
  
  // Parse stack trace for test file
  // Format varies by engine but includes file paths
  const lines = stack.split('\n');
  for (const line of lines) {
    // Look for .spec.ts or .test.ts files
    const match = line.match(/\/(tests?\/.+\.(spec|test)\.[jt]s)/);
    if (match) {
      return match[1];
    }
  }
  return null;
}
```

### Known Gotchas of our codebase & Library Quirks
```typescript
// CRITICAL: This project uses pnpm exclusively - NEVER use npm or npx
// CRITICAL: localStorage persistence only works within a browser session
// CRITICAL: Each Playwright test creates a fresh browser context
// CRITICAL: Browser detection via user agent already implemented
// CRITICAL: Session IDs must be stable across page reloads in tests
// CRITICAL: Must not break interactive browser usage
```

## Implementation Blueprint

### Data models and structure
No new data models needed - modifying existing session ID generation logic.

### List of tasks to be completed in order

```yaml
Task 1: Add Test Environment Detection
MODIFY src/mock-bluetooth.ts:
  - ADD isTestEnvironment() method after generateAutoSessionId()
  - CHECK for Playwright browser (already have this)
  - CHECK for test file in stack trace
  - RETURN true if either condition met

Task 2: Add Test File Path Extraction
MODIFY src/mock-bluetooth.ts:
  - ADD getTestIdentifier() method
  - PARSE Error().stack for test file path
  - NORMALIZE path separators (Windows backslashes)
  - EXTRACT last 2-3 path segments for uniqueness
  - FALLBACK to 'unknown-test' if parsing fails

Task 3: Modify Session ID Generation
MODIFY src/mock-bluetooth.ts generateAutoSessionId():
  - CHECK window.BLE_TEST_SESSION_ID first (highest priority)
  - IF isTestEnvironment() THEN:
    - GET test identifier from getTestIdentifier()
    - FORMAT as: `${hostname}-${testPath}`
    - SKIP localStorage storage (not needed for deterministic IDs)
  - ELSE use existing random generation logic

Task 4: Add Window Property Support
MODIFY src/mock-bluetooth.ts constructor:
  - CHECK window.BLE_TEST_SESSION_ID before auto-generation
  - USE it if present (test can inject specific ID)
  - LOG when using injected session ID

Task 5: Create Unit Tests
CREATE tests/unit/deterministic-session-id.test.ts:
  - TEST window property injection works
  - TEST stack trace parsing extracts correct path
  - TEST path normalization handles Windows paths
  - TEST fallback to random when not in test
  - MOCK window and Error objects as needed

Task 6: Create Integration Test
CREATE tests/integration/session-deterministic.test.ts:
  - TEST session ID is stable across multiple calls
  - TEST different "test files" get different IDs
  - TEST interactive mode still gets random IDs
  - USE Node.js environment (not browser)

Task 7: Update E2E Test
MODIFY tests/e2e/session-management.spec.ts:
  - ADD test for deterministic session ID
  - VERIFY same test gets same ID on multiple runs
  - TEST explicit injection via window property
  - ENSURE page reload maintains session

Task 8: Update Documentation
MODIFY .claude/commands/execute-prp.md:
  - NOTE this feature in the changelog
  - EXPLAIN deterministic session ID behavior
  - PROVIDE examples of usage in tests
```

### Validation Gates

#### Level 1: Syntax & Type Checking
```bash
# Run these FIRST - fix any errors before proceeding
pnpm run lint
pnpm run typecheck

# Expected: No errors. If errors, READ and FIX them.
```

#### Level 2: Unit Tests
```bash
# Run new unit tests
pnpm run test tests/unit/deterministic-session-id.test.ts

# Run all unit tests to ensure no regression
pnpm run test:unit

# Expected: All tests passing
```

#### Level 3: Integration Tests
```bash
# Run integration tests
pnpm run test:integration

# Expected: All tests passing, including new deterministic ID test
```

#### Level 4: E2E Tests (Critical)
```bash
# Start the bridge server
pnpm run start &
SERVER_PID=$!

# Wait for server
sleep 2

# Run E2E tests multiple times to verify determinism
pnpm exec playwright test tests/e2e/session-management.spec.ts
pnpm exec playwright test tests/e2e/session-management.spec.ts
pnpm exec playwright test tests/e2e/session-management.spec.ts

# Kill server
kill $SERVER_PID

# Expected: Same session IDs in each run, no "device busy" errors
```

#### Level 5: Manual Browser Test
```bash
# Build browser bundle
pnpm run build:browser

# Open examples/session-persistence-demo.html in browser
# Verify random session IDs still work for interactive use
```

### Error Handling Strategy
```typescript
// Graceful fallbacks at each level:
1. If window.BLE_TEST_SESSION_ID parsing fails -> continue to next level
2. If stack trace parsing fails -> use 'unknown-test' identifier  
3. If test detection fails -> fall back to random generation
4. If localStorage fails -> continue without persistence
5. Never throw errors - always provide a session ID
```

### Code Snippets

#### Test Environment Detection
```typescript
private isTestEnvironment(): boolean {
  // Check if running in Playwright (browser detection)
  if (this.getBrowser() === 'playwright') {
    return true;
  }
  
  // Check stack trace for test files
  const testPath = this.getTestIdentifier();
  return testPath !== null && testPath !== 'unknown-test';
}
```

#### Deterministic ID Generation
```typescript
// In generateAutoSessionId(), add at the beginning:
// Priority 1: Explicit injection
if (typeof window !== 'undefined' && window.BLE_TEST_SESSION_ID) {
  console.log(`[MockBluetooth] Using injected test session: ${window.BLE_TEST_SESSION_ID}`);
  return window.BLE_TEST_SESSION_ID;
}

// Priority 2: Test environment detection
if (this.isTestEnvironment()) {
  const hostname = this.getClientIP();
  const testId = this.getTestIdentifier();
  const sessionId = `${hostname}-${testId}`;
  console.log(`[MockBluetooth] Generated deterministic test session: ${sessionId}`);
  return sessionId;
}

// Priority 3: Continue with existing random generation...
```

## Success Metrics

### Quantitative
- E2E test success rate increases from ~50% to 100%
- Zero "Device is busy with another session" errors in E2E tests
- Session IDs remain stable across 100+ test runs

### Qualitative  
- TrakRF and other E2E test users can successfully test session persistence
- No breaking changes for interactive browser usage
- Clear logging shows when deterministic vs random IDs are used

## PRP Quality Score: 9/10

**Confidence level for one-pass implementation**: Very high. All necessary context is provided, implementation steps are clear and ordered, validation gates are comprehensive, and error handling is specified. The only reason it's not 10/10 is that cross-platform path handling might require minor adjustments based on the specific test environment.

## Final Notes

Remember: This tool's PRIMARY PURPOSE is E2E testing with Playwright. If this feature doesn't work perfectly with Playwright tests, we have FAILED. Test thoroughly with real Playwright scenarios.