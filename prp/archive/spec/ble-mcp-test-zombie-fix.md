## FEATURE:
Fix ble-mcp-test bridge server incomplete connection cleanup that leaves zombie connections in the Noble BLE stack, preventing new connections even though the bridge believes it has disconnected.

### Current Problem:
- Bridge server's disconnect() doesn't fully clean up Noble BLE stack resources
- Noble retains partial connection state after disconnect, blocking device discovery
- Bridge thinks it's free but Noble stack still holds connection references
- New connection attempts timeout during discovery because device appears connected to Noble
- Only detected when discovery timeout occurs, not proactively

### Root Cause:
The bridge performs incomplete cleanup during disconnect:
- Calls peripheral.disconnect() but doesn't wait for 'disconnect' event
- Doesn't remove all Noble event listeners
- Doesn't clear Noble's internal connection state cache
- May not properly close GATT services/characteristics before disconnecting

### Required Behavior:
1. Bridge server MUST perform complete Noble cleanup on disconnect:
   - Call completeNobleReset() after EVERY disconnect (ALREADY IMPLEMENTED)
   - Remove ALL event listeners from peripheral (ALREADY IMPLEMENTED)
   - Clear all Noble JavaScript state (ALREADY IMPLEMENTED)
   - Do NOT wait for disconnect event (can hang indefinitely)
2. Add connection state verification after disconnect:
   - Verify peripheral.state === 'disconnected'
   - Attempt rediscovery to confirm device is available
   - If rediscovery fails, force deeper cleanup
3. When zombie detected, recovery is automatic:
   - completeNobleReset() is ALREADY called on every disconnect/failure
   - This IS the recovery mechanism - no additional action needed
4. Only if recovery fails, reject with clear error:
   - WebSocket error code 4002
   - Message: "BLE connection in zombie state - restart ble-mcp-test service"

## EXAMPLES:
Current problematic flow:
```javascript
// Mock connects to WebSocket successfully
hasTransport: true
// But notify characteristic never initializes
hasNotify: false (after 10 attempts)
// Test fails with:
"simulateNotification not available"
```

Expected flow:
```javascript
// Mock attempts WebSocket connection
// Bridge detects zombie BLE state
// WebSocket rejects with code 4002
throw new Error("BLE device unavailable - bridge server has zombie connection. Please restart ble-mcp-test service")
```

Similar error handling pattern in:
- `lib/ble/web-bluetooth-mock.ts` - Connection error handling
- `lib/ble/websocket-transport.ts` - Transport layer errors

## DOCUMENTATION:
- WebSocket Close Codes: https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent/code
- Web Bluetooth API: https://developer.chrome.com/docs/capabilities/bluetooth
- CS108 BLE Connection States: docs/cs108/CS108_and_CS463_Bluetooth_and_USB_Byte_Stream_API_Specifications.md
- Current ble-mcp-test source: https://github.com/trakrf/ble-mcp-test

## OTHER CONSIDERATIONS:
- **Reliability Requirement**: MUST support 3/3 connections successfully (minimum bar)
- **Real Usage**: Clients run 5-20 tests sequentially - we must be rock solid
- **No Flakiness Tolerance**: If cleanup isn't working 100%, it's broken
- **Version Bump Required**: Update to version 0.5.15
- **Changelog Update**: Document the zombie connection fix in CHANGELOG.md
- **Backward Compatibility**: Ensure existing working connections are not affected
- **Recovery Mechanism**: Consider adding auto-recovery or at least clear recovery instructions
- **Error Codes**: Use standard WebSocket close codes (4002 for server error)
- **Testing**: Add test case that simulates zombie connection scenario
- **MCP Integration**: Ensure MCP tools can detect and report zombie state
- **Performance**: Detection should be immediate, not wait for timeout
- **User Experience**: Error message must be actionable - tell user exactly what to do

### Implementation Checklist:
- [x] Add completeNobleReset() function (DONE)
- [x] Call reset on every disconnect (DONE)
- [x] Call reset on connection failures (DONE)
- [x] Implement WebSocket error codes 4001-4005 (DONE)
- [x] Add BLEConnectionError class (DONE)
- [ ] Add zombie-specific error message for code 4002
- [ ] Update version to 0.5.15 in package.json
- [ ] Add entry to CHANGELOG.md
- [ ] Verify zombie-reproduction.spec.ts passes with 3/3 connections successful
- [ ] Create CS108_COMMANDS constants file with battery voltage command
- [ ] Replace all duplicate command definitions in tests