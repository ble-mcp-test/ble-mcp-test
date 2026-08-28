/**
 * Device-Specific Test Commands - Single Source of Truth
 * 
 * This file contains the canonical test command sequences and expected responses
 * for the CS108 UHF RFID reader (or compatible device). These values are used
 * across all test suites to ensure consistency.
 * 
 * ⚠️  CRITICAL: Only modify these values when the physical device behavior changes.
 *     All E2E, integration, and unit tests depend on these constants.
 *
 * ## Provenance, and the duplication that cannot be merged away
 *
 * These are frozen bytes of two CS108 events that `trakrf/platform` defines
 * STRUCTURALLY, in `frontend/src/worker/cs108/event.ts`:
 *
 *   0xA000  GET_BATTERY_VOLTAGE (responseLength 2)  ->  BATTERY_COMMAND_BYTES
 *   0xA001  GET_TRIGGER_STATE                       ->  TEST_COMMAND_BYTES
 *
 * Platform is authoritative for CS108 protocol semantics; it builds these frames
 * with one `PacketHandler` and its tests wrap that rather than restating bytes.
 * This package cannot import any of it -- platform depends on ble-mcp-test, not
 * the reverse -- and it should not copy it either: a CS108 protocol parser inside
 * a device-agnostic tool contradicts what the tool is.
 *
 * So the overlap is STRUCTURAL, not an accident to clean up. What this package
 * needs is the minimum device knowledge that proves a round trip: bytes out,
 * bytes back, correct framing and byte range. That is these two commands and
 * nothing more. If they ever disagree with platform's event table, platform wins
 * -- and the event codes above are what makes that check possible at all.
 *
 * Verified against the live reader 2026-08-27 via the ESPHome proxy:
 *   TEST_COMMAND    -> a7 b3 03 d9 82 9e 74 37 a0 01 00   (len 11, matches below)
 *   BATTERY_COMMAND -> a7 b3 04 d9 82 9e 95 d3 a0 00 0f 81 (len 12, 0x0f81 = 3969 mV)
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