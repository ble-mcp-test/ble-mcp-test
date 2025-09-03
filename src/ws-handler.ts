import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import type { WSMessage } from './ws-transport.js';
import type { BleSession } from './ble-session.js';
import type { SharedState } from './shared-state.js';
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
    private sharedState?: SharedState
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
        console.log(`[WSHandler] Received message type: ${msg.type}`);
        
        // Handle data messages
        if (msg.type === 'data' && msg.data) {
          const data = new Uint8Array(msg.data);
          const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
          console.log(`[WSHandler] TX: ${hex}`);
          this.sharedState?.logPacket('TX', data);
          
          await this.session.write(data);
        } 
        // Handle force cleanup command
        else if (msg.type === 'force_cleanup') {
          await this.handleForceCleanup(msg);
        }
        // Handle admin cleanup command
        else if (msg.type === 'admin_cleanup') {
          await this.handleAdminCleanup(msg);
        }
      } catch (error) {
        const errorMessage = translateBluetoothError(error);
        console.error('[WSHandler] Message error:', errorMessage);
        this.sendError(errorMessage);
      }
    });

    // Handle WebSocket close
    this.ws.on('close', (code, reason) => {
      console.log(`[WSHandler] WebSocket closed - code: ${code}, reason: ${reason || 'none'}, session: ${this.session.sessionId}`);
      this.session.removeWebSocket(this.ws);
      this.emit('close');
    });

    // Handle WebSocket errors
    this.ws.on('error', (error) => {
      console.log('[WSHandler] WebSocket error:', error.message);
      this.session.removeWebSocket(this.ws);
      this.emit('error', error);
    });
  }

  private setupSessionHandlers(): void {
    // Forward BLE data to WebSocket
    const dataHandler = (data: Uint8Array) => {
      if (this.ws.readyState === this.ws.OPEN) {
        const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`[WSHandler] RX: ${hex}`);
        
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

  private async handleForceCleanup(msg: WSMessage): Promise<void> {
    console.log('[WSHandler] Force cleanup requested', msg.all_sessions ? '(all sessions)' : '(current session)');
    console.warn('[WSHandler] WARNING: Force cleanup is broken and creates zombies - avoid using');
    
    try {
      // Send warning about broken force cleanup
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ 
          type: 'warning',
          warning: 'forceCleanup() is currently not working as expected - it creates zombie connections. Do not use it. If you are stuck, please open an issue at https://github.com/ble-mcp-test/ble-mcp-test/issues',
          message: 'Using normal disconnect instead'
        }));
      }
      
      // Use normal disconnect instead of force cleanup
      console.log('[WSHandler] Using normal disconnect instead of broken force cleanup');
      
      // Just disconnect normally - don't use force cleanup
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ 
          type: 'force_cleanup_complete', 
          message: 'Used normal disconnect instead',
          warning: 'forceCleanup() is not working as expected. Please report issues at https://github.com/ble-mcp-test/ble-mcp-test/issues' 
        }));
        
        // Give message time to send before closing
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Now close the WebSocket
        this.ws.close();
      }
    } catch (error) {
      console.error('[WSHandler] Force cleanup error:', error);
    }
  }

  private async handleAdminCleanup(msg: WSMessage): Promise<void> {
    console.log('[WSHandler] Admin cleanup requested');
    
    // Check auth token
    const requiredAuth = process.env.BLE_ADMIN_AUTH_TOKEN;
    if (requiredAuth && msg.auth !== requiredAuth) {
      console.log('[WSHandler] Admin cleanup rejected - invalid auth');
      this.sendError('Unauthorized');
      return;
    }
    
    try {
      // Get session manager through session's config
      const sessionManager = (this.session as any).sessionManager;
      if (sessionManager && msg.action === 'cleanup_all') {
        await sessionManager.forceCleanupAll('admin cleanup');
        
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
    } catch (error) {
      console.error('[WSHandler] Admin cleanup error:', error);
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