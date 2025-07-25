# Web-BLE-Bridge Go CLI Wrapper Specification

## Overview

Create a custom Go CLI that wraps MCP Tools, providing a native-feeling `web-ble-bridge` command while leveraging the robust MCP Tools implementation.

## Benefits Over Other Approaches

1. **Single static binary** - No Python runtime, no npm dependencies
2. **Fast execution** - Go startup time is minimal
3. **Cross-platform** - Easy to build for macOS, Linux, Windows
4. **Professional feel** - Native CLI experience
5. **Easy distribution** - Can bundle with npm package or standalone

## Implementation Architecture

### Project Structure
```
cli/
├── main.go
├── commands/
│   ├── logs.go
│   ├── status.go
│   ├── scan.go
│   └── start.go
├── mcp/
│   └── client.go
└── build.sh
```

### Core Wrapper (main.go)
```go
package main

import (
    "fmt"
    "os"
    "github.com/spf13/cobra"
    "github.com/trakrf/web-ble-bridge/cli/commands"
)

func main() {
    var rootCmd = &cobra.Command{
        Use:   "web-ble-bridge",
        Short: "WebSocket-to-BLE bridge with MCP interface",
        Long:  `A minimal WebSocket-to-BLE bridge that enables Web Bluetooth API testing 
in browsers without built-in BLE support.`,
    }

    // Add commands
    rootCmd.AddCommand(commands.LogsCmd())
    rootCmd.AddCommand(commands.StatusCmd())
    rootCmd.AddCommand(commands.ScanCmd())
    rootCmd.AddCommand(commands.StartCmd())

    if err := rootCmd.Execute(); err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(1)
    }
}
```

### MCP Client Wrapper (mcp/client.go)
```go
package mcp

import (
    "bytes"
    "encoding/json"
    "fmt"
    "os/exec"
)

type MCPClient struct {
    serverCommand string
    serverArgs    []string
}

func NewClient() *MCPClient {
    return &MCPClient{
        serverCommand: "node",
        serverArgs:    []string{"dist/mcp-server.js"},
    }
}

// CallTool executes an MCP tool and returns the result
func (c *MCPClient) CallTool(tool string, params map[string]interface{}) (string, error) {
    paramsJSON, _ := json.Marshal(params)
    
    args := []string{
        "call", tool,
        "--params", string(paramsJSON),
        c.serverCommand,
    }
    args = append(args, c.serverArgs...)
    
    cmd := exec.Command("mcp", args...)
    var out bytes.Buffer
    var stderr bytes.Buffer
    cmd.Stdout = &out
    cmd.Stderr = &stderr
    
    err := cmd.Run()
    if err != nil {
        return "", fmt.Errorf("mcp call failed: %v\nstderr: %s", err, stderr.String())
    }
    
    return out.String(), nil
}

// ListTools returns available MCP tools
func (c *MCPClient) ListTools() ([]Tool, error) {
    args := []string{"tools", c.serverCommand}
    args = append(args, c.serverArgs...)
    
    cmd := exec.Command("mcp", args...)
    output, err := cmd.Output()
    if err != nil {
        return nil, err
    }
    
    var tools []Tool
    // Parse output...
    return tools, nil
}
```

### Example Command Implementation (commands/logs.go)
```go
package commands

import (
    "fmt"
    "github.com/spf13/cobra"
    "github.com/trakrf/web-ble-bridge/cli/mcp"
)

func LogsCmd() *cobra.Command {
    var filter string
    var follow bool
    
    cmd := &cobra.Command{
        Use:   "logs [duration]",
        Short: "Show recent BLE communication logs",
        Long:  "Display logs from the bridge server's circular buffer",
        Args:  cobra.MaximumNArgs(1),
        RunE: func(cmd *cobra.Command, args []string) error {
            client := mcp.NewClient()
            
            params := map[string]interface{}{
                "since": "30s", // default
            }
            
            if len(args) > 0 {
                params["since"] = args[0]
            }
            
            if filter != "" {
                params["filter"] = filter
            }
            
            if follow {
                params["follow"] = true
                params["timeout"] = 5000
            }
            
            result, err := client.CallTool("get_logs", params)
            if err != nil {
                return err
            }
            
            // Pretty print the result
            fmt.Println(formatLogs(result))
            return nil
        },
    }
    
    cmd.Flags().StringVarP(&filter, "filter", "f", "", "Filter logs by pattern")
    cmd.Flags().BoolVar(&follow, "follow", false, "Follow log output")
    
    return cmd
}
```

