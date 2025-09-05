# E2E Test Suite

## Running Tests

### For Active Development (with dev server):
```bash
# Start your app's dev server with mock
pnpm dev:mock  # This injects the mock

# In another terminal, run tests
pnpm test:e2e
```

### For CI/CD (standalone):
```bash
# Just run tests - they'll inject mock themselves
pnpm test:e2e:ci
```

## Test Organization

### Core Functionality Tests
- `mock-quality-assurance.spec.ts` - Mock implementation validation
- `session-rejection.spec.ts` - Session isolation and security
- `zombie-reproduction.spec.ts` - Connection cleanup validation

### Integration Tests  
- `core-session-reuse.spec.ts` - Session persistence across tests
- `disconnect-reconnect-same-session.spec.ts` - Connection recovery
- `websocket-url-verification.spec.ts` - Protocol validation

### Real Device Tests
- `real-device-session.spec.ts` - Hardware integration

## Test Patterns

All tests support two modes:

1. **Dev Mode**: Mock pre-injected by dev server
2. **CI Mode**: Tests inject mock themselves

The test helpers in `test-config.ts` automatically detect which mode to use.

## Writing New Tests

```typescript
import { test } from '@playwright/test';
import { setupMockPage } from './test-config';

test('my test', async ({ page }) => {
  // This works in BOTH dev and CI modes
  await setupMockPage(page);
  
  // Your test code here
  await page.click('[data-testid="connect-button"]');
});
```

## Environment Variables

### Required for All Tests
- `BLE_MCP_SERVICE_UUID` - Primary service UUID (default: 9800)
- `BLE_MCP_WRITE_UUID` - Write characteristic (default: 9900)  
- `BLE_MCP_NOTIFY_UUID` - Notify characteristic (default: 9901)

### Optional
- `BLE_MCP_DEVICE_IDENTIFIER` - Device name filter
- `BLE_MCP_WS_HOST` - Bridge host (default: localhost)
- `BLE_MCP_WS_PORT` - Bridge port (default: 8080)

## Test Coverage

### What We Test
- ✅ Mock injection and initialization
- ✅ Session management and reuse
- ✅ Connection/disconnection cycles
- ✅ Zombie connection prevention
- ✅ Error handling and recovery
- ✅ WebSocket protocol compliance
- ✅ Real device communication

### What We Don't Test
- ❌ Bridge server internals (unit tests)
- ❌ Noble.js library (upstream)
- ❌ Web Bluetooth spec compliance (browser)
- ❌ BLE hardware protocols (device-specific)