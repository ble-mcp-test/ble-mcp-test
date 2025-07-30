import { WebSocketServer } from 'ws';
import noble from '@stoprocent/noble';
import { cleanupNoble } from './utils.js';
import type { SharedState } from './shared-state.js';

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
        // Connect to BLE device directly with timeout
        const timeoutHandle = setTimeout(async () => {
          // Stop scanning if still in progress
          console.log(`[Bridge] Connection timeout - stopping scan`);
          await noble.stopScanningAsync().catch(() => {});
        }, 8000);
        
        await Promise.race([
          this.connectToBLE(config),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Connection timeout')), 8000)
          )
        ]);
        
        clearTimeout(timeoutHandle);
        
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
              console.log(`[Bridge] TX ${data.length} bytes`);
              this.sharedState?.logPacket('TX', data);
              await this.writeChar.writeAsync(Buffer.from(data), false);
            } else if (msg.type === 'force_cleanup') {
              ws.send(JSON.stringify({ type: 'force_cleanup_complete', message: 'Cleanup complete' }));
              this.cleanup();
            }
          } catch (error) {
            console.error('[Bridge] Message error:', error);
          }
        });
        
        // Handle WebSocket close
        ws.on('close', () => {
          console.log(`[Bridge] WebSocket closed`);
          this.cleanup();
        });
        
        // Handle WebSocket errors
        ws.on('error', (error) => {
          console.log(`[Bridge] WebSocket error: ${error.message}`);
          this.cleanup();
        });
        
      } catch (error: any) {
        console.error('[Bridge] Connection error:', error.message);
        // Increment failure count on connection error
        this.consecutiveFailures++;
        // Ensure Noble is cleaned up on error
        await noble.stopScanningAsync().catch(() => {});
        ws.send(JSON.stringify({ type: 'error', error: error.message }));
        this.cleanup();
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
      console.log(`[Bridge] RX ${bytes.length} bytes`);
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
      this.cleanup();
    });
  }
  
  private cleanup() {
    console.log(`[Bridge] ✓ State transition: ${this.state} → disconnecting`);
    this.state = 'disconnecting';
    
    // Set up escalating stuck state detection
    this.setupEscalatingCleanup();
    
    // Clean up BLE
    if (this.peripheral) {
      try {
        if (this.notifyChar) {
          this.notifyChar.unsubscribeAsync().catch(() => {});
        }
        this.peripheral.disconnectAsync().catch(() => {});
      } catch {
        // Ignore cleanup errors during disconnect
      }
      
      // Calculate recovery delay with exponential backoff for consecutive failures
      const baseDelay = this.recoveryDelay;
      const currentDelay = Math.min(
        baseDelay * Math.pow(1.5, this.consecutiveFailures),
        this.maxRecoveryDelay
      );
      
      console.log(`[Bridge] Starting ${Math.round(currentDelay)}ms recovery period (failures: ${this.consecutiveFailures})`);
      this.sharedState?.setConnectionState({ recovering: true });
      
      // Clear any existing recovery timer
      if (this.recoveryTimer) {
        clearTimeout(this.recoveryTimer);
      }
      
      // Also clean up Noble state during recovery
      this.recoveryTimer = setTimeout(async () => {
        try {
          // Ensure Noble is in clean state
          await noble.stopScanningAsync().catch(() => {});
          await cleanupNoble();
        } catch (error) {
          console.error(`[Bridge] Error during Noble cleanup: ${error}`);
        }
        
        // Clear all escalation timers
        this.clearEscalationTimers();
        
        // Transition back to ready state - ready for new connections
        console.log(`[Bridge] ✓ State transition: disconnecting → ready`);
        this.state = 'ready';
        this.sharedState?.setConnectionState({ recovering: false });
        console.log(`[Bridge] Recovery complete, ready for new connections`);
        this.recoveryTimer = null;
      }, currentDelay);
    }
    
    this.peripheral = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.activeConnection = null;
    
    // If no recovery period needed (no peripheral), go straight to ready
    if (this.state === 'disconnecting' && !this.recoveryTimer) {
      console.log(`[Bridge] ✓ State transition: disconnecting → ready (no recovery needed)`);
      this.state = 'ready';
      this.sharedState?.setConnectionState({ recovering: false });
      
      // Clear all escalation timers
      this.clearEscalationTimers();
    }
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
    this.cleanup();
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