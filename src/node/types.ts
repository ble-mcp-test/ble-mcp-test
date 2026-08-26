export interface BridgeMessage {
  type: 'connect' | 'disconnect' | 'scan' | 'write' | 'read' | 'subscribe' | 'unsubscribe';
  id?: string;
  device?: string;
  service?: string;
  characteristic?: string;
  data?: string;
  sessionId?: string;
}

export interface BridgeResponse {
  type: 'connected' | 'disconnected' | 'scan_result' | 'notification' | 'error' | 'data';
  id?: string;
  device?: string;
  characteristic?: string;
  data?: string | number[];  // Hex string or byte array depending on context
  error?: string;
  devices?: DeviceInfo[];
}

export interface DeviceInfo {
  id: string;
  name?: string;
  rssi?: number;
}

export interface NodeBleClientOptions {
  sessionId: string;              // REQUIRED - consistent with browser mock
  bridgeUrl: string;             // WebSocket bridge URL
  service: string;               // Service UUID for discovery (PRIMARY METHOD)
  write: string;                 // Write characteristic UUID
  notify: string;                // Notify characteristic UUID
  deviceId?: string;             // Optional: Exact device ID for filtering
  deviceName?: string;           // Optional: Partial device name for filtering
  debug?: boolean;
  timeout?: number;              // Optional: Connection timeout
  reconnectAttempts?: number;
  reconnectDelay?: number;
}


export interface CharacteristicEvent {
  target: {
    value: DataView;
  };
}