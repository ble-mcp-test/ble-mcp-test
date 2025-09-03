/**
 * Transport Manager for CS108 RFID Reader
 * Handles BLE connection and low-level communication with retry mechanism
 */
import { 
  CS108_SERVICE_UUID, 
  CS108_WRITE_UUID, 
  CS108_NOTIFY_UUID
} from './constants';
import { EventEmitter } from './eventEmitter';

import type { BluetoothDevice, BluetoothRemoteGATTServer, BluetoothRemoteGATTService, BluetoothRemoteGATTCharacteristic } from '@/types/web-bluetooth';

// Connection types
export enum TransportType {
  BLE = 0xB3,
  USB = 0xE6
}

export class TransportManager extends EventEmitter {
  // BLE connection
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private service: BluetoothRemoteGATTService | null = null;
  private writeCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private notifyCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  
  // Bound event handlers to ensure we can add and remove them correctly
  private boundHandleNotifications!: (event: Event) => void;
  private boundHandleDisconnect!: (event: Event) => void;
  
  private transportType: TransportType = TransportType.BLE;
  
  // Ring buffer for packet assembly - no timeouts, just deterministic assembly
  private packetBuffer: Uint8Array = new Uint8Array(0);
  private bufferWritePos: number = 0;
  private bufferReadPos: number = 0;
  
  // Packet rate monitoring
  private packetCount: number = 0;
  private lastPacketRateLog: number = 0;
  private droppedPacketCount: number = 0;
  private readonly BUFFER_SIZE: number = 65536; // Ring buffer size - increased for high packet rates
  
  // Enhanced packet processing for high-volume inventory data

  // Command queue variables
  private commandInProgress: boolean = false;
  private commandQueue: Array<{
    data: Uint8Array;
    resolve: (success: boolean) => void;
    maxRetries: number;
    retriesLeft: number;
  }> = [];
  private readonly MAX_QUEUE_LENGTH: number = 5;

  // Singleton instance
  private static instance: TransportManager;
  
  // connectionSequence removed as unused
  
  /**
   * Reset the singleton instance (for testing)
   */
  public static resetInstance(): void {
    if (TransportManager.instance) {
      TransportManager.instance.resetState();
    }
    TransportManager.instance = null as unknown as TransportManager;
  }
  
  constructor() {
    super();
    if (TransportManager.instance) {
      return TransportManager.instance;
    }
    
    // Initialize ring buffer
    this.packetBuffer = new Uint8Array(this.BUFFER_SIZE);
    
    // Bind the event handlers to preserve 'this' context
    this.boundHandleNotifications = this.handleNotifications.bind(this);
    this.boundHandleDisconnect = this.handleDisconnect.bind(this);
    
    TransportManager.instance = this;
  }
  
  /**
   * Check if Web Bluetooth is supported
   */
  public isSupported(): boolean {
    // Check for Web Bluetooth (including mocked)
    if (typeof window === 'undefined') return false;
    
    const hasBluetoothAPI = 'bluetooth' in navigator;
    const isMocked = !!(window as { __webBluetoothMocked?: boolean }).__webBluetoothMocked;
    
    return hasBluetoothAPI || isMocked;
  }
  
  /**
   * Connect to a CS108 device via BLE
   */
  public async connect(): Promise<boolean> {
    // Use Web Bluetooth API (direct or mocked)
    return this.connectDirectBLE();
  }
  
