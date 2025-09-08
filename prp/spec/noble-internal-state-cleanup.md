# Specification: Remove Noble.js Internal State Dependencies

## FEATURE:
Remove all direct access to Noble.js internal state (`_peripherals`, `_discoveredPeripheralUUids`, etc.) and replace with public API alternatives or contribute upstream changes to Noble.js to expose needed functionality.

Current code directly accesses private Noble.js internals in 3 locations:
- `src/noble-transport.ts` lines 264-356: Direct access to `_peripherals` map
- `src/noble-transport.ts` lines 338-355: Manual clearing of internal state
- Multiple instances of type casting `(noble as any)`

**Background Context**: These internal state interventions were experimental attempts to reduce broken zombie connections that left BLE devices inaccessible. However, with much more comprehensive testing and knowledge of past failure patterns, we may be able to achieve the same reliability using only Noble's public API.

This creates fragile dependencies that will break with Noble.js updates.

## EXAMPLES:
Current problematic patterns:
```typescript
// PROBLEMATIC: Direct access to internal state
if ((noble as any)._peripherals) {
  const peripherals = (noble as any)._peripherals;
  // ...manipulation of internal state
}

// PROBLEMATIC: Manual state clearing
(noble as any)._discoveredPeripheralUUids = [];
```

Desired patterns:
```typescript
// PREFERRED: Use public API only
const connectedPeripherals = await noble.getConnectedPeripheralsAsync();
await noble.resetAsync(); // If this method exists
```

## DOCUMENTATION:
- Noble.js documentation: https://github.com/stoprocent/noble
- Noble.js source code for understanding internal structure
- WebBluetooth spec for alternative approaches: https://webbluetoothcg.github.io/web-bluetooth/
- Similar cleanup in other projects: https://github.com/noble/noble/issues?q=internal+state

## OTHER CONSIDERATIONS:

**Technical Debt Severity**: Medium - won't break immediately but will fail on Noble updates

**Implementation Strategy**:
1. **Back to Basics Approach**: Start with clean public API implementation
2. **Comprehensive Testing**: Use existing extensive test suite to validate reliability
3. **Stress Testing**: Validate that public API alone can maintain device accessibility
4. **Progressive Fallback**: Keep internal access as temporary fallback if public API proves insufficient

**Implementation Options**:
1. **Public API Migration**: Replace internal calls with public Noble methods where available
2. **Stress Test Validation**: Extensively test device accessibility without internal interventions
3. **Upstream Contribution**: Contribute needed methods to Noble.js repository if public API is insufficient
4. **Wrapper Layer**: Create abstraction layer that encapsulates Noble interactions
5. **Fork Maintenance**: Fork Noble.js if upstream doesn't accept contributions (last resort)

**Validation Requirements**:
- All existing E2E tests must continue to pass
- BLE cleanup must remain effective (no connection leaks)
- Noble state reset functionality must be preserved
- Performance impact should be minimal

**Risk Assessment**:
- High risk of breaking BLE cleanup if not done carefully
- May require significant testing with real hardware
- Could impact connection reliability if Noble behavior changes

**Advantages of Current Context**:
- **Comprehensive E2E Test Suite**: 22 passing E2E tests validate full connection lifecycle
- **Known Failure Patterns**: Much better understanding of what historically caused zombie connections
- **Session Management**: Robust session pooling may reduce need for aggressive cleanup
- **Stress Testing Capability**: Existing test infrastructure can validate reliability at scale

**Files Affected**:
- `src/noble-transport.ts` (primary changes)
- Any other files with `(noble as any)` patterns
- Test files that depend on cleanup behavior