## FEATURE:
Move RX/TX logging back to noble-transport
- Add access to shared logging facility to noble-transport
- Move 

## EXAMPLES:
Suggested Logging for simulateNotification:

console.log('ble-mcp-test: dispatching notify event', {
characteristic: characteristic.uuid,
dataLength: data.length,
data: Array.from(data).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')
});

// After the actual dispatch
console.log('ble-mcp-test: notify event dispatched successfully');

## OTHER CONSIDERATIONS:
For a test tool like ble-mcp-test, detailed logging by default makes perfect sense:

Why Detailed Logging is the Right Choice:

1. Test-only tool - Not user-facing, so verbose logging isn't a UX concern
2. Debugging purpose - The whole point is to help diagnose BLE communication issues
3. Development environment - Tests benefit from instrumentation by default
4. No performance concerns - Test tools can be verbose without impacting production
5. When things break - Like our current trigger simulation issue, detailed logs are essential


This would immediately show us:
- ✅ API is being called (first log)
- ✅ Correct characteristic (UUID matches notify characteristic)
- ✅ Correct data (trigger packets: 0xa7 0xb3 0x04 0xd9 0x82 0x9e...)
- ✅ Dispatch completed (second log)

Then we'd know if the issue is:
- Before dispatch (no logs)
- During dispatch (first log only)
- After dispatch (both logs, but no characteristicvaluechanged)

Just add the detailed logging and call it good - exactly the right approach for a test utility!
---
- Package manager: Must use pnpm (not npm/yarn)
- TypeScript version requirements
- Browser compatibility needs
- Performance constraints
- Security considerations