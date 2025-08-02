## FEATURE: Deterministic Session IDs for Playwright E2E Testing

### PROBLEM STATEMENT

The current session management implementation uses localStorage to persist session IDs across page reloads. While this works within a single browser session, it fails in Playwright E2E tests because:

1. Each Playwright test creates a fresh browser context with empty localStorage
2. Different test runs generate different random session IDs
3. The bridge server rejects the second session because the device is "busy" with the first session
4. This makes E2E tests fail unpredictably when testing session persistence scenarios

**Root Cause**: Session IDs are random and ephemeral, not deterministic based on test context.

### REQUIREMENTS

1. **Deterministic Session IDs in Tests**: E2E tests must generate predictable, stable session IDs based on test context
2. **Test Isolation**: Different test files should get different session IDs to prevent conflicts
3. **No Persistence Needed**: Session IDs should be derivable, not stored
4. **Backwards Compatibility**: Interactive browser usage should continue to work with random session IDs
5. **Multiple Override Levels**: Support explicit session ID injection for special test cases

### PROPOSED SOLUTION

Implement a hierarchical session ID generation strategy:

```javascript
// Priority order (first non-null wins):
1. window.BLE_TEST_SESSION_ID         // Explicit injection by test
2. process.env.BLE_TEST_SESSION_ID    // Environment variable
3. Playwright context detection       // Auto-generate from test file
4. Current random generation          // Fallback for interactive use
```

### IMPLEMENTATION DETAILS

#### Detection Logic
```javascript
// Detect if running in Playwright
const isPlaywright = !!(
  (typeof process !== 'undefined' && process.env.PLAYWRIGHT_TEST_BASE_URL) ||
  (typeof window !== 'undefined' && window.__playwright)
);
```

#### Session ID Format
```
// E2E Test Format:
{hostname}-{test-path}
Examples:
- "192.168.50.73-tests/e2e/inventory-page"
- "localhost-tests/integration/session-persistence"
- "ci-runner-1-tests/unit/mock-bluetooth"

// Interactive Browser Format (unchanged):
{ip}-{browser}-{random}
Examples:
- "192.168.50.73-chrome-A1B2"
- "127.0.0.1-firefox-X9Y8"
```

#### Test File Path Extraction
- Use `test.info().file` if available (Playwright context)
- Parse stack trace as fallback
- Normalize path separators
- Remove file extensions
- Use last 2-3 path segments for uniqueness

### EXAMPLES

#### E2E Test Usage
```javascript
// Option 1: Explicit injection
test('inventory page session', async ({ page }) => {
  await page.evaluate(() => {
    window.BLE_TEST_SESSION_ID = 'inventory-test-session';
  });
  // Session ID will be: "inventory-test-session"
});

// Option 2: Auto-detection
test('inventory page session', async ({ page }) => {
  // No injection needed
  // Session ID will be: "192.168.50.73-tests/e2e/inventory-page"
});

// Option 3: Environment variable
// BLE_TEST_SESSION_ID=ci-run-123 pnpm test
// Session ID will be: "ci-run-123"
```

#### Interactive Browser Usage
```javascript
// No changes needed - continues to work as before
const mock = new MockBluetooth('ws://localhost:8080');
// Session ID will be: "192.168.50.73-chrome-R4ND"
```

### EDGE CASES

1. **Parallel Test Execution**: Different test files get different sessions naturally
2. **Test Retries**: Same test gets same session ID on retry
3. **CI Environments**: Hostname might be generic, but test path provides uniqueness
4. **Missing Test Context**: Falls back to random generation
5. **Cross-Platform Paths**: Normalize Windows backslashes to forward slashes

### VALIDATION CRITERIA

1. **Unit Tests**
   - Test session ID generation with various inputs
   - Verify priority order of ID sources
   - Test path normalization

2. **Integration Tests**
   - Verify deterministic IDs in Node.js environment
   - Test environment variable override
   - Verify backwards compatibility

3. **E2E Tests**
   - Run same test multiple times, verify same session ID
   - Run different tests, verify different session IDs
   - Test page reload scenarios with deterministic IDs
   - Verify explicit injection works

### SUCCESS METRICS

1. E2E tests no longer fail with "Device is busy with another session"
2. Session persistence tests work reliably across page reloads
3. Interactive browser usage remains unchanged
4. Test isolation is maintained (no session conflicts between tests)

### OTHER CONSIDERATIONS

1. **Backward Compatibility**: Completely out of scope. We have one user who is unable to use the tool. Fix it.
2. **Security**: Session IDs may reveal test structure in logs - this is acceptable for test environments
3. **Performance**: ID generation should be fast (no network calls or heavy computation)
4. **Debugging**: Include session ID in all relevant log messages for troubleshooting
5. **Migration**: No migration needed - this is additive functionality

### IMPLEMENTATION PRIORITY

This is a **CRITICAL** fix because:
- The tool's primary purpose is E2E testing with Playwright
- Current implementation fails at its core use case
- TrakRF and other E2E test users are blocked

Target version: 0.5.5 (patch release for backwards-compatible fix)

### DOCUMENTATION
- Piggyback changes to .claude/commands/execute-prp.md onto this release

