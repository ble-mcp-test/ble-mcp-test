/**
 * Shared Test Utilities - Single Source of Truth
 * 
 * Centralized exports for all shared test constants, configurations, and helpers.
 * Import from this module to ensure consistency across all test suites.
 */

// Device command constants and validators
export {
  TEST_COMMAND_BYTES,
  TEST_RESPONSE_VALIDATION,
  BATTERY_COMMAND_BYTES,
  DEVICE_PROTOCOL,
  isValidDeviceResponse,
  isValidTestResponse,
  formatResponseHex
} from './device-commands.js';

// Test configuration builders
export {
  SHARED_TEST_CONFIG,
  DEVICE_FILTERS,
  createWebBleMockConfig
} from './test-config.js';