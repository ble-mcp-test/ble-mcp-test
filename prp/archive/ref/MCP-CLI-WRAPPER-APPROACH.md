# Web-BLE-Bridge CLI Wrapper Approach

## Concept: Bundle mcp-cli as our "custom" CLI

Users run `web-ble-bridge` commands, but it's really mcp-cli underneath!

## Implementation Options

### Option 1: Shell Script Wrapper (Simplest)
```bash
#!/usr/bin/env bash
# dist/cli.sh

# Start MCP server in background if not running
if ! pgrep -f "web-ble-bridge-mcp" > /dev/null; then
  node "$(dirname "$0")/mcp-server.js" &
  MCP_PID=$!
  sleep 1
fi

# Map our CLI commands to MCP tools
case "$1" in
  logs)
    shift
    mcp-cli cmd --server web-ble-bridge-mcp --tool get_logs --params="{\"since\":\"${1:-30s}\"}"
    ;;
  status)
    mcp-cli cmd --server web-ble-bridge-mcp --tool status
    ;;
  scan)
    mcp-cli cmd --server web-ble-bridge-mcp --tool scan_devices
    ;;
  *)
    echo "Usage: web-ble-bridge [logs|status|scan]"
    ;;
esac
```

### Option 2: Node.js Wrapper with Embedded mcp-cli
```typescript
#!/usr/bin/env node
// src/cli.ts

import { spawn } from 'child_process';
import { Command } from 'commander';

const program = new Command()
  .name('web-ble-bridge')
  .description('WebSocket-to-BLE bridge with built-in CLI')
  .version('0.3.0');

// Helper to call mcp-cli
async function callMcpTool(tool: string, params?: any) {
  const args = [
    'cmd',
    '--server', 'web-ble-bridge-mcp',
    '--tool', tool
  ];
  
  if (params) {
    args.push('--params', JSON.stringify(params));
  }
  
  return new Promise((resolve, reject) => {
    const proc = spawn('mcp-cli', args, { stdio: 'inherit' });
    proc.on('exit', (code) => {
      if (code === 0) resolve(null);
      else reject(new Error(`mcp-cli exited with code ${code}`));
    });
  });
}

program
  .command('logs [duration]')
  .description('Show recent logs (default: 30s)')
  .option('-f, --filter <pattern>', 'Filter logs')
  .action(async (duration = '30s', options) => {
    await callMcpTool('get_logs', {
      since: duration,
      filter: options.filter
    });
  });

program
  .command('status')
  .description('Show connection status')
  .action(async () => {
    await callMcpTool('status');
  });

program
  .command('scan [duration]')
  .description('Scan for BLE devices')
  .action(async (duration = '5000') => {
    await callMcpTool('scan_devices', {
      duration: parseInt(duration)
    });
  });

program
  .command('start')
  .description('Start the bridge server')
  .action(async () => {
    spawn('node', ['dist/mcp-server.js'], {
      stdio: 'inherit',
      detached: true
    }).unref();
    console.log('Bridge server started');
  });

program.parse();
```

### Option 3: Python Package with mcp-cli Dependency
```python
# setup.py
from setuptools import setup

setup(
    name='web-ble-bridge',
    install_requires=['mcp-cli'],
    entry_points={
        'console_scripts': [
            'web-ble-bridge=web_ble_bridge.cli:main',
        ],
    },
)

# web_ble_bridge/cli.py
import subprocess
import sys
import json

def main():
    if len(sys.argv) < 2:
        print("Usage: web-ble-bridge [logs|status|scan]")
        return
    
    cmd = sys.argv[1]
    
    if cmd == 'logs':
        duration = sys.argv[2] if len(sys.argv) > 2 else '30s'
        subprocess.run([
            'mcp-cli', 'cmd',
            '--server', 'web-ble-bridge-mcp',
            '--tool', 'get_logs',
            '--params', json.dumps({'since': duration})
        ])
    # ... etc
```

## Best Approach: Hybrid NPM Package

```json
// package.json
{
  "name": "@trakrf/web-ble-bridge",
  "bin": {
    "web-ble-bridge": "./dist/cli.js"
  },
  "scripts": {
    "postinstall": "pip install mcp-cli || echo 'Please install mcp-cli manually'"
  },
  "optionalDependencies": {
    "mcp-cli": "*"  // Document the dependency
  }
}
```

Then our CLI provides nice shortcuts:
```bash
# What users see
web-ble-bridge logs 30s
web-ble-bridge status
web-ble-bridge scan

# What actually happens
mcp-cli cmd --server web-ble-bridge-mcp --tool get_logs --params='{"since":"30s"}'
# etc...
```

## Benefits

1. **Looks Native**: Users run `web-ble-bridge` commands
2. **No Maintenance**: We're just wrapping mcp-cli
3. **Best of Both**: Custom UX, standard implementation
4. **Easy Install**: `npm install -g @trakrf/web-ble-bridge`
5. **Graceful Fallback**: Can detect if mcp-cli is missing and provide installation instructions

## Example User Experience

```bash
# Install our package
npm install -g @trakrf/web-ble-bridge

# First run detects missing mcp-cli
$ web-ble-bridge status
Error: mcp-cli not found. Installing...
✓ mcp-cli installed successfully

# Now it just works
$ web-ble-bridge status
{
  "connected": true,
  "device": "CS108Reader123456",
  "uptime": 145
}

# Feels like a native CLI
$ web-ble-bridge logs 1m --filter TX
[TX] A7B302D98237000A000 (GET_BATTERY_VOLTAGE)
[TX] A7B302D98237000B000 (START_INVENTORY)
...
```

Users never need to know it's mcp-cli underneath!