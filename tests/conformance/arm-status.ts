/**
 * Arm B's status, and the line that says so.
 *
 * A skipped-by-default arm is only worth having if its absence is LOUD. A suite
 * reporting green with arm B silently skipped is WORSE than a one-armed suite,
 * because it looks two-armed -- and the summary line is what travels while the
 * config does not.
 *
 * So the status goes in what the run PRINTS, and tests/conformance/arm-a.test.ts
 * asserts that the banner says which of the two cases it is. Losing the banner is
 * a test failure, not a quieter run.
 */
export const ARM_B_ENV = 'BLE_MCP_CONFORMANCE_ARM_B';

export interface ArmBStatus {
  requested: boolean;
  /** The line to print. Names arm B either way. */
  line: string;
}

export function armBStatus(env: Record<string, string | undefined>): ArmBStatus {
  const requested = env[ARM_B_ENV] === '1' || env[ARM_B_ENV] === 'true';
  return {
    requested,
    line: requested
      ? `arm B (real Chromium navigator.bluetooth + hardware): REQUESTED -- run it with ` +
        `\`just conformance-real\`; this vitest process runs arm A only.`
      : `arm B (real Chromium navigator.bluetooth + hardware): DID NOT RUN. ` +
        `Nothing in this result says anything about fidelity to the real Web ` +
        `Bluetooth API -- only arm B can compare the two. Set ${ARM_B_ENV}=1 and ` +
        `run \`just conformance-real\` with a powered device in range.`
  };
}

export function banner(
  providerName: string,
  ran: number,
  skipped: Array<{ id: string; because: string }>,
  caveat: string,
  armB: ArmBStatus
): string {
  const lines = [
    '',
    '='.repeat(78),
    `CONFORMANCE: ${providerName} -- ${ran} checks run`,
    `  scope: ${caveat}`,
    `  ${armB.line}`
  ];
  if (skipped.length > 0) {
    lines.push(`  ${skipped.length} checks NOT RUN in this arm:`);
    for (const entry of skipped) lines.push(`    - ${entry.id}: ${entry.because}`);
  }
  lines.push('='.repeat(78), '');
  return lines.join('\n');
}
