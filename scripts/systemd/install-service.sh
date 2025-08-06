#!/bin/bash

# Script to install the BLE bridge as a systemd service in /opt/ble-bridge
# This creates a self-contained installation that doesn't depend on the source location

set -e

echo "Installing BLE Bridge Service to /opt/ble-bridge..."

# Check if running as root/sudo
if [ "$EUID" -eq 0 ]; then 
   echo "Please run this script as your normal user with sudo when needed"
   exit 1
fi

# Get the absolute path to the project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"

# Ensure we're in the right place
if [ ! -f "$PROJECT_ROOT/package.json" ]; then
    echo "Error: Cannot find package.json. Please run this script from the project directory."
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
cd "$PROJECT_ROOT"
pnpm run build

# Create installation directory
echo "Creating /opt/ble-bridge directory..."
sudo mkdir -p /opt/ble-bridge
sudo chown $USER:$USER /opt/ble-bridge

# Copy necessary files
echo "Copying files to /opt/ble-bridge..."
cp -r dist /opt/ble-bridge/
cp package.json /opt/ble-bridge/
cp -r node_modules /opt/ble-bridge/

# Create a standalone start script that doesn't depend on user paths
echo "Creating start script..."
cat > /opt/ble-bridge/start-service.sh << 'EOF'
#!/usr/bin/env bash

# BLE Bridge Service Starter
# Handles both system-wide and fnm Node.js installations

set -e

# Set working directory
cd /opt/ble-bridge

# Look for Node.js in multiple locations
NODE_BIN=""

# Check fnm installation first
FNM_DIR="/home/mike/.local/share/fnm"
if [ -d "$FNM_DIR" ]; then
    NODE_24=$(find "$FNM_DIR/node-versions" -name "v24*" -type d 2>/dev/null | sort -V | tail -n1)
    if [ -n "$NODE_24" ] && [ -f "$NODE_24/installation/bin/node" ]; then
        NODE_BIN="$NODE_24/installation/bin/node"
    fi
fi

# Fallback to system Node.js
if [ -z "$NODE_BIN" ]; then
    for path in /usr/bin/node /usr/local/bin/node; do
        if [ -f "$path" ]; then
            NODE_BIN="$path"
            break
        fi
    done
fi

# Final check for node in PATH
if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
    NODE_BIN=$(command -v node)
fi

# Exit if no Node.js found
if [ -z "$NODE_BIN" ] || [ ! -f "$NODE_BIN" ]; then
    echo "ERROR: Node.js not found" >&2
    exit 1
fi

# Verify Node.js version
NODE_VERSION=$("$NODE_BIN" --version 2>/dev/null | grep -oE "[0-9]+" | head -1)
if [ "$NODE_VERSION" -lt 24 ]; then
    echo "ERROR: Node.js 24+ required (found: $NODE_VERSION)" >&2
    exit 1
fi

# Start the service
exec "$NODE_BIN" dist/start-server.js --mcp-http
EOF

chmod +x /opt/ble-bridge/start-service.sh

# Create new service file
echo "Creating systemd service file..."
sudo tee /etc/systemd/system/ble-bridge.service > /dev/null << EOF
[Unit]
Description=BLE WebSocket Bridge Service
After=network.target bluetooth.target
Wants=bluetooth.target

[Service]
Type=simple
User=$USER
Group=$USER
WorkingDirectory=/opt/ble-bridge
Environment="NODE_ENV=production"
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=/opt/ble-bridge/start-service.sh
Restart=always
RestartSec=10

# Bluetooth permissions
SupplementaryGroups=bluetooth
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW

# Security
NoNewPrivileges=true
PrivateTmp=true

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ble-bridge

[Install]
WantedBy=multi-user.target
EOF

# Stop existing service if running
if systemctl is-active --quiet ble-bridge; then
    echo "Stopping existing service..."
    sudo systemctl stop ble-bridge
fi

# Reload systemd
echo "Reloading systemd..."
sudo systemctl daemon-reload

# Enable the service
echo "Enabling service..."
sudo systemctl enable ble-bridge.service

echo "✅ Service installed successfully to /opt/ble-bridge!"
echo ""
echo "Installation details:"
echo "  - Service files: /opt/ble-bridge/"
echo "  - Service user: $USER"
echo "  - Service file: /etc/systemd/system/ble-bridge.service"
echo ""
echo "To manage the service, use:"
echo "  sudo systemctl start ble-bridge    # Start the service"
echo "  sudo systemctl stop ble-bridge     # Stop the service"
echo "  sudo systemctl restart ble-bridge  # Restart the service"
echo "  sudo systemctl status ble-bridge   # Check service status"
echo "  journalctl -u ble-bridge -f        # View logs"