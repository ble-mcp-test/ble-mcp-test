#!/bin/bash

# Script to uninstall the BLE bridge systemd service

set -e

echo "Uninstalling BLE Bridge Service..."

# Stop the service if running
if systemctl is-active --quiet ble-bridge; then
    echo "Stopping service..."
    sudo systemctl stop ble-bridge
fi

# Disable the service
if systemctl is-enabled --quiet ble-bridge; then
    echo "Disabling service..."
    sudo systemctl disable ble-bridge
fi

# Remove service file
if [ -f /etc/systemd/system/ble-bridge.service ]; then
    echo "Removing service file..."
    sudo rm /etc/systemd/system/ble-bridge.service
fi

# Reload systemd
echo "Reloading systemd..."
sudo systemctl daemon-reload

echo "✅ Service uninstalled successfully!"