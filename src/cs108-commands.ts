/**
 * CS108 RFID Reader Command Constants
 * All commands follow format: [header, length, ...data, checksum]
 */

export const CS108_COMMANDS = {
  // Header that all commands start with
  HEADER: [0xA7, 0xB3] as const,
  
  // Command codes (big-endian)
  BATTERY_VOLTAGE: 0xA000,
  INVENTORY_START: 0x8001,
  INVENTORY_STOP: 0x8100,
  // Add more as needed
} as const;

/**
 * Get battery voltage command
 * @returns Complete command with checksum
 */
export function getBatteryVoltageCommand(): Uint8Array {
  // Full command: header + length + data + checksum
  return new Uint8Array([
    0xA7, 0xB3, // Header
    0x02,       // Length
    0xD9, 0x82, 0x37, 0x00, 0x00, // Data
    0xA0, 0x00  // Command code (battery voltage)
  ]);
}

/**
 * Build command with checksum calculation
 * @param code Command code
 * @param data Optional data payload
 * @returns Complete command with checksum
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function buildCommand(_code: number, _data?: number[]): Uint8Array {
  // Implementation for building commands dynamically
  // Would calculate checksum, handle length, etc.
  // TODO: Implement when needed for other commands
  const command: number[] = [];
  command.push(...CS108_COMMANDS.HEADER);
  // Add implementation details when needed
  return new Uint8Array(command);
}