  /**
   * Connect directly via Web Bluetooth (existing code)
   */
  private async connectDirectBLE(): Promise<boolean> {
    if (!this.isSupported()) {
      this.emit('error', 'Web Bluetooth is not supported on this browser');
      return false;
    }
    
    try {
      // Request device - filter by service UUID to show only CS108 devices
      this.device = await navigator.bluetooth.requestDevice({
        filters: [
          { 
            services: [CS108_SERVICE_UUID] 
          }
        ],
        optionalServices: [CS108_SERVICE_UUID]
      }).catch((error: unknown) => {
        console.debug('Device selection was cancelled', error);
        throw new Error('Device selection cancelled');
      });
      
      if (!this.device) {
        this.emit('error', 'No device selected');
        return false;
      }
      
      // Set up disconnect listener
      this.device.addEventListener('gattserverdisconnected', this.boundHandleDisconnect);
      
      // Connect to GATT server
      this.server = await this.device.gatt?.connect() || null;
      if (!this.server) {
        this.emit('error', 'Failed to connect to GATT server');
        return false;
      }
      
      // Get service
      this.service = await this.server.getPrimaryService(CS108_SERVICE_UUID);
      if (!this.service) {
        this.emit('error', 'Service not found');
        return false;
      }
      
      // Get characteristics
      this.writeCharacteristic = await this.service.getCharacteristic(CS108_WRITE_UUID);
      this.notifyCharacteristic = await this.service.getCharacteristic(CS108_NOTIFY_UUID);
      
      // Subscribe to notifications
      await this.notifyCharacteristic.startNotifications();
      
      this.notifyCharacteristic.addEventListener('characteristicvaluechanged', this.boundHandleNotifications);
      
      // Connection complete
      this.transportType = TransportType.BLE;
      
      // Expose for testing in development/test mode
      if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
        (window as { __TRANSPORT_MANAGER__?: TransportManager }).__TRANSPORT_MANAGER__ = this;
      }
      
      console.info(`Connected to ${this.device?.name || 'CS108 Reader'}`);
      this.emit('connected', this.device?.name || 'CS108 Reader');
      
      return true;
    } catch (error) {
      console.error('BLE connection error:', error);
      this.emit('error', `Connection error: ${error instanceof Error ? error.message : String(error)}`);
      
      // Clean up any partial connections
      if (this.device && this.device.gatt?.connected) {
        try {
          this.device.gatt.disconnect();
        } catch (e) {
          console.debug('Error during cleanup:', e);
        }
      }
      
      return false;
    }
  }
  
  /**
   * Disconnect from the device
   */
  public async disconnect(): Promise<void> {
    // Handle direct BLE disconnect (existing code)
    if (!this.device || !this.server) {
      console.debug('No active connection to disconnect');
      return;
    }
    
    console.debug('Initiating disconnect process');
    this.emit('disconnecting');
    
    try {
      // Clear command queue
      this.clearCommandQueue("Device disconnecting");
      
      // Stop notifications
      if (this.notifyCharacteristic) {
        console.debug('Stopping notifications');
        try {
          await this.notifyCharacteristic.stopNotifications().catch(e => {
            console.debug('Error stopping notifications:', e);
          });
        } catch (e) {
          console.debug('Error stopping notifications:', e);
        }
      }
      
      // Remove event listeners before disconnecting
      if (this.notifyCharacteristic) {
        try {
          console.debug('Removing notification event listener');
          this.notifyCharacteristic.removeEventListener(
            'characteristicvaluechanged', 
            this.boundHandleNotifications
          );
        } catch (e) {
          console.debug('Error removing notification listener:', e);
        }
      }
      
      if (this.device) {
        try {
          console.debug('Removing disconnect event listener');
          this.device.removeEventListener(
            'gattserverdisconnected',
            this.boundHandleDisconnect
          );
        } catch (e) {
          console.debug('Error removing disconnect listener:', e);
        }
      }
      
      // Disconnect GATT
      if (this.device && this.device.gatt?.connected) {
        console.debug('Disconnecting GATT');
        try {
          this.device.gatt.disconnect();
        } catch (e) {
          console.debug('Error disconnecting GATT:', e);
        }
      }
    } catch (error) {
      console.error('Disconnect error:', error);
    } finally {
      // Always reset internal connection objects and emit disconnected event
      console.debug('Finalizing disconnect');
      this.resetState();
      this.emit('disconnected');
    }
  }

