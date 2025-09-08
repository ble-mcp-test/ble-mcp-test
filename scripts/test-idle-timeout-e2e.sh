#!/bin/bash

# Script to run the idle timeout test with temporary short timeout

echo "=== Testing Idle Timeout Behavior ==="
echo "Setting short idle timeout (3 seconds) for testing..."

# Set short idle timeout and restart server
pnpm exec pm2 set ble-mcp-test:BLE_MCP_IDLE_TIMEOUT 3
pnpm build && pnpm exec pm2 restart ble-mcp-test --update-env

# Wait for server to be ready and verify timeout
sleep 5
echo "Verifying server timeout setting..."
pnpm exec pm2 logs ble-mcp-test --nostream --lines 5 | grep "SessionManager"

echo "Running idle timeout test..."
pnpm exec playwright test session-pool-behavior --grep "idle timeout expiry"

# Store test result
TEST_RESULT=$?

echo "Restoring normal idle timeout (600 seconds)..."

# Restore normal settings
pnpm exec pm2 set ble-mcp-test:BLE_MCP_IDLE_TIMEOUT 600
pnpm exec pm2 restart ble-mcp-test --update-env

echo "=== Test complete ==="
exit $TEST_RESULT