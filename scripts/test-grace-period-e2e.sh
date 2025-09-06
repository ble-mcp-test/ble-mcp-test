#!/bin/bash

# Script to run the grace period test with temporary short timeout

echo "=== Testing Grace Period Behavior ==="
echo "Setting short grace period (3 seconds) for testing..."

# Set short grace period and restart server
pnpm exec pm2 set ble-mcp-test:BLE_MCP_GRACE_PERIOD 3
pnpm exec pm2 set ble-mcp-test:BLE_MCP_IDLE_TIMEOUT 10
pnpm build && pnpm exec pm2 restart ble-mcp-test --update-env

# Wait for server to be ready and verify timeout
sleep 5
echo "Verifying server timeout setting..."
pnpm exec pm2 logs ble-mcp-test --nostream --lines 5 | grep "SessionManager"

echo "Running grace period test..."
pnpm exec playwright test session-pool-behavior --grep "grace period expiry"

# Store test result
TEST_RESULT=$?

echo "Restoring normal grace period (600 seconds)..."

# Restore normal settings
pnpm exec pm2 set ble-mcp-test:BLE_MCP_GRACE_PERIOD 600
pnpm exec pm2 set ble-mcp-test:BLE_MCP_IDLE_TIMEOUT 600
pnpm exec pm2 restart ble-mcp-test --update-env

echo "=== Test complete ==="
exit $TEST_RESULT