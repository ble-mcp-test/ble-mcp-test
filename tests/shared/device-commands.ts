/**
 * Device-Specific Test Commands - Single Source of Truth
 * 
 * This file contains the canonical test command sequences and expected responses
 * for the CS108 UHF RFID reader (or compatible device). These values are used
 * across all test suites to ensure consistency.
 * 
 * ⚠️  CRITICAL: Only modify these values when the physical device behavior changes.
 *     All E2E, integration, and unit tests depend on these constants.
 */

// Standard test command that queries device trigger status
export const TEST_COMMAND_BYTES = new Uint8Array([
  0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x01
]);

// Expected response validation for the test command
export const TEST_RESPONSE_VALIDATION = {
  expectedLength: 11,
  expectedBytes: { 8: 0xA0, 9: 0x01, 10: 0x00 }
} as const;

// Alternative battery command for different test scenarios
export const BATTERY_COMMAND_BYTES = new Uint8Array([
  0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00
]);

/**
 * Device Protocol Constants
 */
export const DEVICE_PROTOCOL = {
  HEADER_BYTES: [0xA7, 0xB3] as const,
  STATUS_MARKER: 0xA0,
  TRIGGER_RELEASED: 0x01,
  BATTERY_QUERY: 0x00,
  MIN_RESPONSE_LENGTH: 10
} as const;

/**
 * Validates if a response follows the expected device protocol
 */
export function isValidDeviceResponse(data: Uint8Array): boolean {
  if (data.length < DEVICE_PROTOCOL.MIN_RESPONSE_LENGTH) return false;
  if (data[0] !== DEVICE_PROTOCOL.HEADER_BYTES[0]) return false;
  if (data[1] !== DEVICE_PROTOCOL.HEADER_BYTES[1]) return false;
  return true;
}

/**
 * Validates if a response matches the test command's expected pattern
 */
export function isValidTestResponse(data: Uint8Array): boolean {
  if (!isValidDeviceResponse(data)) return false;
  if (data.length !== TEST_RESPONSE_VALIDATION.expectedLength) return false;
  
  for (const [index, value] of Object.entries(TEST_RESPONSE_VALIDATION.expectedBytes)) {
    if (data[Number(index)] !== value) return false;
  }
  
  return true;
}

/**
 * Format response bytes as hex string for logging
 */
export function formatResponseHex(data: Uint8Array): string {
  return Array.from(data).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
}