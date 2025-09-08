## FEATURE:

Add a clean, device-agnostic testing API to the Web Bluetooth mock that provides:
1. `testCommand()` - Send command and verify response (round-trip testing)
2. `simulateNotification()` - Inject fake device notifications (events, alerts, button presses)
3. Binary utility helpers (toHex, fromHex, equals)

The testing API should be automatically available when the mock is injected via `navigator.bluetooth.testing` - no separate injection needed. Remove the existing `characteristic.simulateNotification()` method in favor of the new API.

## EXAMPLES:

### Desired API Usage:
```javascript
// Destructure for clean usage
const { testCommand, simulateNotification, utils } = navigator.bluetooth.testing;

// Test real device communication (round-trip)
const result = await testCommand({
  device,
  writeCharacteristic: writeChar,
  notifyCharacteristic: notifyChar,
  command: new Uint8Array([0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x01]),
  timeout: 2000,
  validateResponse: (data) => data.length === 11 && data[10] === 0x00
});

// Simulate device event (button press - NOT a response to a command)
simulateNotification({
  characteristic: notifyChar,
  data: new Uint8Array([0x01, 0xFF]), // Button pressed
  delay: 100
});

// Use utilities
const hex = utils.toHex(result.response);
const bytes = utils.fromHex("A7 B3 02");
const same = utils.equals(bytes1, bytes2);
```

### Simplified Test Helper (tests/e2e/test-helpers.ts):
```javascript
// Single command defined here - no need for separate constants file
const TRIGGER_STATUS_COMMAND = new Uint8Array([
  0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x01
]);

export async function testTriggerStatus(page: Page) {
  return page.evaluate(async (config) => {
    const { testCommand } = navigator.bluetooth.testing;
    
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [config.service] }]
    });
    await device.gatt.connect();
    
    const service = await device.gatt.getPrimaryService(config.service);
    const writeChar = await service.getCharacteristic(config.write);
    const notifyChar = await service.getCharacteristic(config.notify);
    
    return testCommand({
      device,
      writeCharacteristic: writeChar,
      notifyCharacteristic: notifyChar,
      command: new Uint8Array([0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x01]),
      timeout: 2000,
      validateResponse: (data) => data.length === 11 && data[10] === 0x00
    });
  }, getBleConfig());
}

// All tests just call this one function
test('device works', async ({ page }) => {
  await setupMockPage(page);
  const result = await testTriggerStatus(page);
  expect(result.success).toBe(true);
});
```

## DOCUMENTATION:

### Current Implementation to Reference:
- `src/mock-bluetooth.ts` line 104: Current `simulateNotification()` implementation on characteristic
- `tests/e2e/test-helpers.ts`: Current `sendTestCommand` helper using eval() injection
- `tests/e2e/zombie-reproduction.spec.ts` lines 25-63: Inline sendTestCommand implementation
- `src/cs108-commands.ts`: Current command definitions (to be simplified/removed)

### Web Bluetooth API:
- https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API
- https://webbluetoothcg.github.io/web-bluetooth/#notification-events

### Playwright page.evaluate():
- https://playwright.dev/docs/evaluating
- Bridges Node.js test context with browser context
- Cannot share imports between contexts - must pass data as arguments

## OTHER CONSIDERATIONS:

### Architecture Constraints:
- **NO eval() injection** - Testing API must be part of the mock itself
- **Device agnostic** - No CS108-specific commands baked into the API
- **Clean separation** - "test" = real communication, "simulate" = fake injection
- **No backward compatibility** - Remove old simulateNotification from characteristic

### Context Boundaries:
- Test files run in Node.js (Playwright context)
- navigator.bluetooth exists in browser context
- page.evaluate() bridges the two contexts
- Data passed between contexts must be serializable

### Trigger Status Command (0xA001):
- Predictable response: Always returns 0 when trigger not pressed
- Response format: 11 bytes (8 header + 2 event code + 1 status)
- Better than battery (0xA000) which varies with charge level

### Success Criteria Checklist:

