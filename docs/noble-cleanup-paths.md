# Noble Transport Cleanup Paths Analysis

## Critical Finding: Orphaned BLE Notifications

**Root Cause**: The error handler was calling `removeAllListeners()` but not `unsubscribeAsync()`, leaving active BLE subscriptions that continued receiving data even after apparent disconnection.

## All Execution Paths for Cleanup

### 1. **Normal Disconnect Path** ✅
- User calls `disconnect()`
- Calls `unsubscribeAsync()` on notify characteristic
- Calls `disconnectAsync()` on peripheral
- Clears all references
- **Status**: Properly cleaned up

### 2. **Peripheral Disconnect Event** ⚠️
- BLE device disconnects unexpectedly
- `peripheral.once('disconnect')` handler fires
- Only calls `removeAllListeners()`
- **Issue**: No `unsubscribeAsync()` - notifications may persist
- **Note**: May need fixing but requires careful async handling

### 3. **Error During Connection** ✅ (After Fix)
- Connection fails at any point
- Catch block executes
- NOW calls `unsubscribeAsync()` before clearing references
- Calls `disconnectAsync()` on peripheral
- **Status**: Fixed - properly unsubscribes

### 4. **Early Disconnect Detection** ⚠️
- Connection appears successful but device immediately disconnects
- Detected by state check after connection
- Throws error, triggering path #3
- **Status**: Handled by error path

## Race Condition Considerations

### Why We Don't Make Disconnect Handler Async
- Would delay `onDisconnected()` callback
- Could cause multiple disconnect handlers to race
- Peripheral might be invalid before async operations complete
- Better to handle cleanup synchronously where possible

### Safe Cleanup Order
1. Unsubscribe from notifications (async, in try-catch)
2. Remove event listeners (sync)
3. Clear object references (sync)
4. Disconnect peripheral (async, in try-catch)

## Noble State Management Issues

### Characteristic Lifecycle
- `subscribeAsync()` creates BLE-level subscription
- `on('data')` adds JavaScript event listener
- `removeAllListeners()` only removes JS listeners
- `unsubscribeAsync()` removes BLE subscription
- **Critical**: Both must be called for complete cleanup

### Symptoms of Incomplete Cleanup
- RX data appears during unrelated operations (like scanning)
- "Ghost" notifications from previous connections
- Increased event listener counts over time
- Memory leaks in long-running processes

## Recommendations

1. **Always pair** `subscribeAsync()` with `unsubscribeAsync()`
2. **Always wrap** unsubscribe in try-catch (device may be gone)
3. **Consider** adding unsubscribe to peripheral disconnect handler (with careful async handling)
4. **Monitor** for orphaned notifications in production logs
5. **Test** rapid connect/disconnect cycles to verify cleanup

## Testing for Cleanup Issues

```bash
# Look for RX data during scan operations
grep -A5 -B5 "Received data" logs | grep -E "(Discovered|Scan)"

# Check for listener accumulation
grep "listener" logs | grep -E "cleanup|pressure"
```