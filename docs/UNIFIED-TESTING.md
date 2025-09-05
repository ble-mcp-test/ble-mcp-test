# Unified Testing Approach

## One Test Suite, Two Contexts

Our E2E tests are designed to work identically in both development and CI environments. The **same test files** run in both contexts - they automatically detect and adapt to their environment.

## How It Works

### Automatic Context Detection

When a test runs, it checks:
1. Is there a dev server running? (checks `DEV_SERVER_URL` env var)
2. Is the mock already injected? (checks `window.__webBluetoothMocked`)
3. Is the bundle available? (checks `window.WebBleMock`)

Based on these checks, it automatically:
- **Dev Mode**: Uses the pre-injected mock from dev server
- **CI Mode**: Loads the bundle and injects the mock itself

### Running Tests

#### For Developers (with dev server):
```bash
# Terminal 1: Start bridge
cd ble-mcp-test && pnpm start

# Terminal 2: Start dev server (injects mock)
pnpm dev:mock

# Terminal 3: Run tests (will use pre-injected mock)
pnpm test:e2e:dev
```

#### For CI/CD (standalone):
```bash
# Start bridge in background
cd ble-mcp-test && pnpm start &

# Run tests (will inject mock themselves)
pnpm test:e2e:ci
```

#### The Magic: Same Tests, Different Context
```bash
# These run the SAME test files:
pnpm test:e2e:dev  # Sets DEV_SERVER_URL, uses pre-injected mock
pnpm test:e2e:ci    # No dev server, tests inject mock
```

## Test Code Example

```typescript
// This test works in BOTH modes without modification
test('connect to device', async ({ page }) => {
  // setupMockPage automatically detects the context
  await setupMockPage(page);
  
  // Test code is identical regardless of context
  await page.click('[data-testid="connect-button"]');
  await expect(page.locator('[data-testid="battery"]')).toBeVisible();
});
```

## Behind the Scenes

### In Development Mode:
1. `setupMockPage` detects `DEV_SERVER_URL` is set
2. Navigates to `http://localhost:5173` (dev server)
3. Finds mock already injected
4. Uses existing mock with dev session ID

### In CI Mode:
1. `setupMockPage` detects no dev server
2. Serves a test HTML page
3. Loads the mock bundle
4. Injects mock with CI session ID

## Benefits

### For Developers:
- ✅ Fast iteration (mock already injected)
- ✅ Persistent sessions (connection reused)
- ✅ DevTools debugging available
- ✅ Same tests as CI

### For CI/CD:
- ✅ No external dependencies
- ✅ Clean state each run
- ✅ Parallelizable
- ✅ Same tests as dev

### For Everyone:
- ✅ **No test duplication** - one set of tests
- ✅ **No special CI tests** - same code everywhere
- ✅ **Confidence** - what works locally works in CI
- ✅ **Simplicity** - tests don't care about context

## Configuration

### Environment Variables

```bash
# For dev mode (optional - auto-detected)
DEV_SERVER_URL=http://localhost:5173

# For both modes
BLE_BRIDGE_URL=ws://localhost:8080
BLE_MCP_SERVICE_UUID=9800
BLE_MCP_WRITE_UUID=9900
BLE_MCP_NOTIFY_UUID=9901
```

### Session IDs

The system automatically uses appropriate session IDs:
- **Dev**: Uses whatever the dev server injected (e.g., `dev-session-${hostname}`)
- **CI**: Generates test-specific ID (e.g., `e2e-test-${hostname}`)

## Migration Guide

### From Separate Test Suites

If you currently have separate dev and CI tests:

1. **Combine test files** - Use one set of tests
2. **Use setupMockPage** - It handles both contexts
3. **Remove manual injection** - Let helpers handle it
4. **Add npm scripts**:
   ```json
   {
     "test:e2e:dev": "DEV_SERVER_URL=http://localhost:5173 playwright test",
     "test:e2e:ci": "playwright test"
   }
   ```

### From Manual Mock Injection

Replace this:
```typescript
// Old way - manual injection
await page.addScriptTag({ path: bundlePath });
await page.evaluate(() => {
  window.WebBleMock.injectWebBluetoothMock({...});
});
```

With this:
```typescript
// New way - automatic
await setupMockPage(page);
```

## FAQ

**Q: What if I want to force CI mode locally?**
A: Just don't set `DEV_SERVER_URL` and don't run dev:mock

**Q: What if I want different session IDs in CI?**
A: Override in test: `await injectMockInPage(page, { sessionId: 'custom' })`

**Q: Can I mix modes in one test run?**
A: No, choose one context per test run for consistency

**Q: What about Docker/containers?**
A: Works like CI mode - no dev server, tests inject mock

## Summary

One test suite. Two contexts. Zero duplication.

Write your tests once, run them anywhere. The helpers figure out the context and do the right thing automatically. This is the pattern used in production at TrakRF and recommended for all ble-mcp-test users.