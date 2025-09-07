import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import type { WSMessage } from './ws-transport.js';
import type { BleSession } from './ble-session.js';
import type { SharedState } from './shared-state.js';
import type { SessionManager } from './session-manager.js';
import { translateBluetoothError } from './bluetooth-errors.js';

/**
 * WebSocketHandler - Manages individual WebSocket connections and message routing
 * 
 * Responsibilities:
 * - Handle WebSocket message parsing and validation
 * - Route messages to BLE session
 * - Forward BLE data to WebSocket
 * - Manage WebSocket lifecycle events
 * 
 * Events:
 * - 'close': () - WebSocket connection closed
 * - 'error': (error: any) - WebSocket error occurred
 */
export class WebSocketHandler extends EventEmitter {
  private lastActivity = Date.now();
  
  constructor(
    private ws: WebSocket,
    private session: BleSession,
    private sharedState?: SharedState,
    private sessionManager?: SessionManager
  ) {
    super();
    this.setupWebSocketHandlers();
    this.setupSessionHandlers();
    this.session.addWebSocket(ws);
  }

  private setupWebSocketHandlers(): void {
    // Handle incoming WebSocket messages
    this.ws.on('message', async (message) => {
      this.lastActivity = Date.now();
      
      try {
        const msg: WSMessage = JSON.parse(message.toString());
        
        // Handle data messages
        if (msg.type === 'data' && msg.data) {
          const data = new Uint8Array(msg.data);
          this.sharedState?.logPacket('TX', data);
          await this.session.write(data);
        } 
        // Handle force cleanup command
        else if (msg.type === 'force_cleanup') {
          await this.handleForceCleanup(msg);
        }
        // Handle session cleanup command (for tests)
        else if (msg.type === 'cleanup_session') {
          await this.handleSessionCleanup(msg);
        }
        // Handle admin cleanup command
        else if (msg.type === 'admin_cleanup') {
          await this.handleAdminCleanup(msg);
        }
      } catch (error) {
        const errorMessage = translateBluetoothError(error);
        this.sendError(errorMessage);
      }
    });

    // Handle WebSocket close
    this.ws.on('close', () => {
      this.session.removeWebSocket(this.ws);
      this.emit('close');
    });

    // Handle WebSocket errors
    this.ws.on('error', (error) => {
      this.session.removeWebSocket(this.ws);
      this.emit('error', error);
    });
  }

  private setupSessionHandlers(): void {
    // Forward BLE data to WebSocket
    const dataHandler = (data: Uint8Array) => {
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ 
          type: 'data', 
          data: Array.from(data) 
        }));
      }
    };

    // Handle session events
    this.session.on('data', dataHandler);
    
    // Clean up listeners when WebSocket closes
    this.once('close', () => {
      this.session.removeListener('data', dataHandler);
    });
  }

  private sendError(error: string): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify({ type: 'error', error }));
    }
  }

  private async handleSessionCleanup(_msg: WSMessage): Promise<void> {
    try {
      // Clean up the current session (including transport)
      await this.session.cleanup('session cleanup requested');
      
      // Clear from session manager
      if (this.sessionManager) {
        const allSessions = this.sessionManager.getAllSessions();
        const thisSession = allSessions.find(s => s.sessionId === this.session.sessionId);
        if (thisSession) {
          // This will remove it from the map
          this.sessionManager.clearSession(this.session.sessionId);
        }
      }
      
      // Send confirmation
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ 
          type: 'session_cleanup_complete', 
          sessionId: this.session.sessionId,
          message: 'Session cleaned up successfully'
        }));
        
        // Give message time to send before closing
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Now close the WebSocket
        this.ws.close();
      }
    } catch (error) {
      this.sendError(`Session cleanup failed: ${error}`);
    }
  }

  private async handleForceCleanup(_msg: WSMessage): Promise<void> {
    try {
      // Send warning about broken force cleanup
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ 
          type: 'warning',
          warning: 'forceCleanup() is currently not working as expected - it creates zombie connections. Do not use it.',
          message: 'Using normal disconnect instead'
        }));
      }
      
      // Just disconnect normally - don't use force cleanup
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ 
          type: 'force_cleanup_complete', 
          message: 'Used normal disconnect instead',
          warning: 'forceCleanup() is not working as expected.' 
        }));
        
        // Give message time to send before closing
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Now close the WebSocket
        this.ws.close();
      }
    } catch {
      // Ignore errors
    }
  }

  private async handleAdminCleanup(msg: WSMessage): Promise<void> {
    // Check auth token
    const requiredAuth = process.env.BLE_ADMIN_AUTH_TOKEN;
    if (requiredAuth && msg.auth !== requiredAuth) {
      this.sendError('Unauthorized');
      return;
    }
    
    try {
      // Use properly injected SessionManager
      if (this.sessionManager && msg.action === 'cleanup_all') {
        await this.sessionManager.forceCleanupAll('admin cleanup');
        
        if (this.ws.readyState === this.ws.OPEN) {
          this.ws.send(JSON.stringify({ 
            type: 'admin_cleanup_complete', 
            message: 'All sessions cleaned up',
            action: msg.action
          }));
        }
      } else {
        this.sendError('Invalid admin action');
      }
    } catch {
      this.sendError('Admin cleanup failed');
    }
  }

  getStatus() {
    return {
      connected: this.ws.readyState === this.ws.OPEN,
      lastActivity: this.lastActivity,
      sessionId: this.session.sessionId
    };
  }
}