# Linux Setup Guide

This guide covers the specific setup requirements for running the BLE WebSocket Bridge on Linux systems.

## Overview

Linux BLE support requires additional configuration compared to macOS or Windows. The main challenges are:
- Missing kernel modules for Bluetooth support
- Node.js permission restrictions for raw socket access
- Device discovery differences (MAC addresses vs device names)

## Prerequisites

### 1. Install Bluetooth Kernel Modules

Many Linux distributions don't include all Bluetooth modules by default. Install the extra kernel modules:

```bash
sudo apt install linux-modules-extra-$(uname -r) -y
```

This provides the necessary HCI (Host Controller Interface) modules that Noble.js requires for BLE communication.

### 2. Grant Node.js Bluetooth Capabilities

Linux restricts raw socket access by default. Grant Node.js the required capabilities:

```bash
# For system-wide Node.js
sudo setcap 'cap_net_raw,cap_net_admin+eip' $(which node)

# For fnm-managed Node.js (adjust path as needed)
sudo setcap 'cap_net_raw,cap_net_admin+eip' ~/.local/share/fnm/node-versions/v24.4.1/installation/bin/node
```

**Note:** You'll need to re-run this command whenever you update Node.js.

### 3. Add User to Bluetooth Group

Ensure your user has access to Bluetooth devices:

```bash
sudo usermod -a -G bluetooth $USER
```

Log out and back in for the group change to take effect.

## Device Discovery Differences

### The Problem

On Linux, BLE devices often don't advertise their names, only their MAC addresses. This differs from macOS where device names are typically available.

### The Solution

The bridge now supports matching devices by their MAC address (device ID) when names aren't available:

```javascript
// Works on macOS (device name available)
devicePrefix: "CS108"

// Works on Linux (using MAC address)
devicePrefix: "6c79b82603a7"
```

## Running as a System Service

The included systemd service configuration handles the Linux-specific requirements:

1. **Install the service:**
   ```bash
   cd /path/to/ble-mcp-test
   ./scripts/systemd/install-service.sh
   ```

2. **Start the service:**
   ```bash
   sudo systemctl start ble-bridge
   ```

3. **View logs:**
   ```bash
   journalctl -u ble-bridge -f
   ```

The service configuration includes:
- Bluetooth group permissions
- Required capabilities (CAP_NET_RAW, CAP_NET_ADMIN)
- Proper Node.js path handling for fnm

## Troubleshooting

### "Operation not permitted" errors

This usually means Node.js lacks the required capabilities. Re-run:
```bash
sudo setcap 'cap_net_raw,cap_net_admin+eip' $(which node)
```

### Device not found

1. Check if the device is discoverable:
   ```bash
   # Run the included scan test
   node scantest.js
   ```

2. Look for your device in the output. On Linux, you'll likely see MAC addresses instead of names.

3. Use the MAC address (without colons) as the device prefix.

### Bluetooth adapter not found

Ensure Bluetooth is enabled:
```bash
# Check Bluetooth status
systemctl status bluetooth

# Enable if needed
sudo systemctl enable bluetooth
sudo systemctl start bluetooth

# Check adapter
hciconfig
```

### Missing kernel modules

If you see HCI-related errors, the kernel modules might not be loaded:
```bash
# Check loaded modules
lsmod | grep bluetooth

# Load modules manually if needed
sudo modprobe bluetooth
sudo modprobe btusb
```

## Platform-Specific Notes

### Raspberry Pi

The Raspberry Pi may need additional configuration:

1. Enable Bluetooth in `/boot/config.txt`
2. Disable Bluetooth serial console if using Pi 3/4
3. Consider increasing the BLE timing delays in the environment:
   ```bash
   export BLE_DISCONNECT_COOLDOWN=2000
   export BLE_NOBLE_RESET_DELAY=5000
   ```

### Ubuntu on WSL

WSL doesn't support Bluetooth directly. You'll need to:
- Use WSL2 with USB passthrough (experimental)
- Or run the bridge on native Linux or in a VM

## Summary

The key requirements for Linux are:

1. **Kernel modules:** `linux-modules-extra-$(uname -r)`
2. **Node capabilities:** `cap_net_raw,cap_net_admin+eip`
3. **Device matching:** Use MAC addresses when device names aren't available

With these configurations, the BLE bridge works reliably on Linux systems.