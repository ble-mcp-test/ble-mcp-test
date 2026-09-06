import { defineConfig } from '@playwright/test';
import { armBStatus } from './tests/conformance/arm-status.js';

/**
 * The browser channel arm B drives, by platform.
 *
 * macOS gates Bluetooth PER APPLICATION (TCC, System Settings -> Privacy &
 * Security -> Bluetooth), keyed on bundle identity. Playwright's bundled
 * Chromium is ad-hoc-signed with no stable identity, so a grant for it is
 * unreliable and can evaporate between runs -- and an ungranted app does not
 * error: **the chooser comes up EMPTY**, which is indistinguishable from an
 * out-of-range peripheral or a dead adapter. That is failure class 2 from
 * CLAUDE.md, a silent fallback wearing the costume of a hardware fault.
 *
 * Installed Google Chrome has a real bundle ID and can hold the permission, so
 * on darwin arm B drives `channel: 'chrome'`.
 *
 * Elsewhere this returns undefined, which leaves Playwright's bundled Chromium
 * in place. That is deliberate rather than an omission: the recorded green
 * 21/21 on knuckles (2026-09-06, BlueZ) was produced by that browser, and
 * switching Linux to a different binary would retire a baseline this arm has
 * only just earned.
 */
export function armBChannel(platform: string): 'chrome' | undefined {
  return platform === 'darwin' ? 'chrome' : undefined;
}

/**
 * Arm B only. Separate from playwright.config.ts on purpose.
 *
 * The e2e config's testDir is tests/e2e, and arm B is not an e2e spec: it does
 * not drive the bridge, does not use the mock, and needs a real BLE adapter
 * attached to the browser rather than a running bridge. Folding it in would make
 * `pnpm test:e2e` silently depend on hardware Chrome can see, which is a
 * different requirement from the one that suite already has.
 *
 * ⚠ Two things the first person to run this will hit, named here rather than
 * discovered:
 *
 * 1. **The gesture and the chooser -- and this arm is manual because of them.**
 *    `requestDevice()` requires transient activation and a user-driven picker;
 *    the spec mandates both and explains why (pairing individual devices
 *    "requires at least a user action before a device can be exploited").
 *    https://webbluetoothcg.github.io/web-bluetooth/#requestDevice-user-gesture
 *
 *    That requirement is the reason this project exists at all, so arm B is a
 *    HUMAN-RUN check, permanently -- not automation that nobody has written yet.
 *    A patched Chromium was evaluated and rejected on the debug tooling; the
 *    bridge won. CDP `BluetoothEmulation` is not a way out either: it presents a
 *    FAKE adapter, which would have arm B asserting the mock against another
 *    double and destroy the only reason this arm exists.
 * 2. **The adapter.** The machine needs a real radio of its own -- BlueZ over
 *    D-Bus with a working AF_BLUETOOTH socket, or CoreBluetooth on macOS. The
 *    ESPHome proxy is the BRIDGE's route to the device and Chrome cannot use it.
 *    On Linux check the socket, not `/sys` -- in a container
 *    `/sys/class/bluetooth/hci0` can be the host's view leaking through.
 * 3. **A secure context.** Web Bluetooth is secure-context-only and
 *    `about:blank` is not one (its origin is `null`), so `navigator.bluetooth`
 *    is UNDEFINED there whatever the flags say. Arm B serves its page from
 *    localhost for exactly this reason.
 *
 * `--enable-features=WebBluetooth` below is not optional either: without it
 * `navigator.bluetooth` does not exist in Playwright's Chromium at all, in
 * headless shell or the full channel. Probed on Chromium 139. Installed Google
 * Chrome ships Web Bluetooth on by default, so on the darwin channel the flag is
 * redundant rather than wrong -- it stays because the Chromium path still needs
 * it and one args list serves both.
 *
 * headless follows the arm itself, and is not a standing flip of CLAUDE.md's
 * rule: it is false exactly when BLE_MCP_CONFORMANCE_ARM_B says a human is about
 * to answer the chooser, and true in every other run, when the spec skips and no
 * browser opens anyway. Both sides read that one variable through
 * `armBStatus`, so the spec cannot skip on a switch the browser ignored.
 *
 * This used to say headless stayed true and called a headed run "a deliberate,
 * recorded exception" -- a sentence no code implemented. Headless, the chooser
 * never appears, `requestDevice()` never settles, and the run dies on the 120s
 * timeout below looking like a dead adapter. tests/unit/conformance-arm-b-headed
 * holds the two in step.
 */
export default defineConfig({
  testDir: './tests/conformance',
  // *.spec.ts is Playwright, *.test.ts is vitest. tests/conformance/ holds both --
  // arm A under vitest, arm B here -- and without this Playwright collects arm A
  // and dies importing vitest's expect alongside its own.
  testMatch: '**/*.spec.ts',
  // Human-paced when arm B actually runs. Every runnable check calls
  // provider.open(), so the operator answers the chooser once PER CHECK -- 19
  // times as the contract stands -- and all of them happen inside a single
  // page.evaluate, so they share ONE test timeout rather than getting one each.
  // At 120s that budgets ~6s per pair-and-connect and expires partway through,
  // which surfaces as a timeout on a live device and reads as a dead adapter.
  // The clock here is a person's, so it is sized like one.
  timeout: armBStatus(process.env).requested ? 45 * 60 * 1000 : 120000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: './tmp/conformance-results',
  use: {
    headless: !armBStatus(process.env).requested,
    viewport: { width: 1280, height: 720 }
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // Real Chrome on macOS, bundled Chromium everywhere else. See armBChannel.
        channel: armBChannel(process.platform),
        launchOptions: {
          args: [
            '--disable-blink-features=AutomationControlled',
            '--enable-features=WebBluetooth'
          ]
        }
      }
    }
  ]
});