1. ✅ **Refactor mock-bluetooth to support new test API**
   - Add `testing` property to MockBluetooth class
   - Include testCommand() method for round-trip testing
   - Include simulateNotification() method for event injection
   - Include utils object with toHex, fromHex, equals
   - Remove old characteristic.simulateNotification() method
   - Testing API available via navigator.bluetooth.testing when mock is injected

2. ✅ **Add unit test coverage for new API**
   - Test testCommand() success scenario
   - Test testCommand() timeout scenario
   - Test testCommand() with custom validateResponse
   - Test simulateNotification() delivery to event listeners
   - Test simulateNotification() with delay
   - Test utils.toHex() conversion
   - Test utils.fromHex() conversion
   - Test utils.equals() comparison
   - Verify API is accessible in browser context after mock injection

3. ✅ **Refactor all test/e2e/* tests to use updated API**
   - Update test-helpers.ts to use new testing API
   - Remove getBrowserSendTestCommand() function
   - Remove all eval() injection code
   - Create single testTriggerStatus() helper function
   - Update all test files to use testTriggerStatus()
   - Ensure all tests use destructuring for clean code

4. ✅ **Ensure E2E test coverage for simulateNotification**
   - Create dedicated test for notification simulation
   - Verify notification is received by event listener
   - Test both immediate and delayed notifications
   - Test unsolicited events (button presses, not responses)
   - Use same listener pattern as testCommand

5. ✅ **Iterate test/fix until 100% pass rate**
   - Fix any API implementation issues
   - Debug any test failures
   - Separate device availability issues from API issues
   - All API-related tests must pass
   - Document any device-dependent test skips

6. ✅ **Verify 100% clean on build/ts/lint**
   - Run `pnpm run typecheck` - must pass with no errors
   - Run `pnpm run lint` - must pass (fix existing _msg warnings if encountered)
   - Run `pnpm run build` - must complete successfully
   - Run `pnpm run build:browser` - browser bundle must include testing API
   - Ensure testing API is properly typed in TypeScript

7. ✅ **Retest if any changes in step 6**
   - Full test suite run after any fixes
   - Run all E2E tests: `pnpm exec playwright test`
   - Run unit tests: `pnpm test`
   - Confirm no regressions from changes

8. ✅ **Update CHANGELOG.md**
   - Add entry for v0.7.0 (no version bump needed)
   - Document new testing API addition
   - Note BREAKING CHANGE: removal of characteristic.simulateNotification()
   - Include migration guide

9. ✅ **Update client examples**
   - Create `examples/test-helpers.html` showing testCommand usage
   - Create `examples/smoke-test.html` for quick validation
   - Create `examples/simulate-events.html` for button press simulation
   - Update existing examples to use new API where applicable
   - Ensure examples show destructuring pattern

10. ✅ **Update API documentation**
    - Add testing API section to README.md
    - Document all methods in mock-bluetooth.ts JSDoc comments
    - Create `docs/TESTING-API.md` with comprehensive guide
    - Include page.evaluate() context explanation
    - Show destructuring pattern for clean usage
    - Provide migration examples from old to new API

### Files to Update:
1. `src/mock-bluetooth.ts` - Add testing namespace to MockBluetooth class
2. `src/mock-browser-entry.ts` - Ensure testing is exported with mock
3. `tests/e2e/test-helpers.ts` - Simplify to single testTriggerStatus function
4. All files in `tests/e2e/*.spec.ts` - Update to use new API
5. `tests/unit/testing-api.test.ts` - New unit tests for API
6. `src/cs108-commands.ts` - Can be simplified or removed
7. `CHANGELOG.md` - Document v0.7.0 breaking changes
8. `README.md` - Add testing API section
9. `docs/TESTING-API.md` - New comprehensive guide
10. `examples/test-helpers.html` - New example file
11. `examples/smoke-test.html` - New example file
12. `examples/simulate-events.html` - New example file

### Validation Requirements:
- All existing E2E tests must pass with new API
- New E2E test for simulateNotification must work
- TypeScript compilation must be clean
- ESLint must pass (fix existing warnings if encountered)
- Browser bundle must include testing API
- Examples must run without errors