/**
   * Handle disconnection event (for direct BLE)
   */
  private handleDisconnect(): void {
    console.debug('Device disconnection event received');

    // Clear command queue
    this.clearCommandQueue("Device disconnected");

    // Reset all internal connection objects
    this.resetState();
    
    // Notify the application
    console.debug('Emitting disconnected event');
    this.emit('disconnected');
  }

  /**
   * Reset the internal state
   */
  private resetState(): void {
    console.debug('Resetting transport manager internal state');

    // Clear device connection objects
    this.device = null;
    this.server = null;
    this.service = null;
    this.writeCharacteristic = null;
    this.notifyCharacteristic = null;

    // Reset ring buffer
    this.bufferReadPos = 0;
    this.bufferWritePos = 0;

    // Reset command queue state
    this.commandInProgress = false;
    this.commandQueue = [];

    // Reset transport type to default
    this.transportType = TransportType.BLE;

    console.debug('Internal state reset complete');
  }

  /**
   * Clear the command queue and reject all pending commands
   */
  private clearCommandQueue(reason: string): void {
    const queueLength = this.commandQueue.length;
    if (queueLength > 0 || this.commandInProgress) {
      console.debug(`Clearing command queue (${queueLength} items). Reason: ${reason}`);
      // Reject all queued commands
      this.commandQueue.forEach(item => {
        item.resolve(false);
      });
      this.commandQueue = [];
      this.commandInProgress = false;
    }
  }

  /**
   * Process the next command in the queue
   */
  private async processNextCommand(): Promise<void> {
    // If we're already processing a command or there are no commands, do nothing
    if (this.commandInProgress || this.commandQueue.length === 0) {
      return;
    }

    // Get the next command from the queue
    const commandItem = this.commandQueue.shift()!;
    this.commandInProgress = true;

    try {
      // Define backoff times in milliseconds (0.5s, 1.5s, 5s)
      const backoffTimes = [500, 1500, 5000];
      
      // Helper function to wait for specified milliseconds
      const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      
      // Check for valid connection
      const isConnected = this.isConnected();
      
      if (!isConnected) {
        console.debug('No connection to device, cannot send data');
        commandItem.resolve(false);
        this.commandInProgress = false;
        this.processNextCommand();
        return;
      }
      
      try {
        // Send data via BLE
        if (this.writeCharacteristic) {
          // Send via direct BLE
          await this.writeCharacteristic.writeValue(commandItem.data);
          commandItem.resolve(true);
        } else {
          throw new Error('No valid connection for sending data');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Check for specific errors that might benefit from retry
        const shouldRetry = 
          errorMessage.includes('GATT operation already in progress') || 
          errorMessage.includes('Device busy') ||
          errorMessage.includes('GATT Server is disconnected') ||
          errorMessage.toLowerCase().includes('busy');
        
        if (shouldRetry && commandItem.retriesLeft > 0) {
          console.warn(`Error sending data: ${errorMessage}. Retrying (${commandItem.maxRetries - commandItem.retriesLeft + 1}/${commandItem.maxRetries})...`);
          commandItem.retriesLeft--;
          
          // Wait with exponential backoff before retrying
          const backoffTime = backoffTimes[Math.min(commandItem.maxRetries - commandItem.retriesLeft - 1, backoffTimes.length - 1)];
          console.debug(`Waiting ${backoffTime}ms before retry`);
          await wait(backoffTime);
          
          // Put the command back at the front of the queue
          this.commandQueue.unshift(commandItem);
        } else {
          // Either we've run out of retries or encountered a non-retriable error
          console.error(`Error sending data${commandItem.maxRetries > 0 ? ` after ${commandItem.maxRetries - commandItem.retriesLeft} retries` : ''}: ${errorMessage}`);
          commandItem.resolve(false);
        }
      }
    } catch (error) {
      console.error('Error processing command:', error);
      commandItem.resolve(false);
    } finally {
      // Mark command as no longer in progress and process the next one
      this.commandInProgress = false;
      this.processNextCommand();
    }
  }

  /**
   * Send raw data to the device with command queueing
   * @param data The data to send
   * @param maxRetries Maximum number of retries (default: 3)
   * @returns Promise resolving to success status
   */
  public async sendData(data: Uint8Array, maxRetries: number = 3): Promise<boolean> {
    // Check if we have too many commands queued
    if (this.commandQueue.length >= this.MAX_QUEUE_LENGTH) {
      console.warn(`Command queue full (${this.commandQueue.length}/${this.MAX_QUEUE_LENGTH}), rejecting new command`);
      return false;
    }
    
    return new Promise<boolean>(resolve => {
      // Add the command to the queue
      this.commandQueue.push({
        data,
        resolve,
        maxRetries,
        retriesLeft: maxRetries
      });
      
      // Start processing if not already in progress
      this.processNextCommand();
    });
  }

  /**
   * Handle notifications from the device (for direct BLE)
   */
  private handleNotifications(event: Event): void {
    try {
      const characteristic = event.target as unknown as BluetoothRemoteGATTCharacteristic;
      const value = characteristic.value;

      if (!value) {
        console.debug('[BLE] Notification received with null value');
        return;
      }

      // Immediately clone the data to avoid DataView detachment
      const data = new Uint8Array(value.byteLength);
      const dataView = new DataView(value.buffer);
      
      // Fast copy using a single pass
      const byteLength = value.byteLength;
      for (let i = 0; i < byteLength; i++) {
        data[i] = dataView.getUint8(i);
      }

      // Process immediately to keep up with high packet rates during inventory
      // The CS108 can send hundreds of packets per second during inventory
      const now = Date.now();
      this.processNotificationData(data, now);
    } catch (error) {
      console.error('[BLE] Error in notification handler:', error);
    }
  }
  
  /**
   * Process notification data with improved performance
   */
  private processNotificationData(data: Uint8Array, now: number): void {
    try {
      // Track packet rate
      this.packetCount++;
      
      // Log packet rate every second during high traffic
      if (now - this.lastPacketRateLog > 1000) {
        if (this.packetCount > 50) { // Only log during high traffic
          console.debug(`[BLE] Packet rate: ${this.packetCount} packets/sec, dropped: ${this.droppedPacketCount}`);
        }
        this.packetCount = 0;
        this.droppedPacketCount = 0;
        this.lastPacketRateLog = now;
      }
      
      // Add incoming data to ring buffer
      const dataLen = data.length;
      const spaceAvailable = this.BUFFER_SIZE - this.getBufferDataLength();
      
      // Log if this looks like a continuation fragment (doesn't start with 0xA7)
      if (data.length > 0 && data[0] !== 0xA7) {
        console.info(`[BLE] Received continuation fragment (${dataLen} bytes): ${Array.from(data).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}`);
      }
      
      if (dataLen > spaceAvailable) {
        console.error(`[BLE] Ring buffer overflow! Need ${dataLen} bytes, only ${spaceAvailable} available. Dropping entire packet to maintain alignment.`);
        this.droppedPacketCount++;
        // Drop the entire packet to maintain packet alignment
        // Partial packets would corrupt the stream
        return;
      }
      
      // Copy data to ring buffer
      for (let i = 0; i < data.length; i++) {
        this.packetBuffer[this.bufferWritePos] = data[i];
        this.bufferWritePos = (this.bufferWritePos + 1) % this.BUFFER_SIZE;
      }
      
      // Process complete packets from buffer
      this.processPacketsFromBuffer();
    } catch (error) {
      console.error('[BLE] Error processing notification:', error);
    }
  }
  
  /**
   * Get amount of data in the ring buffer
   */
  private getBufferDataLength(): number {
    if (this.bufferWritePos >= this.bufferReadPos) {
      return this.bufferWritePos - this.bufferReadPos;
    } else {
      return this.BUFFER_SIZE - this.bufferReadPos + this.bufferWritePos;
    }
  }
  
  /**
   * Process complete packets from the ring buffer
   * Optimized for high packet rates with batching
   */
  private processPacketsFromBuffer(): void {
    const startTime = performance.now();
    const MAX_PROCESSING_TIME = 10; // Max 10ms per batch to avoid blocking
    const packetsProcessed = 0;
    const MAX_PACKETS_PER_BATCH = 50; // Limit packets per batch
    
    while (this.getBufferDataLength() >= 3 && packetsProcessed < MAX_PACKETS_PER_BATCH) { // Need at least header + length
      // Check if we've spent too much time processing
      if (performance.now() - startTime > MAX_PROCESSING_TIME) {
        // Schedule remaining packets for next tick
        setTimeout(() => this.processPacketsFromBuffer(), 0);
        break;
      }
    // Peek at potential packet header
    const byte0 = this.packetBuffer[this.bufferReadPos];
    const byte1 = this.packetBuffer[(this.bufferReadPos + 1) % this.BUFFER_SIZE];
    
    // Check for CS108 packet header
    if (byte0 === 0xA7 && (byte1 === 0xB3 || byte1 === 0xE6)) {
      // Get packet length (payload bytes after 8-byte header)
      const lengthPos = (this.bufferReadPos + 2) % this.BUFFER_SIZE;
      const payloadLength = this.packetBuffer[lengthPos];
      const totalPacketSize = 8 + payloadLength; // Header(8) + Payload(payloadLength)
      
      // Sanity check packet size
      if (totalPacketSize > 512) {
        // Invalid packet size, skip this false header
        console.warn(`[BLE] Invalid packet size ${totalPacketSize}, skipping false header`);
        this.bufferReadPos = (this.bufferReadPos + 1) % this.BUFFER_SIZE;
        continue;
      }
      
      // Check if we have the complete packet
      // console.debug(`[BLE] Packet header found, need ${totalPacketSize} bytes, have ${this.getBufferDataLength()} bytes in buffer`);
      if (this.getBufferDataLength() >= totalPacketSize) {
        // Extract the complete packet
        const packet = new Uint8Array(totalPacketSize);
        for (let i = 0; i < totalPacketSize; i++) {
          packet[i] = this.packetBuffer[(this.bufferReadPos + i) % this.BUFFER_SIZE];
        }
        
        // Belt and suspenders: Only check for embedded headers in COMMAND RESPONSE packets
        // Command responses should be small (payload ≤ 12) and never fragmented
        // Inventory/barcode notifications can have multiple complete packets concatenated
        if (payloadLength <= 12) {
          // This should be a command response - check for embedded headers
          const payloadStart = 8; // After 8-byte header
          for (let i = payloadStart; i <= totalPacketSize - 4; i++) {
            if (packet[i] === 0xA7 && packet[i + 1] === 0xB3 && packet[i + 3] === 0xC2) {
              console.error(`[BLE] Found embedded CS108 header in command response at offset ${i} - packet boundary error!`);
              console.error(`[BLE] Command packet: ${Array.from(packet).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
              // Skip this corrupted packet and resync from the embedded header
              this.bufferReadPos = (this.bufferReadPos + i) % this.BUFFER_SIZE;
              continue;
            }
          }
        }
        // Note: For inventory packets (payload > 12), embedded headers are normal - 
        // they represent multiple complete packets in one BLE notification
        
        // TODO: Add CRC validation here when we have the CRC calculation function
        // For now, the packet structure validation above provides good protection
        
        // Advance read position
        this.bufferReadPos = (this.bufferReadPos + totalPacketSize) % this.BUFFER_SIZE;
        
        // Check for firmware abort signature at the END of payload only
        // This is cleaner and safer than checking inside packet parsing
        let hasAbortSignature = false;
        if (totalPacketSize >= 15) { // 8 header + 7 abort signature minimum
          const abortSignature = [0x40, 0x03, 0xbf, 0xfc, 0xbf, 0xfc, 0xbf, 0xfc];
          const payloadStart = 8; // After 8-byte header
          const payloadEnd = totalPacketSize;
          
          // Check if payload ends with abort signature
          if (payloadEnd - payloadStart >= abortSignature.length) {
            let signatureMatch = true;
            for (let i = 0; i < abortSignature.length; i++) {
              if (packet[payloadEnd - abortSignature.length + i] !== abortSignature[i]) {
                signatureMatch = false;
                break;
              }
            }
            
            if (signatureMatch) {
              hasAbortSignature = true;
              console.debug('[BLE] Firmware abort signature detected at end of payload');
              this.emit('firmwareAbort', new Uint8Array(abortSignature));
            }
          }
        }
        
        // Always emit the packet - let the device manager decide what to do with it
        // The abort signature doesn't corrupt the packet, it's just additional info
        
        // Log reassembled packets for debugging
        const destByte = packet[3]; // Destination byte (module ID)
        const seqByte = packet[4]; // Sequence/reserve byte
        const command = packet.length >= 10 ? (packet[8] << 8) | packet[9] : 0; // Command bytes
        if (destByte === 0x6A || command === 0x9100 || command === 0x9101) {
          // console.info(`[BLE] Emitting reassembled barcode packet: dest=0x${destByte.toString(16)}, seq=0x${seqByte.toString(16)}, cmd=0x${command.toString(16).padStart(4, '0')}, size=${packet.length}`);
          // console.debug(`[BLE] Packet data: ${Array.from(packet).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}`);
        }
        
        // Count listeners to debug event routing
        const listenerCount = this.listenerCount('notification');
        if (destByte === 0x6A) {
          // console.info(`[BLE] Emitting notification event to ${listenerCount} listeners`);
        }
        
        this.emit('notification', packet);
        
        if (hasAbortSignature) {
          console.debug('[BLE] Packet contained abort signature but was still processed');
        }
      } else {
        // Not enough data for complete packet yet - wait for more
        break;
      }
    } else {
      // No valid header at this position
      // This could be a continuation fragment or garbage data
      // Log it for debugging but don't skip immediately
      console.warn(`[BLE] Non-header byte at buffer position ${this.bufferReadPos}: 0x${byte0.toString(16).padStart(2, '0')}`);
      
      // Only skip if we're sure it's not part of a fragmented packet
      // For now, be conservative and skip to avoid getting stuck
      this.bufferReadPos = (this.bufferReadPos + 1) % this.BUFFER_SIZE;
    }
  }
}
  

  /**
   * Get the transport type
   */
  public getTransportType(): TransportType {
    return this.transportType;
  }
  
  /**
   * Check if there is a connection to the device
   */
  public isConnected(): boolean {
    return !!(this.device && this.server && this.writeCharacteristic);
  }
  
  /**
   * Get the current command queue length
   */
  public getQueueLength(): number {
    return this.commandQueue.length;
  }
}