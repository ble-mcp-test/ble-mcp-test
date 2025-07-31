import { WebSocketServer } from 'ws';
import { withTimeout } from './utils.js';
import type { SharedState } from './shared-state.js';
import { translateBluetoothError } from './bluetooth-errors.js';
import { NobleTransport, type BleConfig } from './noble-transport.js';

/**
 * ULTRA SIMPLE WebSocket-to-BLE Bridge v0.4.5
 * 
 * WebSocket server that manages connection state and routes messages.
 * All BLE logic delegated to NobleTransport.
 */

type BridgeState = 'ready' | 'connecting' | 'active' | 'ws-closed' | 'disconnecting';

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private state: BridgeState = 'ready';
  private activeConnection: any = null; // WebSocket reference
  private transport: NobleTransport | null = null;
  private deviceName: string | null = null;
  private recoveryDelay = parseInt(process.env.BLE_MCP_RECOVERY_DELAY || '5000', 10);
  private sharedState: SharedState | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private maxRecoveryDelay = 30000; // Max 30s recovery delay
  
  constructor(logLevel?: string, sharedState?: SharedState) {
    this.sharedState = sharedState || null;
    console.log(`[Bridge] Recovery delay configured: ${this.recoveryDelay}ms`);
  }

  async start(port = 8080) {
    this.wss = new WebSocketServer({ port });
    console.log(`🚀 Ultra simple bridge listening on port ${port}`);
    
    this.wss.on('connection', async (ws, req) => {
      // Parse BLE config from URL
      const url = new URL(req.url || '', 'http://localhost');
      
      // ONE RULE: Only ready state accepts new connections
      if (this.state !== 'ready') {
        console.log(`[Bridge] ❌ Connection rejected - state: ${this.state} (only 'ready' accepts new connections)`);
        ws.send(JSON.stringify({ type: 'error', error: `Bridge is ${this.state} - only ready state accepts connections` }));
        ws.close();
        return;
      }
      
      // Accept connection and transition to connecting state
      console.log(`[Bridge] ✓ Connection accepted - state transition: ready → connecting`);
      this.state = 'connecting';
      
      // Parse BLE config from URL
      const config: BleConfig = {
        devicePrefix: url.searchParams.get('device') || '',
        serviceUuid: url.searchParams.get('service') || '',
        writeUuid: url.searchParams.get('write') || '',
        notifyUuid: url.searchParams.get('notify') || ''
      };
      
      if (!config.devicePrefix || !config.serviceUuid || !config.writeUuid || !config.notifyUuid) {
        ws.send(JSON.stringify({ type: 'error', error: 'Missing required parameters: device, service, write, notify' }));
        ws.close();
        this.state = 'ready'; // Go back to ready state on early error
        return;
      }
      
      console.log(`[Bridge] New connection: ${config.devicePrefix}`);
      this.activeConnection = ws;
      
      try {
        // Create transport and set up event handlers
        this.transport = new NobleTransport();
        
        // Set up event handlers before connecting
        this.transport.on('data', (data: Uint8Array) => {
          const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
          console.log(`[Bridge] RX: ${hex}`);
          this.sharedState?.logPacket('RX', data);
          if (this.activeConnection) {
            this.activeConnection.send(JSON.stringify({ type: 'data', data: Array.from(data) }));
          }
        });
        
        this.transport.on('disconnect', () => {
          console.log(`[Bridge] 🔄 Transport disconnect event - Setting SharedState: connected=false`);
          this.sharedState?.setConnectionState({ connected: false, deviceName: null });
          if (this.activeConnection) {
            this.activeConnection.send(JSON.stringify({ type: 'disconnected' }));
          }
          this.disconnectCleanupRecover({ reason: 'device disconnected', isClean: true });
        });
        
        this.transport.on('error', (error) => {
          this.disconnectCleanupRecover({ reason: 'transport error', error, isClean: false });
        });
        
        // Connect (transport handles all timeouts internally)
        console.log(`[Bridge] Attempting connection to ${config.devicePrefix || config} (attempt #${this.consecutiveFailures + 1})`);
        const startTime = Date.now();
        try {
          this.deviceName = await this.transport.connect(config);
          const connectTime = Date.now() - startTime;
          console.log(`[Bridge] Connection successful after ${connectTime}ms`);
        } catch (connectError) {
          const failTime = Date.now() - startTime;
          console.error(`[Bridge] Connection failed after ${failTime}ms`);
          throw connectError;
        }
        
        // Connected! Reset failure count and transition to active state
        this.consecutiveFailures = 0;
        console.log(`[Bridge] ✓ State transition: connecting → active`);
        this.state = 'active';
        console.log(`[Bridge] Connected to ${this.deviceName}`);
        console.log(`[Bridge] 🔄 Setting SharedState: connected=true, deviceName=${this.deviceName}`);
        this.sharedState?.setConnectionState({ connected: true, deviceName: this.deviceName });
        ws.send(JSON.stringify({ type: 'connected', device: this.deviceName }));
        
        // Handle WebSocket messages
        ws.on('message', async (message) => {
          try {
            const msg = JSON.parse(message.toString());
            if (msg.type === 'data' && this.transport) {
              const data = new Uint8Array(msg.data);
              const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
              console.log(`[Bridge] TX: ${hex}`);
              this.sharedState?.logPacket('TX', data);
              await this.transport.write(data);
            } else if (msg.type === 'force_cleanup') {
              ws.send(JSON.stringify({ type: 'force_cleanup_complete', message: 'Cleanup complete' }));
              this.disconnectCleanupRecover({ reason: 'force cleanup command', isClean: true });
            }
          } catch (error) {
            const errorMessage = translateBluetoothError(error);
            console.error('[Bridge] Message error:', errorMessage);
          }
        });
        
        // Handle WebSocket close
        ws.on('close', () => {
          console.log(`[Bridge] WebSocket closed`);
          this.state = 'ws-closed';  // Transitional state - WebSocket closed, cleanup starting
          this.disconnectCleanupRecover({ reason: 'websocket closed', isClean: true });
        });
        
        // Handle WebSocket errors
        ws.on('error', (error) => {
          console.log(`[Bridge] WebSocket error: ${error.message}`);
          this.state = 'ws-closed';  // Transitional state - WebSocket error, cleanup starting
          this.disconnectCleanupRecover({ reason: 'websocket error', error: error, isClean: false });
        });
        
      } catch (error: any) {
        // All error handling is done in disconnectCleanupRecover
        await this.disconnectCleanupRecover({ reason: 'connection error', error: error, isClean: false });
      }
    });
  }
  
  /**
   * Unified disconnect, cleanup, and recovery function
   * All disconnect paths lead here to ensure consistent behavior
   */
  private async disconnectCleanupRecover(context: { 
    reason: string, 
    error?: any,
    isClean?: boolean 
  }) {
    // Prevent re-entry if already disconnecting
    if (this.state === 'disconnecting') {
      console.log(`[Bridge] Already disconnecting, ignoring additional cleanup request`);
      return;
    }
    
    console.log(`[Bridge] ✓ State transition: ${this.state} → disconnecting (reason: ${context.reason})`);
    this.state = 'disconnecting';
    
    // Log error details if present
    if (context.error) {
      const errorMessage = translateBluetoothError(context.error);
      console.error(`[Bridge] Disconnect due to error: ${errorMessage}`);
      
      if (typeof context.error === 'number' || (!context.error?.message && context.error !== undefined)) {
        console.error(`[Bridge] Full error object:`, context.error);
      }
      
      // Special logging for error 62 (Connection Failed to be Established)
      if (context.error === 62 || context.error?.code === 62) {
        console.error(`[Bridge] Error 62 details:`);
        console.error(`  - Current state: ${this.state}`);
        console.error(`  - Transport connected: ${this.transport ? 'yes' : 'no'}`);
        console.error(`  - Device name: ${this.deviceName || 'none'}`);
        console.error(`  - Consecutive failures: ${this.consecutiveFailures}`);
        console.error(`  - Recovery will take: ${this.recoveryDelay * Math.pow(1.5, this.consecutiveFailures + 1)}ms`);
      }
      
      // Increment failure count on errors
      if (!context.isClean) {
        this.consecutiveFailures++;
      }
    }
    
    // Disconnect transport
    if (this.transport) {
      try {
        if (context.error && !context.isClean) {
          // Error case: KILL IT WITH FIRE! 🔥
          console.log(`[Bridge] Error detected - using force cleanup with Noble stack reset`);
          await this.transport.forceCleanup();
        } else {
          // Clean disconnect: be polite
          await this.transport.disconnect();
        }
      } catch (error) {
        console.error(`[Bridge] Error during transport cleanup:`, error);
      }
      this.transport = null;
    }
    
    // Notify WebSocket client if still connected
    if (this.activeConnection && this.activeConnection.readyState === 1) {
      try {
        if (context.error && !context.isClean) {
          const errorMessage = translateBluetoothError(context.error);
          this.activeConnection.send(JSON.stringify({ type: 'error', error: errorMessage }));
        }
        this.activeConnection.send(JSON.stringify({ type: 'disconnected' }));
      } catch {}
    }
    this.activeConnection = null;
    this.deviceName = null;
    
    // Update shared state
    console.log(`[Bridge] 🔄 Disconnect cleanup - Setting SharedState: connected=false`);
    this.sharedState?.setConnectionState({ connected: false, deviceName: null });
    
    // Calculate recovery delay based on context
    let currentDelay = context.isClean || this.consecutiveFailures === 0
      ? 250 // Clean disconnect: 250ms recovery (was 1000ms)
      : Math.min(
          this.recoveryDelay * Math.pow(1.5, this.consecutiveFailures),
          this.maxRecoveryDelay
        );
    
    // Special handling for error 62 - give device extra time to reset
    if (context.error === 62 || context.error?.code === 62) {
      console.log(`[Bridge] Error 62 detected - adding extra recovery time`);
      currentDelay = Math.max(currentDelay, 10000); // At least 10 seconds for error 62
    }
    
    console.log(`[Bridge] Starting ${Math.round(currentDelay)}ms recovery period (failures: ${this.consecutiveFailures})`);
    this.sharedState?.setConnectionState({ recovering: true });
    
    // Clear any existing recovery timer
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
    }
    
    // Set recovery timer
    this.recoveryTimer = setTimeout(() => {
      // Reset failure count on clean disconnects
      if (context.isClean) {
        this.consecutiveFailures = 0;
      }
      
      // Transition back to ready state
      console.log(`[Bridge] ✓ State transition: disconnecting → ready`);
      this.state = 'ready';
      this.sharedState?.setConnectionState({ recovering: false });
      console.log(`[Bridge] Recovery complete, ready for new connections`);
      this.recoveryTimer = null;
    }, currentDelay);
  }
  
  async stop() {
    console.log('[Bridge] Stopping...');
    await this.disconnectCleanupRecover({ reason: 'server stopping', isClean: true });
    if (this.wss) {
      this.wss.close();
    }
    // Clear recovery timer on stop
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }
  
  // Minimal observability interface
  getConnectionState() {
    return {
      connected: this.state === 'active',
      deviceName: this.deviceName,
      recovering: this.state === 'disconnecting',
      state: this.state
    };
  }
  
  async scanDevices(): Promise<any[]> {
    return []; // Ultra simple - no scanning
  }
}