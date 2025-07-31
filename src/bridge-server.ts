import { WebSocketServer } from 'ws';
import noble from '@stoprocent/noble';
import { cleanupNoble, withTimeout } from './utils.js';
import type { SharedState } from './shared-state.js';
import { translateBluetoothError } from './bluetooth-errors.js';

/**
 * ULTRA SIMPLE WebSocket-to-BLE Bridge v0.4.0
 * 
 * One connection, one device, pure plumbing.
 * No state machines, no tokens, no timers, no managers.
 * Target: <200 lines total
 */

type BridgeState = 'ready' | 'connecting' | 'active' | 'disconnecting';

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private state: BridgeState = 'ready'; // THE state
  private activeConnection: any = null; // WebSocket reference
  private peripheral: any = null;
  private writeChar: any = null;
  private notifyChar: any = null;
  private recoveryDelay = parseInt(process.env.BLE_MCP_RECOVERY_DELAY || '5000', 10);
  private sharedState: SharedState | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private stuckStateTimer: NodeJS.Timeout | null = null;
  private escalationTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private maxRecoveryDelay = 30000; // Max 30s recovery delay
  private stuckStateCount = 0;
  
  constructor(logLevel?: string, sharedState?: SharedState) {
    // Ultra simple - just log level for compatibility
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
      const config = {
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
        // Connect to BLE device with timeout and cleanup
        await withTimeout(
          this.connectToBLE(config),
          8000,
          async () => {
            console.log(`[Bridge] Connection timeout - stopping scan`);
            await noble.stopScanningAsync().catch(() => {});
            // For timeout errors, go through cleanup to ensure recovery period
            // This handles cases where device disconnects during connection attempt
            this.disconnectCleanupRecover({ reason: 'connection timeout', isClean: false });
          }
        );
        
        // Connected! Reset failure count and transition to active state
        this.consecutiveFailures = 0;
        console.log(`[Bridge] ✓ State transition: connecting → active`);
        this.state = 'active';
        const deviceName = this.peripheral?.advertisement?.localName || this.peripheral?.id || 'Unknown';
        console.log(`[Bridge] Connected to ${deviceName}`);
        this.sharedState?.setConnectionState({ connected: true, deviceName });
        ws.send(JSON.stringify({ type: 'connected', device: deviceName }));
        
        // Handle WebSocket messages
        ws.on('message', async (message) => {
          try {
            const msg = JSON.parse(message.toString());
            if (msg.type === 'data' && this.writeChar) {
              const data = new Uint8Array(msg.data);
              const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
              console.log(`[Bridge] TX: ${hex}`);
              this.sharedState?.logPacket('TX', data);
              await this.writeChar.writeAsync(Buffer.from(data), false);
            } else if (msg.type === 'force_cleanup') {
              ws.send(JSON.stringify({ type: 'force_cleanup_complete', message: 'Cleanup complete' }));
              this.disconnectCleanupRecover({ reason: 'force cleanup command', isClean: true });
            }
          } catch (error) {
            console.error('[Bridge] Message error:', error);
          }
        });
        
        // Handle WebSocket close
        ws.on('close', () => {
          console.log(`[Bridge] WebSocket closed`);
          this.disconnectCleanupRecover({ reason: 'websocket closed', isClean: true });
        });
        
        // Handle WebSocket errors
        ws.on('error', (error) => {
          console.log(`[Bridge] WebSocket error: ${error.message}`);
          this.disconnectCleanupRecover({ reason: 'websocket error', error: error, isClean: false });
        });
        
      } catch (error: any) {
        // All error handling is done in disconnectCleanupRecover
        await this.disconnectCleanupRecover({ reason: 'connection error', error: error, isClean: false });
      }
    });
  }
  
  private async connectToBLE(config: any) {
    console.log(`[Bridge] Connecting to BLE device ${config.devicePrefix}`);
    
    // Wait for Noble to be ready
    if (noble.state !== 'poweredOn') {
      console.log(`[Bridge] Noble state: ${noble.state}, waiting for power on...`);
      await noble.waitForPoweredOnAsync();
    }
    
    // Always stop any existing scan first
    console.log(`[Bridge] Ensuring clean scan state...`);
    await noble.stopScanningAsync().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 500)); // Let it settle
    
    // Scan for device (allowDuplicates: true is critical for CS108 on Linux)
    console.log(`[Bridge] Starting BLE scan...`);
    await noble.startScanningAsync([], true);
    
    this.peripheral = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        noble.removeListener('discover', onDiscover);
        noble.stopScanningAsync();
        reject(new Error(`Device ${config.devicePrefix} not found`));
      }, 15000);
      
      const onDiscover = (device: any) => {
        const name = device.advertisement.localName || '';
        const id = device.id;
        
        if ((name && name.startsWith(config.devicePrefix)) || id === config.devicePrefix) {
          clearTimeout(timeout);
          noble.removeListener('discover', onDiscover);
          noble.stopScanningAsync();
          resolve(device);
        }
      };
      
      noble.on('discover', onDiscover);
    });
    
    // Connect to peripheral
    await this.peripheral.connectAsync();
    
    // Find service and characteristics
    const services = await this.peripheral.discoverServicesAsync();
    const targetService = services.find((s: any) => 
      s.uuid === config.serviceUuid || 
      s.uuid === config.serviceUuid.toLowerCase().replace(/-/g, '')
    );
    
    if (!targetService) {
      throw new Error(`Service ${config.serviceUuid} not found`);
    }
    
    const characteristics = await targetService.discoverCharacteristicsAsync();
    
    this.writeChar = characteristics.find((c: any) => 
      c.uuid === config.writeUuid || 
      c.uuid === config.writeUuid.toLowerCase().replace(/-/g, '')
    );
    
    this.notifyChar = characteristics.find((c: any) => 
      c.uuid === config.notifyUuid || 
      c.uuid === config.notifyUuid.toLowerCase().replace(/-/g, '')
    );
    
    if (!this.writeChar || !this.notifyChar) {
      throw new Error('Required characteristics not found');
    }
    
    // Subscribe to notifications
    this.notifyChar.on('data', (data: Buffer) => {
      const bytes = new Uint8Array(data);
      const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`[Bridge] RX: ${hex}`);
      this.sharedState?.logPacket('RX', bytes);
      if (this.activeConnection) {
        this.activeConnection.send(JSON.stringify({ type: 'data', data: Array.from(bytes) }));
      }
    });
    
    await this.notifyChar.subscribeAsync();
    
    // Handle unexpected disconnect
    this.peripheral.once('disconnect', () => {
      console.log(`[Bridge] Device disconnected`);
      this.sharedState?.setConnectionState({ connected: false, deviceName: null });
      if (this.activeConnection) {
        this.activeConnection.send(JSON.stringify({ type: 'disconnected' }));
      }
      this.disconnectCleanupRecover({ reason: 'device disconnected', isClean: true });
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
      
      // Increment failure count on errors
      if (!context.isClean) {
        this.consecutiveFailures++;
      }
    }
    
    // Set up escalating stuck state detection
    this.setupEscalatingCleanup();
    
    // CRITICAL: Always stop any active scanning first
    // This prevents zombie connections where device thinks it's connected but bridge doesn't
    try {
      await noble.stopScanningAsync();
    } catch (error) {
      console.error(`[Bridge] Error stopping scan:`, error);
    }
    
    // Clean up BLE peripheral if exists
    if (this.peripheral) {
      console.log(`[Bridge] CRITICAL: Forcing peripheral disconnect to prevent zombie connection`);
      try {
        // Unsubscribe from notifications
        if (this.notifyChar) {
          await this.notifyChar.unsubscribeAsync().catch(() => {});
        }
        
        // Force disconnect - don't trust the state, just disconnect
        await this.peripheral.disconnectAsync();
      } catch (error) {
        console.error(`[Bridge] Error during forced disconnect:`, error);
      }
    }
    
    // Clear references
    this.peripheral = null;
    this.writeChar = null;
    this.notifyChar = null;
    
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
    
    // Update shared state
    this.sharedState?.setConnectionState({ connected: false, deviceName: null });
    
    // Calculate recovery delay based on context
    const currentDelay = context.isClean || this.consecutiveFailures === 0
      ? 1000 // Clean disconnect: 1s recovery
      : Math.min(
          this.recoveryDelay * Math.pow(1.5, this.consecutiveFailures),
          this.maxRecoveryDelay
        );
    
    console.log(`[Bridge] Starting ${Math.round(currentDelay)}ms recovery period (failures: ${this.consecutiveFailures})`);
    this.sharedState?.setConnectionState({ recovering: true });
    
    // Clear any existing recovery timer
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
    }
    
    // Set recovery timer
    this.recoveryTimer = setTimeout(async () => {
      try {
        // Final Noble cleanup
        await cleanupNoble();
      } catch (error) {
        console.error(`[Bridge] Error during Noble cleanup:`, error);
      }
      
      // Clear all escalation timers
      this.clearEscalationTimers();
      
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
  
  private setupEscalatingCleanup() {
    // Clear any existing escalation
    this.clearEscalationTimers();
    
    // Level 1: Basic stuck detection (3 seconds)
    this.stuckStateTimer = setTimeout(() => {
      if (this.state === 'disconnecting') {
        console.log(`[Bridge] 🟨 Level 1: Basic stuck detection - attempting gentle cleanup`);
        this.escalateCleanup(1);
      }
    }, 3000);
  }
  
  private escalateCleanup(level: number) {
    if (this.state !== 'disconnecting') return;
    
    this.stuckStateCount++;
    console.log(`[Bridge] ${'🔧🔨💥'[level-1]} Level ${level} cleanup:`);
    
    // Each level performs previous levels + additional steps (cascading)
    if (level >= 1) this.gentleDisconnect();
    if (level >= 2) this.aggressiveCleanup();
    if (level >= 3) this.forceReady();
    
    // Schedule next level if not nuclear (level 3)
    if (level < 3) {
      this.escalationTimer = setTimeout(() => {
        if (this.state === 'disconnecting') {
          this.escalateCleanup(level + 1);
        }
      }, 5000);
    }
  }
  
  private gentleDisconnect() {
    if (this.peripheral) {
      try {
        this.peripheral.disconnect();
      } catch (e) {
        console.log(`[Bridge] Gentle disconnect failed: ${e}`);
      }
    }
  }
  
  private async aggressiveCleanup() {
    try {
      // Stop scanning and remove listeners
      await noble.stopScanningAsync().catch(() => {});
      noble.removeAllListeners();
      
      // Multiple disconnect attempts
      if (this.peripheral) {
        try {
          await this.peripheral.disconnectAsync().catch(() => {});
          this.peripheral.removeAllListeners();
        } catch (e) {
          console.log(`[Bridge] Aggressive disconnect failed: ${e}`);
        }
      }
      
      // Clean up characteristics
      if (this.notifyChar) {
        await this.notifyChar.unsubscribeAsync().catch(() => {});
        this.notifyChar.removeAllListeners();
      }
    } catch (error) {
      console.error(`[Bridge] Aggressive cleanup error: ${error}`);
    }
  }
  
  private forceReady() {
    // Clear all timers and force state
    this.clearEscalationTimers();
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    
    this.state = 'ready';
    this.sharedState?.setConnectionState({ connected: false, deviceName: null, recovering: false });
    
    // Clean up resources
    this.peripheral = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.activeConnection = null;
    
    // Significant failure penalty for nuclear reset
    this.consecutiveFailures += 2;
    this.stuckStateCount = 0;
    
    console.log(`[Bridge] Ready for new connections (failures: ${this.consecutiveFailures})`);
  }
  
  private clearEscalationTimers() {
    if (this.stuckStateTimer) {
      clearTimeout(this.stuckStateTimer);
      this.stuckStateTimer = null;
    }
    if (this.escalationTimer) {
      clearTimeout(this.escalationTimer);
      this.escalationTimer = null;
    }
  }
  
  async stop() {
    console.log('[Bridge] Stopping...');
    this.disconnectCleanupRecover({ reason: 'server stopping', isClean: true });
    if (this.wss) {
      this.wss.close();
    }
    // Clear recovery timer on stop
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }
  
  // Compatibility methods for tests
  // Minimal observability interface
  getConnectionState() {
    return {
      connected: this.state === 'active',
      deviceName: this.peripheral?.advertisement?.localName || null,
      recovering: this.state === 'disconnecting',
      state: this.state
    };
  }
  
  async scanDevices(): Promise<any[]> {
    return []; // Ultra simple - no scanning
  }
}