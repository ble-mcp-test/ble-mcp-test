import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'crypto';

// Transport storage for sessions
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

export function createHttpApp(server: McpServer, token?: string): Express {
  const app = express();
  
  // Middleware
  app.use(express.json());
  
  // Permissive CORS for local network usage
  app.use(cors({
    origin: '*', // Allow all origins on local network
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
    exposedHeaders: ['Mcp-Session-Id']
  }));
  
  // Optional authentication middleware
  const authenticate = (req: Request, res: Response, next: () => void) => {
    // If no token configured, allow all requests
    if (!token) {
      return next();
    }
    
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    next();
  };
  
  // MCP POST endpoint - main message handling
  app.post('/mcp', authenticate, async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string || randomUUID();
      
      let transport = transports[sessionId];
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
          onsessioninitialized: (id: string) => {
            transports[id] = transport;
            console.log(`[MCP HTTP] New session initialized: ${id}`);
          }
        });
        await server.connect(transport);
      }
      
      // handleRequest will handle the response internally
      await transport.handleRequest(req, res, req.body);
    } catch (error: any) {
      console.error('[MCP HTTP] Error handling request:', error);
      res.status(500).json({ 
        error: 'Internal server error',
        message: error.message 
      });
    }
  });
  
  // MCP GET endpoint - SSE streaming support
  app.get('/mcp', authenticate, async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string;
      const transport = transports[sessionId];
      
      if (!transport) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      // For GET requests, handleRequest will set up SSE streaming
      await transport.handleRequest(req, res);
    } catch (error: any) {
      console.error('[MCP HTTP] Error handling SSE request:', error);
      res.status(500).json({ 
        error: 'Internal server error',
        message: error.message 
      });
    }
  });
  
  // MCP DELETE endpoint - session termination
  app.delete('/mcp', authenticate, (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string;
    const transport = transports[sessionId];
    
    if (transport) {
      transport.close();
      delete transports[sessionId];
      console.log(`[MCP HTTP] Session terminated: ${sessionId}`);
    }
    
    res.status(204).send();
  });
  
  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ 
      status: 'ok',
      sessions: Object.keys(transports).length,
      timestamp: new Date().toISOString()
    });
  });
  
  return app;
}

// Helper to start HTTP server
export function startHttpServer(app: Express, port?: number): void {
  const actualPort = port || parseInt(process.env.MCP_PORT || '3000', 10);
  
  app.listen(actualPort, '0.0.0.0', () => {
    console.log(`[MCP HTTP] Server listening on 0.0.0.0:${actualPort}`);
    if (process.env.MCP_TOKEN) {
      console.log('[MCP HTTP] Authentication enabled (Bearer token required)');
    } else {
      console.log('[MCP HTTP] ⚠️  Running without authentication - local network only!');
    }
  });
}

// Cleanup function for graceful shutdown
export function cleanupHttpTransports(): void {
  Object.keys(transports).forEach(sessionId => {
    const transport = transports[sessionId];
    if (transport) {
      transport.close();
    }
  });
  console.log('[MCP HTTP] All sessions closed');
}