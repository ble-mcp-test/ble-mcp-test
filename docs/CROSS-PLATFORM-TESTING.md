# Cross-Platform BLE Testing Guide

## Current Issue Summary

On Raspberry Pi (Linux), we're experiencing connection issues with the CS108 RFID reader:
- Device disconnects during any delay between connection and service discovery
- "Unknown peripheral" warnings from Noble
- Error 8 (connection terminated) during service discovery
- Device appears to have a very short idle timeout (<1 second)

## macOS Testing Steps

### 1. Setup
```bash
# Clone and install
git pull
pnpm install
pnpm run build
```

### 2. Start Bridge Server
```bash
# Start with logging
pnpm run start:bg

# Monitor logs in another terminal
pnpm run logs
```

### 3. Run Test Script
```bash
# Basic connection test
node test-single-connection.js

# If that works, try the full integration tests
pnpm test:run tests/integration/connection.test.ts
```

### 4. What to Look For

**Success Indicators:**
- Connection stays stable for >5 seconds
- Service discovery completes without error
- No "unknown peripheral" warnings
- Can send/receive data

**Failure Patterns to Note:**
- Does it disconnect at the same point as Linux?
- Do you see "unknown peripheral" warnings?
- What error code (if any) do you get?
- How long does the connection stay alive?

### 5. Timing Tests

If basic connection works, test different timing configurations:

```javascript
// In src/noble-transport.ts, try these TIMINGS values:
CONNECTION_STABILITY: 5000,  // Does 5s work on macOS?
PRE_DISCOVERY_DELAY: 2000,   // Does 2s work on macOS?
```

### 6. Manual BLE Testing

Use macOS Bluetooth tools to verify the device:
```bash
# List BLE devices (requires Xcode tools)
system_profiler SPBluetoothDataType

# Or use a BLE scanner app like:
# - LightBlue (App Store)
# - nRF Connect (App Store)
```

## Windows Testing (If Needed)

Windows uses WinRT for BLE in Noble. Key differences:
- Different peripheral addressing scheme
- May require running as Administrator
- Check if Windows Bluetooth service is running

```bash
# Same test procedure as macOS
pnpm install
pnpm run build
pnpm run start:bg
node test-single-connection.js
```

## Data to Collect

Please note:
1. **Platform**: macOS version / Windows version
2. **Node version**: `node --version`
3. **Connection behavior**: Where/when does it fail?
4. **Error messages**: Exact error text and codes
5. **Timing tolerance**: What delays work vs fail?
6. **Noble warnings**: Any "unknown peripheral" or similar warnings?
7. **Service discovery**: Does it complete? How long does it take?

## Expected Outcomes

### Best Case (macOS works perfectly)
- Issue is Linux/Noble specific
- Need platform-specific timing adjustments
- May need to investigate Linux BLE connection parameters

### Middle Case (macOS works with different timing)
- CS108 has platform-specific behavior  
- Need adaptive timing based on platform
- Document platform requirements

### Worst Case (Fails on all platforms)
- CS108 requires specific initialization sequence
- Need to reverse-engineer expected protocol
- May need to contact device manufacturer

## Debug Logging

For detailed debugging, you can enable Noble debug logs:
```bash
# macOS/Linux
DEBUG=noble* pnpm run start

# Windows
set DEBUG=noble* && pnpm run start
```

## Quick Test Summary

```bash
# Pull latest changes
git pull

# Install and build  
pnpm install
pnpm run build

# Start server
pnpm run start:bg

# Run test
node test-single-connection.js

# Check logs if it fails
pnpm run logs
```

Please share the results in the PR or issue!