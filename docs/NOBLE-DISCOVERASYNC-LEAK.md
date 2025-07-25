# Noble discoverAsync() Event Listener Leak

## Summary

The `@stoprocent/noble` library has a memory leak in its `discoverAsync()` generator where each call to `generator.next()` adds 3 event listeners to the 'scanStop' event that are never cleaned up, even when `generator.return()` is called.

## Impact

- During long BLE scans (e.g., 15-second timeout when device not found), this can accumulate 100+ listeners
- Node.js emits `MaxListenersExceededWarning` when listener count exceeds 100
- Can cause memory leaks in long-running applications
- Causes npm publish to fail when tests hit the warning

## Root Cause

The `discoverAsync()` generator in Noble adds event listeners each time `next()` is called but doesn't clean them up properly:

```javascript
// Test case demonstrating the leak
const noble = require('@stoprocent/noble');
console.log('Initial scanStop listeners:', noble.listenerCount('scanStop')); // 0
const gen = noble.discoverAsync();
console.log('After creating generator:', noble.listenerCount('scanStop')); // 0
await gen.next();
console.log('After first next():', noble.listenerCount('scanStop')); // 3
await gen.next();
console.log('After second next():', noble.listenerCount('scanStop')); // 6
gen.return();
console.log('After return():', noble.listenerCount('scanStop')); // 6 (not cleaned up!)
```

## Workaround

We've implemented a workaround in `noble-transport.ts` that cleans up these listeners:

1. **After scan completion**: Remove all scanStop listeners
2. **During long scans**: If listeners exceed 90, clean them up mid-scan

```typescript
// After scanning completes
const scanStopCount = noble.listenerCount('scanStop');
if (scanStopCount > 0) {
  noble.removeAllListeners('scanStop');
}

// During long scans (inside the discovery loop)
if (noble.listenerCount('scanStop') > 90) {
  noble.removeAllListeners('scanStop');
}
```

## Proposed Upstream Fix

The `discoverAsync()` generator should either:

1. **Reuse listeners**: Instead of adding new listeners on each `next()` call, reuse the same listeners
2. **Clean up on return()**: When `generator.return()` is called, remove all listeners added by the generator
3. **Use weak references**: Use weak event listeners that can be garbage collected

Example fix approach:
```javascript
async function* discoverAsync() {
  const listeners = new Set();
  
  try {
    while (true) {
      // Add listener only if not already added
      if (listeners.size === 0) {
        const scanStopListener = () => { /* ... */ };
        noble.on('scanStop', scanStopListener);
        listeners.add(scanStopListener);
      }
      
      yield await someDiscoveryLogic();
    }
  } finally {
    // Clean up all listeners when generator is done
    for (const listener of listeners) {
      noble.removeListener('scanStop', listener);
    }
    listeners.clear();
  }
}
```

## Reproduction Steps

1. Start a BLE scan for a non-existent device
2. Let it run for 15+ seconds
3. Watch `noble.listenerCount('scanStop')` grow by 3 with each discovered device
4. Observe `MaxListenersExceededWarning` when count exceeds 100

## References

- Noble library: https://github.com/stoprocent/noble
- Issue discovered while debugging npm publish timeouts in ble-mcp-test
- Workaround implemented in PR #11 (to be created)