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
  type: 'connected' | 'disconnected' | 'scan_result' | 'notification' | 'error' | 'ack';
  id?: string;
  device?: string;
  characteristic?: string;
  data?: string;
  error?: string;
  devices?: DeviceInfo[];
}

export interface DeviceInfo {
  id: string;
  name?: string;
  rssi?: number;
}

export interface NodeBleClientOptions {
  bridgeUrl: string;
  device?: string;
  service?: string;
  write?: string;
  notify?: string;
  sessionId?: string;
  debug?: boolean;
  reconnectAttempts?: number;
  reconnectDelay?: number;
}

export interface RequestDeviceOptions {
  filters?: Array<{
    namePrefix?: string;
    services?: string[];
  }>;
}

export interface CharacteristicEvent {
  target: {
    value: DataView;
  };
}