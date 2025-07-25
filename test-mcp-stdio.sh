#!/bin/bash

# Test MCP stdio interface
echo "Testing MCP stdio interface..."

# Create a test script that sends MCP commands via stdio
cat > /tmp/mcp-test-commands.txt << 'EOF'
{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}},"id":1}
{"jsonrpc":"2.0","method":"tools/list","params":{},"id":2}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"status","arguments":{}},"id":3}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_logs","arguments":{"since":"1m","limit":5}},"id":4}
EOF

echo "Starting server with MCP stdio..."
echo "Commands to test:"
cat /tmp/mcp-test-commands.txt

echo -e "\n\nTo test MCP stdio, run:"
echo "pnpm start < /tmp/mcp-test-commands.txt"
echo ""
echo "Or interactively:"
echo "pnpm start"
echo "Then paste each JSON command and press Enter"