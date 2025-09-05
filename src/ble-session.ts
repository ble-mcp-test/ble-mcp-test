import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import { NobleTransport, type BleConfig } from './noble-transport.js';
import type { SharedState } from './shared-state.js';
import { MetricsTracker } from './connection-metrics.js';
import { BLEConnectionError } from './constants.js';
import noble from '@stoprocent/noble';
import { expandUuidVariants } from './utils.js';

/**
 * BLE Session - Manages a persistent BLE connection that can survive WebSocket disconnects
 * 
 * Features:
 * - Multiple WebSockets can attach to same BLE connection
 * - Grace period keeps BLE alive after WebSocket disconnect
 * - Idle timeout kicks inactive sessions
 * - Clean state management and logging
 */
export class BleSession extends EventEmitter {
  private transport: NobleTransport | null = null;
  private activeWebSockets = new Set<WebSocket>();
  private deviceName: string | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastTxTime = Date.now();
  public sessionManager?: any; // Reference to SessionManager for cleanup commands
  
  // Timeout configuration (in seconds)
  private gracePeriodSec = parseInt(process.env.BLE_SESSION_GRACE_PERIOD_SEC || process.env.BLE_MCP_GRACE_PERIOD || '60', 10);
  private idleTimeoutSec = parseInt(process.env.BLE_SESSION_IDLE_TIMEOUT_SEC || process.env.BLE_MCP_IDLE_TIMEOUT || '300', 10);
  
  constructor(
    public readonly sessionId: string,
    private config: BleConfig,
    private sharedState: SharedState | null = null
  ) {
    super();
    console.log(`[Session:${sessionId}] Created with grace=${this.gracePeriodSec}s, idle=${this.idleTimeoutSec}s`);
  }

