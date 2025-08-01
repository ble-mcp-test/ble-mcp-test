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
          await this.handleForceCleanup();
        }
      } catch (error) {
        const errorMessage = translateBluetoothError(error);
        console.error('[WSHandler] Message error:', errorMessage);
        this.sendError(errorMessage);
      }
    });

    // Handle WebSocket close
    this.ws.on('close', () => {
      console.log('[WSHandler] WebSocket closed');
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

  private async handleForceCleanup(): Promise<void> {
    console.log('[WSHandler] Force cleanup requested');
    
    try {
      // Acknowledge the cleanup request
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ 
          type: 'force_cleanup_complete', 
          message: 'Cleanup complete' 
        }));
      }
      
      // Trigger session cleanup
      await this.session.forceCleanup('force cleanup command');
    } catch (error) {
      console.error('[WSHandler] Force cleanup error:', error);
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