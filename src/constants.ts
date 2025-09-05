/**
 * WebSocket Close Codes for BLE Connection Failures
 * 
 * Uses 4000-4999 range as specified by RFC 6455 for application-specific close codes.
 * Codes 1000-2999 are reserved by WebSocket specification.
 */

export const WEBSOCKET_CLOSE_CODES = {
  HARDWARE_NOT_FOUND: 4001,
  GATT_CONNECTION_FAILED: 4002,
  SERVICE_NOT_FOUND: 4003, 
  CHARACTERISTICS_NOT_FOUND: 4004,
  BLE_DISCONNECTED: 4005
} as const;

export type WebSocketCloseCode = typeof WEBSOCKET_CLOSE_CODES[keyof typeof WEBSOCKET_CLOSE_CODES];

export const CLOSE_CODE_MESSAGES = {
  [WEBSOCKET_CLOSE_CODES.HARDWARE_NOT_FOUND]: "CS108 device not found - check hardware connection",
  [WEBSOCKET_CLOSE_CODES.GATT_CONNECTION_FAILED]: "BLE zombie connection detected - restart ble-mcp-test service",
  [WEBSOCKET_CLOSE_CODES.SERVICE_NOT_FOUND]: "Required BLE service not available on device",
  [WEBSOCKET_CLOSE_CODES.CHARACTERISTICS_NOT_FOUND]: "Required BLE characteristics not found",
  [WEBSOCKET_CLOSE_CODES.BLE_DISCONNECTED]: "BLE device disconnected unexpectedly"
} as const;

/**
 * BLE Connection Error class for typed error handling
 */
export class BLEConnectionError extends Error {
  constructor(
    public code: keyof typeof WEBSOCKET_CLOSE_CODES, 
    message: string
  ) {
    super(message);
    this.name = 'BLEConnectionError';
  }
}

/**
 * Map BLE connection error to appropriate WebSocket close code
 */
export function mapErrorToCloseCode(error: any): WebSocketCloseCode {
  if (error instanceof BLEConnectionError) {
    return WEBSOCKET_CLOSE_CODES[error.code];
  }
  
  // Fallback mapping based on error message patterns
  const message = error.message?.toLowerCase() || '';
  
  if (message.includes('no devices found') || message.includes('device not found')) {
    return WEBSOCKET_CLOSE_CODES.HARDWARE_NOT_FOUND;
  }
  
  if (message.includes('gatt') || message.includes('connection failed')) {
    return WEBSOCKET_CLOSE_CODES.GATT_CONNECTION_FAILED;
  }
  
  if (message.includes('service') && message.includes('not found')) {
    return WEBSOCKET_CLOSE_CODES.SERVICE_NOT_FOUND;
  }
  
  if (message.includes('characteristic') && message.includes('not found')) {
    return WEBSOCKET_CLOSE_CODES.CHARACTERISTICS_NOT_FOUND;
  }
  
  if (message.includes('disconnect')) {
    return WEBSOCKET_CLOSE_CODES.BLE_DISCONNECTED;
  }
  
  // Default to hardware not found for unknown connection errors
  return WEBSOCKET_CLOSE_CODES.HARDWARE_NOT_FOUND;
}