  /**
   * Connect to BLE device with atomic validation
   * WebSocket connections are only accepted after complete BLE stack validation
   */
  async connect(): Promise<string> {
    const metrics = MetricsTracker.getInstance();
    
    if (this.transport && this.deviceName) {
      console.log(`[Session:${this.sessionId}] Reusing existing BLE connection to ${this.deviceName}`);
      metrics.recordReconnection(this.sessionId);
      return this.deviceName;
    }

    console.log(`[Session:${this.sessionId}] Starting atomic BLE validation`);
    metrics.recordConnectionAttempt();

    let peripheral: any = null;
    
    try {
      // STEP 1: Validate Noble state
      if (noble.state !== 'poweredOn') {
        console.log(`[Session:${this.sessionId}] Noble state: ${noble.state}, waiting for power on...`);
        await this.withTimeout(
          noble.waitForPoweredOnAsync(), 
          15000,
          'Bluetooth adapter timeout - check if Bluetooth is enabled'
        );
      }

      // STEP 2: Find device - throw HARDWARE_NOT_FOUND if not found
      console.log(`[Session:${this.sessionId}] Scanning for BLE device...`);
      peripheral = await this.findDevice();
      if (!peripheral) {
        throw new BLEConnectionError('HARDWARE_NOT_FOUND', 'No CS108 devices found matching configuration');
      }
      
      const deviceName = peripheral.advertisement.localName || peripheral.id;
      console.log(`[Session:${this.sessionId}] Found device: ${deviceName}`);

      // STEP 3: Connect to GATT - throw GATT_CONNECTION_FAILED if fails
      console.log(`[Session:${this.sessionId}] Connecting to GATT server...`);
      await this.withTimeout(
        peripheral.connectAsync(),
        10000,
        'GATT connection timeout'
      );

      // STEP 4: Discover services - throw SERVICE_NOT_FOUND if missing
      console.log(`[Session:${this.sessionId}] Discovering services...`);
      const services = await this.withTimeout(
        peripheral.discoverServicesAsync(),
        10000,
        'Service discovery timeout'
      );

      // Find the target service using UUID variants
      let targetService: any = null;
      for (const service of services as any[]) {
        const sUuid = service.uuid.toLowerCase().replace(/-/g, '');
        const configUuidVariants = expandUuidVariants(this.config.serviceUuid);
        if (configUuidVariants.some(variant => sUuid === variant)) {
          targetService = service;
          console.log(`[Session:${this.sessionId}] Found service using UUID format: ${sUuid}`);
          break;
        }
      }

      if (!targetService) {
        await peripheral.disconnectAsync();
        throw new BLEConnectionError('SERVICE_NOT_FOUND', `Service ${this.config.serviceUuid} not found on device`);
      }

      // STEP 5: Discover characteristics - throw CHARACTERISTICS_NOT_FOUND if missing
      console.log(`[Session:${this.sessionId}] Discovering characteristics...`);
      const characteristics = await this.withTimeout(
        targetService.discoverCharacteristicsAsync(),
        10000,
        'Characteristic discovery timeout'
      );

      // Find required characteristics using UUID variants
      const writeChar = (characteristics as any[]).find((c: any) => {
        const cUuid = c.uuid.toLowerCase().replace(/-/g, '');
        const writeVariants = expandUuidVariants(this.config.writeUuid);
        return writeVariants.some(variant => cUuid === variant);
      });

      const notifyChar = (characteristics as any[]).find((c: any) => {
        const cUuid = c.uuid.toLowerCase().replace(/-/g, '');
        const notifyVariants = expandUuidVariants(this.config.notifyUuid);
        return notifyVariants.some(variant => cUuid === variant);
      });

      if (!writeChar || !notifyChar) {
        await peripheral.disconnectAsync();
        throw new BLEConnectionError('CHARACTERISTICS_NOT_FOUND', 'Required write or notify characteristics not found');
      }

      // STEP 6: ATOMIC SUCCESS - All validation passed, now create transport
      console.log(`[Session:${this.sessionId}] BLE validation complete - creating transport`);
      this.transport = new NobleTransport();
      
      // Set up transport event handlers
      this.transport.on('data', (data: Uint8Array) => {
        this.sharedState?.logPacket('RX', data);
        this.emit('data', data);
      });
      
      this.transport.on('disconnect', async () => {
        console.log(`[Session:${this.sessionId}] Noble disconnect event - cleaning up session`);
        this.sharedState?.setConnectionState({ connected: false, deviceName: null });
        
        // CRITICAL: When Noble disconnects, we MUST cleanup immediately
        try {
          await this.cleanup('noble disconnect');
        } catch (e) {
          console.error(`[Session:${this.sessionId}] Error during Noble disconnect cleanup:`, e);
        }
      });
      
      this.transport.on('error', (error) => {
        console.log(`[Session:${this.sessionId}] BLE transport error: ${error}`);
        this.cleanup('transport error', error);
      });

      // Connect the transport to the validated peripheral
      this.deviceName = await this.transport.connectToValidatedPeripheral(peripheral, this.config);
      this.resetIdleTimer();
      
      console.log(`[Session:${this.sessionId}] Atomic connection successful to ${deviceName}`);
      this.sharedState?.setConnectionState({ connected: true, deviceName: this.deviceName });
      metrics.recordConnectionSuccess();
      return this.deviceName;

    } catch (error: any) {
      // Connection failed at any step - clean up partial connections
      console.log(`[Session:${this.sessionId}] Atomic connection failed: ${error.message}`);
      metrics.recordConnectionFailure();
      
      // Clean up peripheral if it was connected
      if (peripheral?.state === 'connected') {
        try {
          await peripheral.disconnectAsync();
        } catch (e) {
          console.error(`[Session:${this.sessionId}] Error disconnecting peripheral:`, e);
        }
      }
      
      // Clean up transport if it was created
      if (this.transport) {
        try {
          await this.transport.cleanup({ force: true });
        } catch (e) {
          console.error(`[Session:${this.sessionId}] Error cleaning up transport:`, e);
        }
        this.transport = null;
      }
      
      // Re-throw as BLEConnectionError for proper close code mapping
      if (error instanceof BLEConnectionError) {
        throw error;
      } else {
        // Map generic errors to appropriate BLE connection errors
        if (error.message?.includes('timeout')) {
          throw new BLEConnectionError('GATT_CONNECTION_FAILED', `Connection timeout: ${error.message}`);
        } else {
          throw new BLEConnectionError('HARDWARE_NOT_FOUND', error.message || 'Unknown connection error');
        }
      }
    }
  }

  /**
   * Add WebSocket to this session
   */
  addWebSocket(ws: WebSocket): void {
    this.activeWebSockets.add(ws);
    console.log(`[Session:${this.sessionId}] Added WebSocket (${this.activeWebSockets.size} active)`);
    
    // Cancel grace period if WebSocket reconnects
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
      console.log(`[Session:${this.sessionId}] Cancelled grace period - WebSocket reconnected`);
    }
    
