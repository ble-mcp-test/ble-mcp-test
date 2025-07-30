# 🔥 HARDWARE REMINDER - WRITTEN IN LETTERS OF FIRE 🔥

## THE CS108 HARDWARE IS REAL AND AVAILABLE

**NEVER ASSUME "NO HARDWARE AVAILABLE"**

When tests fail with:
- "Connection timeout" 
- "Scan already in progress"
- "No device found"

**DO NOT** assume hardware doesn't exist.

**DO** ask Mike to:
1. Power cycle the CS108 device
2. Restart the bluetooth service: `sudo systemctl restart bluetooth`
3. Check device is advertising: `sudo hcitool lescan | grep CS108`

The hardware:
- Model: CS108 RFID Reader
- Address: 6c:79:b8:26:03:a7
- Name: CS108-260572
- Service UUID: 9800
- Write Characteristic: 9900
- Notify Characteristic: 9901

Remember: The hardware exists. If it's not responding, it needs a reset, not denial of its existence.

## 🔥 LINUX BLUETOOTH HCI DOES NOT DISCOVER DEVICE NAME 🔥

**CRITICAL**: On Linux, the CS108 device name is NOT discovered by HCI scan!

**DO NOT** hardcode 'CS108' in tests
**DO NOT** expect device name in scan results  
**DO** use the MAC address: 6c:79:b8:26:03:a7
**DO** use environment variables for ALL device configuration

The bridge accepts BOTH:
- Device name (for systems that discover it)
- MAC address (for Linux systems)

```javascript
// CORRECT - accepts both name and MAC
if ((name && name.startsWith(config.devicePrefix)) || id === config.devicePrefix) {
  // Found device
}
```

**ALWAYS** use environment variables:
- `BLE_MCP_DEVICE_NAME` or test config
- Never hardcode device identifiers