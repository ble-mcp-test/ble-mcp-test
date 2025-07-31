// Bluetooth HCI Error Code Translations
// Based on Bluetooth Core Specification

const HCI_ERROR_CODES: Record<number, string> = {
  0x00: 'Success',
  0x01: 'Unknown HCI Command',
  0x02: 'Unknown Connection Identifier',
  0x03: 'Hardware Failure',
  0x04: 'Page Timeout',
  0x05: 'Authentication Failure',
  0x06: 'PIN or Key Missing',
  0x07: 'Memory Capacity Exceeded',
  0x08: 'Connection Timeout',
  0x09: 'Connection Limit Exceeded',
  0x0A: 'Synchronous Connection Limit To A Device Exceeded',
  0x0B: 'ACL Connection Already Exists',
  0x0C: 'Command Disallowed',
  0x0D: 'Connection Rejected due to Limited Resources',
  0x0E: 'Connection Rejected Due To Security Reasons',
  0x0F: 'Connection Rejected due to Unacceptable BD_ADDR',
  0x10: 'Connection Accept Timeout Exceeded',
  0x11: 'Unsupported Feature or Parameter Value',
  0x12: 'Invalid HCI Command Parameters',
  0x13: 'Remote User Terminated Connection',
  0x14: 'Remote Device Terminated Connection due to Low Resources',
  0x15: 'Remote Device Terminated Connection due to Power Off',
  0x16: 'Connection Terminated By Local Host',
  0x17: 'Repeated Attempts',
  0x18: 'Pairing Not Allowed',
  0x19: 'Unknown LMP PDU',
  0x1A: 'Unsupported Remote Feature / Unsupported LMP Feature',
  0x1B: 'SCO Offset Rejected',
  0x1C: 'SCO Interval Rejected',
  0x1D: 'SCO Air Mode Rejected',
  0x1E: 'Invalid LMP Parameters',
  0x1F: 'Unspecified Error',
  0x20: 'Unsupported LMP Parameter Value',
  0x21: 'Role Change Not Allowed',
  0x22: 'LMP Response Timeout / LL Response Timeout',
  0x23: 'LMP Error Transaction Collision',
  0x24: 'LMP PDU Not Allowed',
  0x25: 'Encryption Mode Not Acceptable',
  0x26: 'Link Key cannot be Changed',
  0x27: 'Requested QoS Not Supported',
  0x28: 'Instant Passed',
  0x29: 'Pairing With Unit Key Not Supported',
  0x2A: 'Different Transaction Collision',
  0x2B: 'Reserved',
  0x2C: 'QoS Unacceptable Parameter',
  0x2D: 'QoS Rejected',
  0x2E: 'Channel Classification Not Supported',
  0x2F: 'Insufficient Security',
  0x30: 'Parameter Out Of Mandatory Range',
  0x31: 'Reserved',
  0x32: 'Role Switch Pending',
  0x33: 'Reserved',
  0x34: 'Reserved Slot Violation',
  0x35: 'Role Switch Failed',
  0x36: 'Extended Inquiry Response Too Large',
  0x37: 'Secure Simple Pairing Not Supported By Host',
  0x38: 'Host Busy - Pairing',
  0x39: 'Connection Rejected due to No Suitable Channel Found',
  0x3A: 'Controller Busy',
  0x3B: 'Unacceptable Connection Parameters',
  0x3C: 'Directed Advertising Timeout',
  0x3D: 'Connection Terminated due to MIC Failure',
  0x3E: 'Connection Failed to be Established', // This is 62 in decimal
  0x3F: 'MAC Connection Failed',
  0x40: 'Coarse Clock Adjustment Rejected but Will Try to Adjust Using Clock Dragging',
  
  // Linux/Unix system error codes that might appear (avoiding duplicates)
  // Note: 62 (0x3E) is already defined above as a Bluetooth HCI error
  111: 'Connection refused (ECONNREFUSED)',
  113: 'No route to host (EHOSTUNREACH)',
};

export function translateBluetoothError(error: any): string {
  // If it's already a string message, check for common patterns
  if (typeof error === 'string') {
    return error;
  }
  
  // If it's a number, translate it
  if (typeof error === 'number') {
    return HCI_ERROR_CODES[error] || `Unknown Bluetooth error code: ${error}`;
  }
  
  // If it has a message property, use it
  if (error?.message) {
    return error.message;
  }
  
  // If it has a code property, translate it
  if (typeof error?.code === 'number') {
    return HCI_ERROR_CODES[error.code] || `Unknown Bluetooth error code: ${error.code}`;
  }
  
  // Try to extract error code from string representation
  const errorStr = error?.toString() || '';
  const codeMatch = errorStr.match(/\b(\d+)\b/);
  if (codeMatch) {
    const code = parseInt(codeMatch[1], 10);
    if (HCI_ERROR_CODES[code]) {
      return HCI_ERROR_CODES[code];
    }
  }
  
  // Fallback
  return errorStr || 'Unknown error';
}