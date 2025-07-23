#!/bin/bash

# Script to verify that all test commands exit properly
# and don't enter watch mode

echo "🧪 Verifying test commands exit properly..."
echo ""

# Create a simple test file to run
TEST_FILE="tmp/test-exit-check.test.ts"
mkdir -p tmp
cat > "$TEST_FILE" << 'EOF'
import { describe, it, expect } from 'vitest';

describe('Exit Check', () => {
  it('should run and exit', () => {
    expect(true).toBe(true);
  });
});
EOF

# Test each command with a timeout
# If any command doesn't exit within 30 seconds, it's likely in watch mode

test_command() {
    local cmd="$1"
    local desc="$2"
    
    echo "Testing: $desc"
    echo "Command: $cmd"
    
    # Run the command with a timeout (30s for integration tests)
    timeout 30s bash -c "$cmd" > /dev/null 2>&1
    local exit_code=$?
    
    if [ $exit_code -eq 124 ]; then
        echo "❌ FAILED: Command timed out (likely in watch mode)"
        return 1
    else
        echo "✅ PASSED: Command exited properly (exit code: $exit_code)"
        return 0
    fi
    echo ""
}

# Track overall success
all_passed=true

# Test main test commands
test_command "pnpm test $TEST_FILE" "Main test command (pnpm test)" || all_passed=false
test_command "pnpm test:run $TEST_FILE" "Test run command (pnpm test:run)" || all_passed=false
test_command "pnpm test:unit" "Unit tests" || all_passed=false
test_command "pnpm test:integration" "Integration tests" || all_passed=false

# Clean up
rm -f "$TEST_FILE"

echo ""
if [ "$all_passed" = true ]; then
    echo "✅ All test commands exit properly!"
else
    echo "❌ Some test commands failed to exit properly"
    echo ""
    echo "To manually test:"
    echo "  1. Run: pnpm test"
    echo "  2. If it shows 'Waiting for file changes...' then it's in watch mode"
    echo "  3. Press Ctrl+C to exit"
    exit 1
fi