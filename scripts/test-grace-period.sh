#!/bin/bash

# Test script for grace period behavior
# Temporarily sets a short grace period, runs test, then restores normal settings

echo "=== Testing Grace Period Behavior ==="
echo "Setting short grace period (3 seconds) for testing..."

# Set short grace period and restart server
export BLE_SESSION_GRACE_PERIOD_SEC=3
export BLE_SESSION_IDLE_TIMEOUT_SEC=10
pnpm build && pnpm pm2:restart

# Wait for server to be ready
sleep 2

echo "Running grace period test..."
pnpm exec playwright test session-pool-behavior --grep "grace period expiry"

# Store test result
TEST_RESULT=$?

echo "Restoring normal grace period (60 seconds)..."

# Restore normal settings
unset BLE_SESSION_GRACE_PERIOD_SEC
unset BLE_SESSION_IDLE_TIMEOUT_SEC
pnpm pm2:restart

echo "=== Test complete ==="
exit $TEST_RESULT