### Build Script (build.sh)
```bash
#!/bin/bash

# Build for multiple platforms
GOOS=darwin GOARCH=amd64 go build -o dist/web-ble-bridge-darwin-amd64 ./cli
GOOS=darwin GOARCH=arm64 go build -o dist/web-ble-bridge-darwin-arm64 ./cli
GOOS=linux GOARCH=amd64 go build -o dist/web-ble-bridge-linux-amd64 ./cli
GOOS=windows GOARCH=amd64 go build -o dist/web-ble-bridge-windows-amd64.exe ./cli

# Create universal binary for macOS
lipo -create dist/web-ble-bridge-darwin-amd64 dist/web-ble-bridge-darwin-arm64 \
     -output dist/web-ble-bridge-darwin

# Clean up individual macOS binaries
rm dist/web-ble-bridge-darwin-amd64 dist/web-ble-bridge-darwin-arm64
```

## Distribution Strategy

### Option 1: Bundle with npm package
```json
// package.json
{
  "scripts": {
    "postinstall": "node scripts/install-cli.js"
  },
  "bin": {
    "web-ble-bridge": "./dist/web-ble-bridge"
  }
}
```

```javascript
// scripts/install-cli.js
const os = require('os');
const fs = require('fs');
const path = require('path');

function getBinaryName() {
  const platform = os.platform();
  const arch = os.arch();
  
  if (platform === 'darwin') return 'web-ble-bridge-darwin';
  if (platform === 'linux') return 'web-ble-bridge-linux-amd64';
  if (platform === 'win32') return 'web-ble-bridge-windows-amd64.exe';
  throw new Error(`Unsupported platform: ${platform}`);
}

// Copy appropriate binary to dist/web-ble-bridge
const binary = getBinaryName();
fs.copyFileSync(
  path.join(__dirname, '..', 'binaries', binary),
  path.join(__dirname, '..', 'dist', 'web-ble-bridge')
);
fs.chmodSync(path.join(__dirname, '..', 'dist', 'web-ble-bridge'), 0o755);
```

### Option 2: Standalone releases
- Upload binaries to GitHub releases
- Provide installation instructions
- Users download appropriate binary

## User Experience

```bash
# Install
npm install -g @trakrf/web-ble-bridge

# Start bridge server
web-ble-bridge start

# Check status
web-ble-bridge status

# View logs
web-ble-bridge logs 30s

# Filter TX packets
web-ble-bridge logs --filter TX

# Follow logs
web-ble-bridge logs --follow

# Scan for devices
web-ble-bridge scan

# Get help
web-ble-bridge --help
```

## Implementation Plan

1. **Phase 1: Basic wrapper** (1-2 hours)
   - Main command structure
   - MCP Tools execution
   - Core commands (logs, status, scan)

2. **Phase 2: Enhanced UX** (1-2 hours)
   - Pretty output formatting
   - Error handling
   - Progress indicators
   - Auto-detect MCP Tools installation

3. **Phase 3: Distribution** (1 hour)
   - Build scripts
   - npm integration
   - Installation documentation

## Dependencies

- Go 1.21+
- MCP Tools (installed separately or bundled)
- cobra (CLI framework)
- Optional: color output libraries

## Advantages

1. **Professional CLI** - Feels like a native tool
2. **Fast** - Go startup is instant
3. **Small** - ~10MB binary
4. **No runtime deps** - Just the binary
5. **Cross-platform** - Same experience everywhere
6. **Easy testing** - Standard Go testing tools

## Example Implementation Timeline

- Hour 1: Basic Go wrapper with cobra
- Hour 2: Implement core commands
- Hour 3: Polish UX and error handling
- Hour 4: Build and distribution setup

Total: ~4 hours for a polished CLI that looks completely custom while leveraging MCP Tools underneath.