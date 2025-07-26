import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'crypto';
import { Logger } from './logger.js';
import { getPackageMetadata } from './utils.js';
import { toolRegistry } from './mcp-tools.js';

// Transport storage for sessions
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
const logger = new Logger('MCP HTTP');

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
  
  // MCP INFO endpoint - public discovery
  app.get('/mcp/info', (req, res) => {
    try {
      // Validate server is initialized
      if (!server || !toolRegistry) {
        return res.status(500).json({ 
          error: 'Internal server error', 
          message: 'MCP server not initialized' 
        });
      }

      const metadata = getPackageMetadata();
      
      // Set headers
      res.set('Content-Type', 'application/json');
      res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
      
      res.json({
        name: metadata.name,
        version: metadata.version,
        description: metadata.description,
        tools: toolRegistry
      });
    } catch (error: any) {
      logger.error('Error in /mcp/info:', error);
      res.status(500).json({ 
        error: 'Internal server error', 
        message: error.message 
      });
    }
  });

  // MCP REGISTER endpoint - requires auth
  app.post('/mcp/register', authenticate, (req, res) => {
    try {
      // Validate server is initialized
      if (!server) {
        return res.status(500).json({ 
          error: 'Internal server error', 
          message: 'MCP server not initialized' 
        });
      }

      const metadata = getPackageMetadata();
      
      // Set headers
      res.set('Content-Type', 'application/json');
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      
      res.json({
        name: metadata.name,
        version: metadata.version,
        capabilities: {
          tools: true,
          resources: false,
          prompts: false
        }
      });
    } catch (error: any) {
      logger.error('Error in /mcp/register:', error);
      res.status(500).json({ 
        error: 'Internal server error', 
        message: error.message 
      });
    }
  });
  
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
            logger.debug(`New session initialized: ${id}`);
          },
          enableJsonResponse: true // Allow JSON responses for simple testing
        });
        await server.connect(transport);
      }
      
      // handleRequest will handle the response internally
      await transport.handleRequest(req, res, req.body);
    } catch (error: any) {
      logger.error('Error handling request:', error);
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
      logger.error('Error handling SSE request:', error);
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
      logger.debug(`Session terminated: ${sessionId}`);
    }
    
    res.status(204).send();
  });
  
  // Health check endpoint
  app.get('/health', (req, res) => {
    const hasTty = process.stdin.isTTY && process.stdout.isTTY;
    const stdioEnabled = hasTty && !process.env.DISABLE_STDIO;
    
    res.json({ 
      status: 'ok',
      mcp: {
        transports: {
          stdio: stdioEnabled,
          http: true, // Always true if this endpoint is accessible
          httpPort: parseInt(process.env.MCP_PORT || '8081'),
          httpAuth: !!token
        },
        sessions: Object.keys(transports).length
      },
      timestamp: new Date().toISOString()
    });
  });
  
  return app;
}

// Helper to start HTTP server
export function startHttpServer(app: Express, port?: number): void {
  const actualPort = port || parseInt(process.env.MCP_PORT || '8081', 10);
  
  app.listen(actualPort, '0.0.0.0', () => {
    logger.info(`Server listening on 0.0.0.0:${actualPort}`);
    if (process.env.MCP_TOKEN) {
      logger.info('Authentication enabled (Bearer token required)');
    } else {
      logger.warn('⚠️  Running without authentication - local network only!');
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
  logger.info('All sessions closed');
}