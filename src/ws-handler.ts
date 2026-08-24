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
          this.sharedState?.logPacket('RX', data);
          await this.session.write(data);
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
        this.sharedState?.logPacket('TX', data);
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

  getStatus() {
    return {
      connected: this.ws.readyState === this.ws.OPEN,
      lastActivity: this.lastActivity,
      sessionId: this.session.sessionId
    };
  }
}