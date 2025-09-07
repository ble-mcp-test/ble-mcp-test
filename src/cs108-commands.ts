/**
 * CS108 RFID Reader Command Constants
 * Simplified to only include the trigger status command used by testing
 */

export const CS108_COMMANDS = {
  // Header that all commands start with
  HEADER: [0xA7, 0xB3] as const,
  
  // Command codes (big-endian)
  TRIGGER_STATUS: 0xA001, // Used by testing API for predictable responses
} as const;

// Trigger status command - predictable response for testing
// This replaces battery voltage command which has unpredictable responses
export const TRIGGER_STATUS_COMMAND = new Uint8Array([
  0xA7, 0xB3, // Header
  0x02,       // Length
  0xD9, 0x82, 0x37, 0x00, 0x00, // Data
  0xA0, 0x01  // Command code (trigger status)
]);

/**
 * @deprecated Use TRIGGER_STATUS_COMMAND constant instead
 * Get command bytes for specified command type
 */
export function getCommandBytes(_command: 'battery' | 'test' | 'trigger'): Uint8Array {
  console.warn('getCommandBytes is deprecated. Use TRIGGER_STATUS_COMMAND constant instead.');
  return TRIGGER_STATUS_COMMAND; // Always return trigger status command for consistency
}

/**
 * @deprecated Use navigator.bluetooth.testing API instead
 * Get the trigger status command bytes for browser context
 */
export function getTriggerStatusCommandString(): string {
  console.warn('getTriggerStatusCommandString is deprecated. Use navigator.bluetooth.testing API instead.');
  return Array.from(TRIGGER_STATUS_COMMAND).join(',');
}

/**
 * @deprecated Use navigator.bluetooth.testing API instead
 * Get the trigger status command bytes
 */
export function getTriggerStatusCommandBytes(): number[] {
  console.warn('getTriggerStatusCommandBytes is deprecated. Use navigator.bluetooth.testing API instead.');
  return Array.from(TRIGGER_STATUS_COMMAND);
}