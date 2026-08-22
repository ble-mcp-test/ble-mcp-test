import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { fileURLToPath } from 'url';
import { LogBuffer } from './log-buffer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TransportInterface {
  readonly connected: boolean;
  readonly deviceName?: string;
  readonly connectedAt?: string;
  readonly lastActivity?: string;
  initialize(): Promise<void>;
  cleanup(): void;
  sendCommand(data: Uint8Array): Promise<Uint8Array>;
  scanDevices(): Promise<any[]>;
}

export class RustSubprocessTransport extends EventEmitter implements TransportInterface {
  private rustProcess: ChildProcess | null = null;
  private logBuffer: LogBuffer;
  private isConnected = false;
  private _deviceName?: string;
  private _connectedAt?: string;
  private _lastActivity?: string;
  private pendingCommands = new Map<string, {
    resolve: (data: Uint8Array) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private restartCount = 0;
  private maxRestarts = 10;  // Increased from 3 to handle more D-Bus failures
  private restartDelay = 5000;
  private consecutiveFailures = 0;  // Track immediate failures
  private lastRestartTime = 0;

  constructor(logBuffer: LogBuffer) {
    super();
    this.logBuffer = logBuffer;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get deviceName(): string | undefined {
    return this._deviceName;
  }

  get connectedAt(): string | undefined {
    return this._connectedAt;
  }

  get lastActivity(): string | undefined {
    return this._lastActivity;
  }

  async initialize(): Promise<void> {
    console.log('🦀 Starting Rust BLE subprocess...');

    // Spawn Rust bridge process (use pre-built release binary for performance)
    // Binary path relative to project root (dist/ is one level down from root)
    const projectRoot = path.resolve(__dirname, '..');
    const rustBinaryPath = process.env.RUST_BLE_BINARY ||
      path.join(projectRoot, 'rust-ble-test/target/release/rust-ble-test');
    const rustCwd = path.join(projectRoot, 'rust-ble-test');

    this.rustProcess = spawn(rustBinaryPath, [], {
      cwd: rustCwd,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Handle stdout for connection status and packet logs
    this.rustProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString();
      this.parseRustOutput(output);
    });

    // Handle stderr for debugging - these are critical for diagnosing crashes
    this.rustProcess.stderr?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      console.error('[Rust Bridge] STDERR:', output);

      // If we see panic or critical errors, force a restart
      if (output.includes('panic') || output.includes('Error:') || output.includes('Failed to bind')) {
        console.error('🚨 Critical Rust error detected, forcing restart...');
        this.emit('error', new Error(`Rust critical error: ${output}`));
      }
    });

    // Handle process exit with auto-restart
    this.rustProcess.on('exit', (code) => {
      console.log(`🦀 Rust bridge exited with code ${code} (restart ${this.restartCount}/${this.maxRestarts})`);
      this.isConnected = false;
      this.emit('disconnected');

      // Clear pending commands with error
      for (const [, pending] of this.pendingCommands.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Rust bridge crashed'));
      }
      this.pendingCommands.clear();

      // Check if this is a rapid failure (within 10 seconds of last restart)
      const now = Date.now();
      const timeSinceLastRestart = now - this.lastRestartTime;
      if (timeSinceLastRestart < 10000) {
        this.consecutiveFailures++;
        console.log(`⚠️ Rapid failure detected (${this.consecutiveFailures} consecutive failures)`);
      } else {
        // Reset consecutive failures if we had a good run
        this.consecutiveFailures = 0;
      }

      // Use exponential backoff for consecutive failures
      const backoffDelay = this.consecutiveFailures > 2
        ? Math.min(this.restartDelay * Math.pow(2, this.consecutiveFailures - 2), 60000)
        : this.restartDelay;

      // Auto-restart if under limit
      if (this.restartCount < this.maxRestarts) {
        console.log(`🔄 Auto-restarting Rust bridge in ${backoffDelay}ms...`);
        setTimeout(() => {
          this.forceRestart();
        }, backoffDelay);
      } else {
        console.error(`❌ Rust bridge failed after ${this.maxRestarts} attempts. Exiting Node.js process for PM2 restart.`);
        process.exit(1); // Let PM2 handle full restart
      }
    });

    // Wait for successful connection
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Rust bridge connection timeout'));
      }, 30000);

      this.once('connected', () => {
        clearTimeout(timeout);
        this.restartCount = 0; // Reset restart counter on successful connection
        resolve();
      });

      this.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private parseRustOutput(output: string): void {
    const lines = output.split('\n');

    for (const line of lines) {
      if (line.includes('✅ Connected on attempt')) {
        this.isConnected = true;
        this._connectedAt = new Date().toISOString();
        this._deviceName = 'CS108Reader2603A7'; // Extract from logs if needed
        this.emit('connected');

        // Log connection event (as INFO - we'll add a system log method later)
        console.log('[RustTransport] Connected to device');
      }

      // Parse RX packets: "📤 BLE write successful: [A7, B3, ...]"
      // Bridge writing TO device = Device RECEIVING command = RX from device perspective
      if (line.includes('📤 BLE write successful:')) {
        const hexMatch = line.match(/\[([A-F0-9, ]+)\]/);
        if (hexMatch) {
          const hexData = hexMatch[1].replace(/,\s*/g, ' ');
          const bytes = this.hexStringToUint8Array(hexData);
          this.logBuffer.push('RX', bytes);  // Device received command
          this._lastActivity = new Date().toISOString();
        }
      }

      // Parse TX packets: "📥 BLE notification: [A7, B3, ...]"
      // Bridge receiving FROM device = Device TRANSMITTING response = TX from device perspective
      if (line.includes('📥 BLE notification:')) {
        const hexMatch = line.match(/\[([A-F0-9, ]+)\]/);
        if (hexMatch) {
          const hexData = hexMatch[1].replace(/,\s*/g, ' ');
          const bytes = this.hexStringToUint8Array(hexData);
          this.logBuffer.push('TX', bytes);  // Device transmitted response
          this._lastActivity = new Date().toISOString();

          // Check if this is a response to a pending command
          this.checkPendingResponses(hexData);
        }
      }
    }
  }

  private hexStringToUint8Array(hexData: string): Uint8Array {
    const hexParts = hexData.split(' ').filter(part => part.length > 0);
    return new Uint8Array(hexParts.map(hex => parseInt(hex, 16)));
  }

  private checkPendingResponses(hexData: string): void {
    // Simple response matching - improve this for production
    for (const [commandId, pending] of this.pendingCommands.entries()) {
      // Convert hex string back to Uint8Array
      const bytes = hexData.split(' ').map(hex => parseInt(hex, 16));
      const response = new Uint8Array(bytes);

      clearTimeout(pending.timeout);
      this.pendingCommands.delete(commandId);
      pending.resolve(response);
      break; // Take first response for now
    }
  }

  async sendCommand(data: Uint8Array): Promise<Uint8Array> {
    if (!this.rustProcess || !this.isConnected) {
      throw new Error('Rust bridge not connected');
    }

    return new Promise((resolve, reject) => {
      const commandId = Math.random().toString(36).substring(7);

      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        reject(new Error('Command timeout'));
      }, 20000);

      // Store pending command
      this.pendingCommands.set(commandId, { resolve, reject, timeout });

      // Send command as JSON to Rust bridge stdin
      const message = JSON.stringify({
        type: 'data',
        data: Array.from(data)
      }) + '\n';

      this.rustProcess!.stdin?.write(message);
    });
  }

  async scanDevices(): Promise<any[]> {
    // Rust bridge handles scanning automatically during startup
    return [
      { id: 'cs108', name: 'CS108Reader2603A7', rssi: -50 }
    ];
  }

  cleanup(): void {
    if (this.rustProcess) {
      this.rustProcess.kill('SIGKILL');
      this.rustProcess = null;
    }
    this.isConnected = false;

    // Clear all pending commands
    for (const [, pending] of this.pendingCommands.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Transport cleanup'));
    }
    this.pendingCommands.clear();

    // Also try to clean up any lingering processes (fire and forget)
    try {
      const { spawn } = require('child_process');
      spawn('pkill', ['-f', 'rust-ble-test'], { stdio: 'ignore' });
    } catch {
      // Ignore cleanup errors
    }
  }

  public async forceRestart(): Promise<void> {
    this.restartCount++;
    this.lastRestartTime = Date.now();
    console.log(`🦀 Attempting Rust bridge restart #${this.restartCount}...`);

    try {
      // Kill existing process if still running
      if (this.rustProcess) {
        this.rustProcess.removeAllListeners();  // Prevent event handler loops
        this.rustProcess.kill('SIGKILL');
        this.rustProcess = null;
      }

      // Clean up any lingering Rust processes that might be holding port 8080
      console.log('🧹 Cleaning up any lingering Rust processes...');
      const { spawn } = await import('child_process');

      // First try pkill
      const cleanup = spawn('pkill', ['-f', 'rust-ble-test'], { stdio: 'ignore' });
      await new Promise(resolve => {
        cleanup.on('close', () => resolve(void 0));
        // Don't wait too long for cleanup
        setTimeout(() => {
          cleanup.kill();
          resolve(void 0);
        }, 2000);
      });

      // Also check for processes on port 8080 (Rust bridge port)
      const portCleanup = spawn('sh', ['-c', 'lsof -ti:8080 | xargs -r kill -9'], { stdio: 'ignore' });
      await new Promise(resolve => {
        portCleanup.on('close', () => resolve(void 0));
        setTimeout(() => resolve(void 0), 1000);
      });

      // Give the OS time to release resources
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Reset connection state before reinitializing
      this.isConnected = false;
      this._deviceName = undefined;
      this._connectedAt = undefined;
      this.pendingCommands.clear();

      // Start new process
      await this.initialize();
      console.log(`✅ Rust bridge successfully restarted on attempt #${this.restartCount}`);
      this.consecutiveFailures = 0;  // Reset on successful restart
    } catch (error) {
      console.error(`❌ Rust bridge restart #${this.restartCount} failed:`, error);
      // The exit handler will handle the next restart attempt or give up
    }
  }
}