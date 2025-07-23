# Raspberry Pi Bluetooth Notes

## Known Issues with Internal Bluetooth

The Raspberry Pi's internal Bluetooth (BCM43438) has timing sensitivities that can cause issues with BLE operations:

- Error 34 during service discovery
- "Scan already in progress" errors
- Disconnections during rapid connect/disconnect cycles
- Requires long delays (30s+) between operations

## Recommended Solution: USB Bluetooth Dongle

For reliable BLE operation on Raspberry Pi, use an external USB Bluetooth adapter:

### Recommended Adapters
- **ASUS USB-BT400** (CSR8510 chipset) - Best overall
- **Plugable USB-BT4LE** (CSR8510 chipset) - Excellent Linux support
- Generic CSR 4.0 dongles (verify CSR8510 chip)

### Setup
1. Disable internal Bluetooth:
   ```bash
   sudo systemctl disable hciuart
   echo "dtoverlay=disable-bt" | sudo tee -a /boot/config.txt
   sudo reboot
   ```

2. After reboot, plug in dongle and verify:
   ```bash
   hciconfig  # Should show hci0 with the dongle
   ```

## Current Status

- Basic operations work with internal Bluetooth
- Integration tests require excessive delays
- Production use should use USB dongle
- Development continues on macOS until dongle arrives