#!/bin/bash

# Script to uninstall the BLE bridge systemd service and clean up /opt/ble-bridge

set -e

echo "Uninstalling BLE Bridge Service..."

# Check if running as root/sudo
if [ "$EUID" -eq 0 ]; then 
   echo "Please run this script as your normal user with sudo when needed"
   exit 1
fi

# Stop the service if running
if systemctl is-active --quiet ble-bridge; then
    echo "Stopping service..."
    sudo systemctl stop ble-bridge
fi

# Disable the service if enabled
if systemctl is-enabled --quiet ble-bridge 2>/dev/null; then
    echo "Disabling service..."
    sudo systemctl disable ble-bridge
fi

# Remove service file
if [ -f /etc/systemd/system/ble-bridge.service ]; then
    echo "Removing service file..."
    sudo rm /etc/systemd/system/ble-bridge.service
fi

# Remove the installation directory
if [ -d /opt/ble-bridge ]; then
    echo "Removing /opt/ble-bridge directory..."
    sudo rm -rf /opt/ble-bridge
fi

# Reload systemd
echo "Reloading systemd..."
sudo systemctl daemon-reload

echo "✅ Service uninstalled successfully!"
echo ""
echo "Note: User remains in bluetooth group. To remove:"
echo "  sudo gpasswd -d $USER bluetooth"