#!/bin/bash

# This script starts the BLE bridge service with the correct Node.js version
# It uses the fnm-installed Node.js 24.x which is required for BLE compatibility

# Set up fnm environment
export FNM_DIR="/home/mike/.local/share/fnm"
NODE_PATH="$FNM_DIR/node-versions/v24.4.1/installation/bin"

# Ensure the node binary exists
if [ ! -f "$NODE_PATH/node" ]; then
    echo "Error: Node.js 24.4.1 not found at $NODE_PATH/node"
    echo "Please ensure Node.js 24.4.1 is installed via fnm"
    exit 1
fi

# Build the project if dist directory doesn't exist
if [ ! -d "dist" ]; then
    echo "Building project..."
    "$NODE_PATH/node" "$NODE_PATH/pnpm" run build
fi

# Start the service
echo "Starting BLE bridge service with Node.js 24.4.1..."
exec "$NODE_PATH/node" dist/start-server.js --mcp-http