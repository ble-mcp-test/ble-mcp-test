#!/bin/bash

# Script to install the BLE bridge as a systemd service

set -e

echo "Installing BLE Bridge Service..."

# Check if running as root/sudo
if [ "$EUID" -eq 0 ]; then 
   echo "Please run this script as your normal user with sudo when needed"
   exit 1
fi

# Ensure user is in bluetooth group
if ! groups | grep -q bluetooth; then
    echo "Adding user to bluetooth group..."
    sudo usermod -a -G bluetooth $USER
    echo "⚠️  You've been added to the bluetooth group. You may need to log out and back in for this to take effect."
fi

# Build the project first
echo "Building project..."
pnpm run build

# Copy service file to systemd directory
echo "Installing systemd service..."
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
sudo cp "$SCRIPT_DIR/ble-bridge.service" /etc/systemd/system/

# Reload systemd
echo "Reloading systemd..."
sudo systemctl daemon-reload

# Enable the service
echo "Enabling service..."
sudo systemctl enable ble-bridge.service

echo "✅ Service installed successfully!"
echo ""
echo "To manage the service, use:"
echo "  sudo systemctl start ble-bridge    # Start the service"
echo "  sudo systemctl stop ble-bridge     # Stop the service"
echo "  sudo systemctl restart ble-bridge  # Restart the service"
echo "  sudo systemctl status ble-bridge   # Check service status"
echo "  journalctl -u ble-bridge -f        # View logs"