    // Reset idle timer when WebSocket reconnects
    this.lastTxTime = Date.now();
    this.resetIdleTimer();
  }

  /**
   * Remove WebSocket from this session
   */
  removeWebSocket(ws: WebSocket): void {
    const wasActive = this.activeWebSockets.has(ws);
    this.activeWebSockets.delete(ws);
    console.log(`[Session:${this.sessionId}] Removed WebSocket (${this.activeWebSockets.size} active, was active: ${wasActive})`);
    
    // Start grace period if no more WebSockets
    if (this.activeWebSockets.size === 0) {
      console.log(`[Session:${this.sessionId}] No active WebSockets remaining - starting grace period`);
      this.startGracePeriod();
    }
  }

  /**
   * Send data to BLE device and reset idle timer
   */
  async write(data: Uint8Array): Promise<void> {
    if (!this.transport) {
      throw new Error('Not connected');
    }
    
    this.lastTxTime = Date.now();
    this.resetIdleTimer();
    await this.transport.write(data);
  }

  /**
   * Start grace period - keep BLE alive for potential reconnects
   */
  private startGracePeriod(): void {
    console.log(`[Session:${this.sessionId}] Starting ${this.gracePeriodSec}s grace period`);
    
    // Don't clear idle timer - let it run in parallel with grace period
    // This prevents the dead zone where neither timer is active
    
    this.graceTimer = setTimeout(async () => {
      console.log(`[Session:${this.sessionId}] Grace period expired - cleaning up`);
      try {
        await this.cleanup('grace period expired');
      } catch (e) {
        console.error(`[Session:${this.sessionId}] Error during grace period cleanup:`, e);
      }
    }, this.gracePeriodSec * 1000);
    
    // Also ensure idle timer is running during grace period
    if (!this.idleTimer) {
      console.log(`[Session:${this.sessionId}] Starting idle timer during grace period`);
      this.resetIdleTimer();
    }
  }

  /**
   * Reset idle timeout - session is still active
   */
  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    
    // Always set idle timer - it should run even during grace period
    // This prevents zombie connections when grace timer fails
    this.idleTimer = setTimeout(async () => {
      const idleTime = Math.round((Date.now() - this.lastTxTime) / 1000);
      console.log(`[Session:${this.sessionId}] Idle timeout (${idleTime}s since last TX) - cleaning up`);
      try {
        await this.cleanup('idle timeout');
      } catch (e) {
        console.error(`[Session:${this.sessionId}] Error during idle timeout cleanup:`, e);
      }
    }, this.idleTimeoutSec * 1000);
  }

  /**
   * Unified cleanup method for session termination
   * @param reason - Reason for cleanup
   * @param error - Optional error that triggered cleanup
   * @param force - Use force cleanup on transport (default: false)
   * @param closeWebSockets - Close WebSockets during cleanup (default: true)
   */
  async cleanup(reason: string, error?: any, force: boolean = false, closeWebSockets: boolean = true): Promise<void> {
    console.log(`[Session:${this.sessionId}] Cleanup (reason: ${reason}, force: ${force}, hasTransport: ${!!this.transport}, activeWS: ${this.activeWebSockets.size})`);
    
    // Clear timers
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Get initial resource state for monitoring
    const initialState = await NobleTransport.getResourceState();
    
    // Check device availability before cleanup
    let deviceAvailable = false;
    if (this.deviceName && this.config?.devicePrefix) {
      try {
        deviceAvailable = await NobleTransport.scanDeviceAvailability(this.config.devicePrefix, 3000);
        console.log(`[Session:${this.sessionId}] Device ${this.deviceName} available: ${deviceAvailable}`);
      } catch (e) {
        console.log(`[Session:${this.sessionId}] Device availability check failed: ${e}`);
      }
    }

    // Clean up transport - track success
    let cleanupSucceeded = false;
    if (this.transport) {
      try {
        await this.transport.cleanup({ 
          force, 
          verifyResources: true,
          deviceName: this.deviceName || undefined
        });
        cleanupSucceeded = true;
      } catch (e) {
        console.error(`[Session:${this.sessionId}] Transport cleanup error: ${e}`);
        // If graceful cleanup failed and we're not already forcing, try force cleanup
        if (!force) {
          try {
            console.log(`[Session:${this.sessionId}] Escalating to force cleanup`);
            // DO NOT use resetStack - it can crash Noble
            await this.transport.cleanup({ force: true, resetStack: false });
            cleanupSucceeded = true; // Force cleanup succeeded
          } catch (forceError) {
            console.error(`[Session:${this.sessionId}] Force cleanup also failed: ${forceError}`);
            // Both cleanup attempts failed - transport is in unknown state
          }
        }
      }
      
      // Only null transport if cleanup actually succeeded
      if (cleanupSucceeded) {
        this.transport = null;
      } else {
        console.error(`[Session:${this.sessionId}] WARNING: Transport cleanup failed - potential zombie connection`);
      }
    }

    // Close WebSockets (unless told not to)
    if (closeWebSockets) {
      for (const ws of this.activeWebSockets) {
        try {
          ws.close();
        } catch {
          // Ignore WebSocket close errors
        }
      }
      this.activeWebSockets.clear();
    }
    
    // Get final resource state for monitoring
    const finalState = await NobleTransport.getResourceState();
    const resourcesDelta = initialState.peripheralCount - finalState.peripheralCount;
    const listenersDelta = (initialState.listenerCounts.scanStop + initialState.listenerCounts.discover) - 
                          (finalState.listenerCounts.scanStop + finalState.listenerCounts.discover);
    
    console.log(`[Session:${this.sessionId}] Cleanup complete - freed ${resourcesDelta} peripherals, ${listenersDelta} listeners`);
    
    // Notify if device became unavailable
    if (this.deviceName && !deviceAvailable && !error) {
      this.emit('deviceUnavailable', { 
        sessionId: this.sessionId, 
        deviceName: this.deviceName,
        guidance: [
          'Check if device is powered on and in range',
          'Press device button to wake from sleep',
          'Power cycle device if needed',
          'Check Bluetooth adapter: sudo systemctl restart bluetooth'
        ]
      });
    }

    // Only clear device name and emit cleanup if transport cleanup succeeded
    if (cleanupSucceeded || !this.transport) {
      this.deviceName = null;
      
      // Emit cleanup event
      this.emit('cleanup', { 
        sessionId: this.sessionId, 
        reason, 
        error, 
        deviceAvailable, 
        resourceState: finalState,
        resourcesFreed: { peripherals: resourcesDelta, listeners: listenersDelta }
      });
    } else {
      // Cleanup failed - session is in zombie state
      console.error(`[Session:${this.sessionId}] CRITICAL: Cleanup failed - session remains in zombie state`);
      // Don't emit cleanup event - session is NOT cleaned up
    }
  }

  /**
   * Force cleanup (for external triggers)
   */
  async forceCleanup(reason: string = 'forced'): Promise<void> {
    // Force cleanup but DON'T close WebSockets - let the handler do that after sending response
    await this.cleanup(reason, undefined, true, false);
  }

  /**
   * Get session status
   */
  getStatus() {
    const now = Date.now();
    const idleTime = Math.round((now - this.lastTxTime) / 1000);
    
    return {
      sessionId: this.sessionId,
      connected: !!this.transport && !!this.deviceName,
      hasTransport: !!this.transport,
      deviceName: this.deviceName,
      activeWebSockets: this.activeWebSockets.size,
      idleTime,
      hasGracePeriod: !!this.graceTimer,
      hasIdleTimer: !!this.idleTimer,
      gracePeriodSec: this.gracePeriodSec,
      idleTimeoutSec: this.idleTimeoutSec
    };
  }

  /**
   * Helper method to add timeout to promises
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(errorMessage));
      }, timeoutMs);

      promise
        .then(resolve)
        .catch(reject)
        .finally(() => clearTimeout(timeout));
    });
  }

  /**
   * Find BLE device matching configuration
   */
  private async findDevice(): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        noble.removeAllListeners('discover');
        noble.stopScanningAsync().catch(() => {});
        reject(new Error('Device discovery timeout'));
      }, 10000);

      noble.on('discover', (peripheral: any) => {
        const id = peripheral.id;
        const name = peripheral.advertisement.localName || '';
        
        // Check if device matches configuration
        const matchesDevice = !this.config.devicePrefix || 
          id.startsWith(this.config.devicePrefix) || 
          name.startsWith(this.config.devicePrefix);

        // Check if device advertises the required service
        const advertisedServices = peripheral.advertisement.serviceUuids || [];
        const serviceVariants = expandUuidVariants(this.config.serviceUuid);
        const matchesService = advertisedServices.some((uuid: string) => {
          const normalizedUuid = uuid.toLowerCase().replace(/-/g, '');
          return serviceVariants.some(variant => normalizedUuid === variant);
        });

        if (matchesDevice && (matchesService || !advertisedServices.length)) {
          clearTimeout(timeout);
          noble.removeAllListeners('discover');
          noble.stopScanningAsync().catch(() => {});
          console.log(`[Session:${this.sessionId}] Device found: ${name || 'Unknown'} [${id}]`);
          resolve(peripheral);
        }
      });

      // Start scanning with service UUIDs if device prefix not specified
      const scanServiceUuids = this.config.devicePrefix ? [] : expandUuidVariants(this.config.serviceUuid);
      noble.startScanningAsync(scanServiceUuids, true).catch(reject);
    });
  }
}