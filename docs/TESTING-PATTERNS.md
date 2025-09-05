# BLE Testing Patterns

## Two Primary Usage Patterns

### 1. Active Development Pattern (Interactive E2E Testing)

**Use Case**: Developer actively working on BLE features, running tests repeatedly

**Setup**:
```bash
# Terminal 1: Bridge server (stays running)
cd ble-mcp-test
pnpm start

# Terminal 2: Dev server with mock (stays running)
pnpm dev:mock  # Injects mock once at startup
```

**Characteristics**:
- Mock injected ONCE by dev server at startup
- Session persists across all test runs (e.g., `dev-session-${hostname}`)
- BLE connection maintained between tests (fast!)
- Tests can run repeatedly without reconnecting
- Developer can inspect BLE state between tests
- Browser DevTools available for debugging

**Test Code**:
```javascript
test('uses pre-injected mock', async ({ page }) => {
  await page.goto('http://localhost:5173');
  
  // Mock already injected by dev server
  const isInjected = await page.evaluate(() => {
    return window.__webBluetoothMocked === true;
  });
  expect(isInjected).toBe(true);
  
  // Just click connect - mock already configured
  await page.click('[data-testid="connect-button"]');
});
```

**Benefits**:
- ✅ Fast iteration (no reconnection overhead)
- ✅ Debugging-friendly (persistent state)
- ✅ Realistic (mimics production usage)
- ✅ Can test session persistence

**Drawbacks**:
- ❌ Requires manual server startup
- ❌ State can leak between tests
- ❌ Not suitable for CI

---

### 2. CI/CD Pattern (Batched E2E Testing)

**Use Case**: Automated testing in CI pipeline, GitHub Actions, etc.

**Setup**:
```yaml
# .github/workflows/test.yml
- name: Start bridge server
  run: |
    cd ble-mcp-test
    pnpm start &
    sleep 3  # Wait for server

- name: Run E2E tests
  run: pnpm test:e2e  # Tests inject mock themselves
```

**Characteristics**:
- Each test file injects its own mock
- Clean state for each test run
- Session ID includes test name/file for isolation
- No dev server required
- Fully automated, no manual steps

**Test Code**:
```javascript
import { setupMockPage, injectMockInPage } from './test-config';

test.beforeEach(async ({ page }) => {
  // CI mode: inject mock for this test
  await setupMockPage(page, null, true);  // autoInject=true
});

test('standalone test', async ({ page }) => {
  // Mock was injected in beforeEach
  await page.click('[data-testid="connect-button"]');
});
```

**Benefits**:
- ✅ Clean state guaranteed
- ✅ Fully automated
- ✅ Parallelizable
- ✅ Reproducible results

**Drawbacks**:
- ❌ Slower (reconnects each test)
- ❌ Can't debug interactively
- ❌ Less realistic than dev pattern

---

## Choosing the Right Pattern

### Use Active Development Pattern When:
- Developing new BLE features
- Debugging connection issues  
- Testing session persistence
- Running tests interactively
- Need fast test iteration

### Use CI/CD Pattern When:
- Running in GitHub Actions
- Need guaranteed clean state
- Running full test suite
- Automated regression testing
- Testing in Docker/containers

---

## Hybrid Approach (Best of Both)

Our test helpers support BOTH patterns automatically:

```javascript
// test-config.ts
export async function setupMockPage(page, html, autoInject = true) {
  // Load page
  await page.goto('http://localhost/test');
  
  // Check if mock already injected (dev server)
  const preInjected = await isMockPreInjected(page);
  
  if (!preInjected && autoInject) {
    // CI mode: inject mock
    await injectMockInPage(page);
  } else if (preInjected) {
    // Dev mode: verify mock is there
    console.log('Using pre-injected mock from dev server');
  }
}
```

This means the SAME tests work in BOTH modes:
- In dev: Detects and uses pre-injected mock
- In CI: Injects mock automatically

---

## Pattern-Specific Tests

Some tests only make sense for one pattern:

### Development-Only Tests:
- Session persistence across page reloads
- Multiple browser tabs sharing connection
- DevTools protocol integration
- Hot reload with maintained connection

### CI-Only Tests:
- Clean state verification
- Parallel test execution
- Resource cleanup validation
- Memory leak detection

---

## Configuration Examples

### Development Config (.env.local):
```bash
# Stable session for development
BLE_SESSION_ID=dev-session-${USER}-${HOSTNAME}

# Local bridge server
BLE_BRIDGE_URL=ws://localhost:8080

# Keep connection alive
BLE_KEEP_ALIVE=true
```

### CI Config (.env.ci):
```bash
# Unique session per test run
BLE_SESSION_ID=ci-${GITHUB_RUN_ID}-${GITHUB_RUN_NUMBER}

# Bridge in Docker
BLE_BRIDGE_URL=ws://bridge:8080

# Clean up aggressively
BLE_KEEP_ALIVE=false
```

---

## Recommendations

1. **Local Development**: Always use dev:mock pattern
   - Faster iteration
   - Better debugging
   - More realistic

2. **CI Pipeline**: Always use standalone pattern
   - Guaranteed clean state
   - No external dependencies
   - Reproducible

3. **Test Writing**: Write tests that work in BOTH patterns
   - Use helpers that auto-detect mode
   - Don't assume mock is/isn't injected
   - Test both patterns locally before pushing

4. **Session Naming**: Include context in sessionId
   - Dev: `dev-${hostname}-${username}`
   - CI: `ci-${buildId}-${testFile}`
   - Test: `test-${timestamp}-${random}`

This ensures no conflicts between:
- Different developers
- Different CI runs
- Dev and CI environments