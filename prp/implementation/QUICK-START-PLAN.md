# Quick Start Implementation Plan

## Goal: Get trakrf-handheld debugging ASAP with clean Go CLI

## Stage 1: MCP Server (1 hour) ✅ SHIP TODAY

Minimal MCP server with just the debugging tools needed:

```typescript
// src/mcp-server.ts
- get_logs tool (with since/filter support)
- status tool (connection state)
- scan_devices tool (find BLE devices)
```

Ship this first so trakrf-handheld can start using raw MCP Tools:
```bash
# Immediate usage
mcp call get_logs --params '{"since":"30s"}' node dist/mcp-server.js
```

## Stage 2: Quick Go Wrapper (1 hour) ✅ SHIP TODAY

Dead simple Go wrapper for the essential commands:

```go
// cli/main.go - Minimal version
package main

import (
    "encoding/json"
    "fmt"
    "os"
    "os/exec"
)

func main() {
    if len(os.Args) < 2 {
        fmt.Println("Usage: web-ble-bridge [logs|status|scan]")
        os.Exit(1)
    }

    switch os.Args[1] {
    case "logs":
        since := "30s"
        if len(os.Args) > 2 {
            since = os.Args[2]
        }
        callMCP("get_logs", map[string]string{"since": since})
    case "status":
        callMCP("status", nil)
    case "scan":
        callMCP("scan_devices", nil)
    case "start":
        // Start the MCP server
        cmd := exec.Command("node", "dist/mcp-server.js")
        cmd.Stdout = os.Stdout
        cmd.Stderr = os.Stderr
        cmd.Run()
    default:
        fmt.Printf("Unknown command: %s\n", os.Args[1])
    }
}

func callMCP(tool string, params map[string]string) {
    args := []string{"call", tool}
    if params != nil {
        paramsJSON, _ := json.Marshal(params)
        args = append(args, "--params", string(paramsJSON))
    }
    args = append(args, "node", "dist/mcp-server.js")
    
    cmd := exec.Command("mcp", args...)
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr
    if err := cmd.Run(); err != nil {
        fmt.Fprintf(os.Stderr, "Error: %v\n", err)
        os.Exit(1)
    }
}
```

Build it:
```bash
go build -o web-ble-bridge cli/main.go
```

Now they have:
```bash
web-ble-bridge logs 30s
web-ble-bridge status
web-ble-bridge scan
```

## Stage 3: Polish Later (2-4 hours) 📅 NEXT WEEK

After trakrf-handheld is unblocked, enhance with:
- Cobra for proper CLI framework
- Pretty formatted output
- Progress indicators
- Auto-install MCP Tools if missing
- Multi-platform builds
- npm distribution

## Why This Order Works

1. **MCP Server first** = Immediate debugging capability
2. **Simple Go wrapper** = Nice UX within an hour
3. **Polish later** = Not blocking critical debugging

## Deliverables Today

1. ✅ Working MCP server (get_logs, status, scan_devices)
2. ✅ Basic Go CLI binary
3. ✅ Quick install instructions

Total time: ~2 hours to unblock trakrf-handheld

## Quick Test

```bash
# Build everything
pnpm build
go build -o web-ble-bridge cli/main.go

# Test MCP server directly
mcp call get_logs --params '{"since":"30s"}' node dist/mcp-server.js

# Test Go wrapper
./web-ble-bridge logs 30s
./web-ble-bridge status
```

Ship it! 🚀