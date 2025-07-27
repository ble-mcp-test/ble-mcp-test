# BLE Bridge Server Listener Leak Analysis

## Findings

### No Scanning During Active Connections
The logs confirmed that the bridge server does NOT perform scanning while actively connected. The disconnect issues were caused by listener leaks, not scanning conflicts.

### Root Cause: Event Listener Accumulation

1. **Noble's discoverAsync() bug** - Each scan iteration adds 3 `scanStop` listeners that aren't cleaned up
2. **HCI layer accumulation** - Internal Bluetooth HCI bindings accumulate listeners (25 observed)
3. **Peripheral object persistence** - Noble caches peripheral objects that retain event listeners
4. **Incomplete error path cleanup** - Some error scenarios don't remove all listeners

### Impact
- Resource pressure causes dynamic cooldown to increase (200ms → 1200ms)
- Eventually leads to connection instability
- May cause "unknown peripheral" errors after many connections

## Fixes Applied

1. **More aggressive mid-scan cleanup** - Reduced threshold from 90 to 15 listeners
2. **Enhanced peripheral cleanup** - Remove all listeners and delete from Noble's cache
3. **Disconnect handler cleanup** - Clean up all resources when device disconnects
4. **Increased cooldown multiplier** - From 500ms to 1000ms per pressure unit
5. **High pressure cleanup** - Aggressive peripheral cache clearing when pressure > 2

## New API: Force Cleanup

Added `NobleTransport.forceCleanup()` static method for test teardown:
```javascript
await NobleTransport.forceCleanup(); // Call between tests
```

## Recommendations

### Short-term (for testing today):
1. Space tests by 2-3 seconds minimum
2. Call `NobleTransport.forceCleanup()` between test suites
3. Monitor pressure with `NobleTransport.checkPressure()`

### Long-term:
1. Contribute fix upstream to Noble for discoverAsync() leak
2. Implement connection pooling to reuse peripherals
3. Add automatic pressure relief when idle
4. Consider migrating to WebBluetooth API on supported platforms

## Monitoring
The server now logs pressure details when disconnecting. Watch for:
- `Resource pressure detected` messages
- `Dynamic cooldown` adjustments
- HCI listener counts > 20