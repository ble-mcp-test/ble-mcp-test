import { defineConfig } from '@playwright/test';

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
 * 1. **The chooser.** `requestDevice()` requires a user gesture and shows a
 *    device picker. Playwright has no handler for the Web Bluetooth chooser, and
 *    Chromium has no `--use-fake-ui`-style bypass for it the way it does for
 *    media. Solving that is unfinished work, not a setting that exists and was
 *    left unset. Chromium's CDP `Bluetooth.*` emulation is NOT the answer -- it
 *    presents a FAKE adapter, which would make arm B assert the mock against
 *    another double and destroy the only reason this arm exists.
 * 2. **The adapter.** The machine needs BlueZ over D-Bus and a working
 *    AF_BLUETOOTH socket. The ESPHome proxy is the BRIDGE's route to the device
 *    and Chrome cannot use it.
 *
 * headless stays true, per CLAUDE.md. If the chooser turns out to require a
 * headed browser, that is a finding to record on the ticket and a rule to change
 * deliberately -- not something to quietly flip here.
 */
export default defineConfig({
  testDir: './tests/conformance',
  // *.spec.ts is Playwright, *.test.ts is vitest. tests/conformance/ holds both --
  // arm A under vitest, arm B here -- and without this Playwright collects arm A
  // and dies importing vitest's expect alongside its own.
  testMatch: '**/*.spec.ts',
  timeout: 120000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: './tmp/conformance-results',
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 }
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
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
