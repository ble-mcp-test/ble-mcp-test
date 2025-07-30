import WebSocket from 'ws';

export interface ConnectionResult {
  ws: WebSocket;
  connected: boolean;
  deviceName?: string;
  token?: string;
  error?: string;
}

export interface ConnectionOptions {
  maxRetries?: number;
  retryDelay?: number;
  timeout?: number;
}

/**
 * Factory for creating WebSocket connections with proper lifecycle management
 * Handles connection retries and cleanup for integration tests
 */
export class ConnectionFactory {
  private activeConnection: WebSocket | null = null;
  private connectionToken: string | null = null;
  
  /**
   * Create a new WebSocket connection with retry logic
   * Automatically handles "Another connection is active" errors
   */
  async connect(
    wsUrl: string, 
    params: URLSearchParams,
    options: ConnectionOptions = {}
  ): Promise<ConnectionResult> {
    const {
      maxRetries = 10,
      retryDelay = 1000,
      timeout = 20000  // 20s guard timeout - longer than 15s transport timeout
    } = options;
    
    // Clean up any previous connection
    await this.cleanup();
    
    let lastError: string | undefined;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.attemptConnection(wsUrl, params, timeout);
        
        if (result.connected) {
          this.activeConnection = result.ws;
          this.connectionToken = result.token || null;
          return result;
        }
        
        // Check if error is retryable
        if (result.error?.includes('Another connection is active')) {
          console.log(`[ConnectionFactory] Attempt ${attempt}/${maxRetries}: Connection busy, retrying in ${retryDelay}ms...`);
          lastError = result.error;
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          continue;
        }
        
        // Non-retryable error
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    
    // All retries exhausted
    return {
      ws: new WebSocket(`${wsUrl}?${params}`), // Return disconnected ws for cleanup
      connected: false,
      error: lastError || 'Max retries exceeded'
    };
  }
  
  /**
   * Attempt a single connection
   */
  private async attemptConnection(
    wsUrl: string,
    params: URLSearchParams,
    timeout: number
  ): Promise<ConnectionResult> {
    const ws = new WebSocket(`${wsUrl}?${params}`);
    
    return new Promise<ConnectionResult>((resolve) => {
      const timer = setTimeout(() => {
        ws.close();
        resolve({ ws, connected: false, error: 'Connection timeout' });
      }, timeout);
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        
        if (msg.type === 'connected') {
          clearTimeout(timer);
          resolve({ 
            ws, 
            connected: true, 
            deviceName: msg.device || msg.deviceName,
            token: msg.token
          });
        } else if (msg.type === 'error') {
          clearTimeout(timer);
          ws.close();
          resolve({ 
            ws, 
            connected: false, 
            error: msg.error 
          });
        }
      });
      
      ws.on('error', (err) => {
        clearTimeout(timer);
        resolve({ 
          ws, 
          connected: false, 
          error: err.message 
        });
      });
      
      ws.on('close', () => {
        clearTimeout(timer);
        // Only resolve if we haven't already
        resolve({ 
          ws, 
          connected: false, 
          error: 'Connection closed' 
        });
      });
    });
  }
  
  /**
   * Send command and wait for response
   */
  async sendCommand(command: { type: string; cmd?: number; register?: number }): Promise<any> {
    if (!this.activeConnection || this.activeConnection.readyState !== WebSocket.OPEN) {
      throw new Error('No active connection');
    }
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Command timeout'));
      }, 5000);
      
      const messageHandler = (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'data' || msg.type === 'error') {
          clearTimeout(timeout);
          this.activeConnection?.off('message', messageHandler);
          resolve(msg);
        }
      };
      
      this.activeConnection.on('message', messageHandler);
      this.activeConnection.send(JSON.stringify(command));
    });
  }
  
  /**
   * Clean up active connection and wait for full disconnection
   */
  async cleanup(): Promise<void> {
    if (!this.activeConnection) return;
    
    const ws = this.activeConnection;
    this.activeConnection = null;
    this.connectionToken = null;
    
    if (ws.readyState === WebSocket.OPEN) {
      // Wait for clean close
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.close();
        
        // Fallback timeout in case close doesn't fire
        setTimeout(() => resolve(), 1000);
      });
      
      // No cooldown needed - server handles all timing internally
    }
  }
  
  /**
   * Get active connection if any
   */
  getConnection(): WebSocket | null {
    return this.activeConnection;
  }
  
  /**
   * Get current connection token if any
   */
  getToken(): string | null {
    return this.connectionToken;
  }
}

// Singleton instance for test suite
export const connectionFactory = new ConnectionFactory();