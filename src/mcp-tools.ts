import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BridgeServer } from './bridge-server.js';
import { LogEntry } from './log-buffer.js';

// Response interfaces
interface LogsResponse {
  logs: LogEntry[];
  count: number;
  truncated: boolean;
}

interface SearchResponse {
  matches: LogEntry[];
  count: number;
  pattern: string;
}

interface ConnectionState {
  connected: boolean;
  deviceName?: string;
  connectedAt?: string;
  lastActivity?: string;
  packetsTransmitted: number;
  packetsReceived: number;
}

interface ServerStatus {
  version: string;
  uptime: number;
  wsPort: number;
  mcpTransports: {
    stdio: boolean;
    http: boolean;
    httpPort?: number;
    httpAuth: boolean;
  };
  logBufferSize: number;
  logLevel: string;
}


export function registerMcpTools(server: McpServer, bridgeServer: BridgeServer): void {
  // Tool 1: get_logs
  server.registerTool(
    'get_logs',
    {
      title: 'Get BLE Communication Logs',
      description: 'Retrieve recent BLE communication logs with filtering options',
      inputSchema: {
        since: z.string().default('30s').describe("Time filter: duration (30s, 5m, 1h), ISO timestamp, or 'last'"),
        filter: z.string().optional().describe("Filter by 'TX'/'RX' or hex pattern"),
        limit: z.number().min(1).max(1000).default(100).describe("Maximum entries to return")
      }
    },
    async (args) => {
      const { since, filter, limit } = args;
      const logs = bridgeServer.getLogBuffer().getLogsSince(since, limit);
      
      // Apply filter if provided
      let filtered = logs;
      if (filter) {
        const filterUpper = filter.toUpperCase();
        if (filterUpper === 'TX' || filterUpper === 'RX') {
          filtered = logs.filter(log => log.direction === filterUpper);
        } else {
          // Filter by hex pattern
          const cleanFilter = filter.replace(/\s+/g, '').toUpperCase();
          filtered = logs.filter(log => {
            const cleanHex = log.hex.replace(/\s+/g, '');
            return cleanHex.includes(cleanFilter);
          });
        }
      }
      
      const response: LogsResponse = {
        logs: filtered.slice(0, limit),
        count: filtered.length,
        truncated: filtered.length > limit
      };
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }]
      };
    }
  );

  // Tool 2: search_packets
  server.registerTool(
    'search_packets',
    {
      title: 'Search BLE Packets',
      description: 'Search for hex patterns in BLE packets',
      inputSchema: {
        hex_pattern: z.string().describe("Hex pattern to search for (case insensitive, spaces optional)"),
        limit: z.number().min(1).max(1000).default(100).describe("Maximum results to return")
      }
    },
    async (args) => {
      const { hex_pattern, limit } = args;
      const matches = bridgeServer.getLogBuffer().searchPackets(hex_pattern, limit);
      
      const response: SearchResponse = {
        matches,
        count: matches.length,
        pattern: hex_pattern
      };
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }]
      };
    }
  );

  // Tool 3: get_connection_state
  server.registerTool(
    'get_connection_state',
    {
      title: 'Get Connection State',
      description: 'Get detailed BLE connection state and activity',
      inputSchema: {}
    },
    async () => {
      const state = bridgeServer.getConnectionState();
      const stats = bridgeServer.getLogBuffer().getConnectionStats();
      
      const response: ConnectionState = {
        ...state,
        ...stats
      };
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }]
      };
    }
  );

  // Tool 4: status
  server.registerTool(
    'status',
    {
      title: 'Get Bridge Server Status',
      description: 'Get bridge server status and configuration',
      inputSchema: {}
    },
    async () => {
      // Determine active transports
      const hasTty = process.stdin.isTTY && process.stdout.isTTY;
      const stdioEnabled = hasTty && !process.env.DISABLE_STDIO;
      const httpEnabled = !!process.argv.includes('--mcp-http') || !!process.env.MCP_PORT || !!process.env.MCP_TOKEN;
      
      const status: ServerStatus = {
        version: '0.3.0',
        uptime: process.uptime(),
        wsPort: parseInt(process.env.WS_PORT || '8080'),
        mcpTransports: {
          stdio: stdioEnabled,
          http: httpEnabled,
          httpPort: httpEnabled ? parseInt(process.env.MCP_PORT || '8081') : undefined,
          httpAuth: !!process.env.MCP_TOKEN
        },
        logBufferSize: parseInt(process.env.LOG_BUFFER_SIZE || '10000'),
        logLevel: process.env.LOG_LEVEL || 'debug'
      };
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(status, null, 2)
        }]
      };
    }
  );

  // Tool 5: scan_devices
  server.registerTool(
    'scan_devices',
    {
      title: 'Scan for BLE Devices',
      description: 'Scan for nearby BLE devices (only when not connected)',
      inputSchema: {
        duration: z.number().min(1000).max(30000).default(5000).describe("Scan duration in milliseconds")
      }
    },
    async (args) => {
      const { duration } = args;
      try {
        const devices = await bridgeServer.scanDevices(duration);
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ devices }, null, 2)
          }]
        };
      } catch (error: any) {
        // Handle scan-while-connected error
        if (error.message.includes('Cannot scan while connected')) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: error.message,
                code: 'SCAN_WHILE_CONNECTED'
              }, null, 2)
            }]
          };
        }
        
        throw error;
      }
    }
  );
}