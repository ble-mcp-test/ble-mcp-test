# Specification: Remove Noble.js Internal State Dependencies

## FEATURE:
Remove all direct access to Noble.js internal state (`_peripherals`, `_discoveredPeripheralUUids`, etc.) and replace with public API alternatives or contribute upstream changes to Noble.js to expose needed functionality.

Current code directly accesses private Noble.js internals in 3 locations:
- `src/noble-transport.ts` lines 264-356: Direct access to `_peripherals` map
- `src/noble-transport.ts` lines 338-355: Manual clearing of internal state
- Multiple instances of type casting `(noble as any)`

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

**Implementation Options**:
1. **Public API Migration**: Replace internal calls with public Noble methods where available
2. **Upstream Contribution**: Contribute needed methods to Noble.js repository
3. **Wrapper Layer**: Create abstraction layer that encapsulates Noble interactions
4. **Fork Maintenance**: Fork Noble.js if upstream doesn't accept contributions

**Validation Requirements**:
- All existing E2E tests must continue to pass
- BLE cleanup must remain effective (no connection leaks)
- Noble state reset functionality must be preserved
- Performance impact should be minimal

**Risk Assessment**:
- High risk of breaking BLE cleanup if not done carefully
- May require significant testing with real hardware
- Could impact connection reliability if Noble behavior changes

**Files Affected**:
- `src/noble-transport.ts` (primary changes)
- Any other files with `(noble as any)` patterns
- Test files that depend on cleanup behavior