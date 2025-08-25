#!/bin/bash

# Deploy built code to /opt/ble-bridge

set -e

echo "Deploying to /opt/ble-bridge..."

# Ensure we're in the project directory
cd "$(dirname "$0")/.."

# Build first
echo "Building project..."
pnpm run build

# Create /opt/ble-bridge if it doesn't exist
sudo mkdir -p /opt/ble-bridge

# Copy dist directory
echo "Copying dist..."
sudo cp -r dist /opt/ble-bridge/

# Copy package.json for metadata
echo "Copying package.json..."
sudo cp package.json /opt/ble-bridge/

# Ensure start script exists
if [ ! -f /opt/ble-bridge/start-service.sh ]; then
    echo "Copying start script..."
    sudo cp scripts/systemd/start-service.sh /opt/ble-bridge/
    sudo chmod +x /opt/ble-bridge/start-service.sh
fi

# Restart service
echo "Restarting service..."
sudo systemctl restart ble-bridge

# Check status
sleep 2
sudo systemctl status ble-bridge --no-pager | head -10

echo "✅ Deployment complete!"