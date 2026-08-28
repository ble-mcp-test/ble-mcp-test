import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { armBStatus, ARM_B_ENV } from './arm-status.js';

/** Chrome's canonical UUID form: 128-bit, lowercase. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';

/**
 * The device under test, from the environment, with NO fallback.
 *
 * The previous `?? '9800'` was the CS108's service UUID. Two things were wrong
 * with it: this repo is device-agnostic by design, so a default silently aims a
 * hardware run at one vendor's reader; and real Chromium rejects that spelling
 * outright with `TypeError: Invalid Service name: '9800'`, so arm B would have
 * died at the first call on every machine, before the chooser, looking like a
 * hardware fault.
 */
function requireUuids(): { service: string; write: string; notify: string; aliasable: boolean } {
  const read = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      throw new Error(`${name} is not set. Arm B drives real hardware and has no default device.`);
    }
    if (!CANONICAL_UUID.test(value)) {
      throw new Error(
        `${name}='${value}' is not a canonical UUID. Real Web Bluetooth accepts only a full ` +
          'lowercase 128-bit UUID or a numeric alias, and rejects short forms and uppercase hex.'
      );
    }
    return value;
  };
  const service = read('BLE_MCP_SERVICE_UUID');
  const write = read('BLE_MCP_WRITE_UUID');
  const notify = read('BLE_MCP_NOTIFY_UUID');
  return {
    service,
    write,
    notify,
    // Only a Base-UUID expansion has a numeric alias; a Nordic 6e400001-... has
    // none, and the two-spellings check is reported NOT RUN rather than faked.
    aliasable: [service, write, notify].every(uuid => uuid.endsWith(BASE_SUFFIX))
  };
}

/**
 * Arm B: the SAME contract checks, against REAL Chromium `navigator.bluetooth`.
 *
 * ## Why it exists even though it will run rarely
 *
 * Fidelity is a comparison against the real API. Arm A can only establish that
 * the mock agrees with itself. Only a run that puts real `navigator.bluetooth`
 * under the identical assertions can establish that the mock agrees with the
 * thing it doubles -- and "faithful to Web Bluetooth" is otherwise a claim
 * nothing in either repo can falsify.
 *
 * This is also the falsifiable form of the argument for the suite living here
 * rather than in platform: platform's Playwright only ever injects the mock and
 * drives the app, so it structurally cannot run this arm, no matter how thorough
 * it gets. That rests on a checkable property of their test tree, not on a
 * preference about repo boundaries.
 *
 * ## This arm is INTERACTIVE BY CONSTRUCTION. That is not a gap.
 *
 * `requestDevice()` requires transient activation and a user-driven chooser. The
 * spec is explicit on both -- "Check that the algorithm is triggered while its
 * relevant global object has a transient activation, otherwise throw a
 * SecurityError", and "prompt the user to choose one of the devices in
 * scanResult" -- and states the reason: "Pairing individual devices instead of
 * device classes requires at least a user action before a device can be
 * exploited."
 * https://webbluetoothcg.github.io/web-bluetooth/#requestDevice-user-gesture
 *
 * **That requirement is why this project exists.** A headless CI box cannot
 * produce the gesture or answer the chooser, which is precisely what the bridge
 * and the mock route around. So arm B is a MANUAL check run by a human on a box
 * with a real adapter -- permanently. It is not a test awaiting automation.
 *
 * A patched Chromium build was evaluated for this and rejected: once the debug
 * tooling was weighed, the bridge won. Do not re-propose it, and do not reach
 * for CDP `BluetoothEmulation` -- that presents a FAKE adapter, which would have
 * arm B asserting the mock against another double and destroy the only reason
 * this arm exists.
 *
 * ## What running it requires, and none of it is optional
 *
 * 1. `BLE_MCP_CONFORMANCE_ARM_B=1`.
 * 2. The three UUID variables below. There is NO fallback: this repo is
 *    device-agnostic, and a default would silently aim a hardware run at one
 *    vendor's reader.
 * 3. A machine whose Chromium can reach a real BLE adapter -- BlueZ over D-Bus
 *    and a working AF_BLUETOOTH socket. The ESPHome proxy path does NOT count:
 *    that is the BRIDGE's route to the device, and Chrome knows nothing about it.
 *    Check the socket, not /sys: inside a container `/sys/class/bluetooth/hci0`
 *    can be the host's view leaking through.
 * 4. A powered peripheral in range advertising the configured service.
 * 5. A human at the keyboard to click through the chooser. See above.
 *
 * ## Status, stated rather than implied
 *
 * ⚠ THIS ARM HAS NEVER BEEN RUN. Do not read arm A's green as covering it --
 * that is precisely the inference the loud banner exists to block.
 */
const status = armBStatus(process.env);

test.describe('client contract, arm B (real navigator.bluetooth)', () => {
  test.skip(
    !status.requested,
    `arm B is opt-in. ${status.line}`
  );

  test('every fidelity clause holds against the real API', async ({ page }) => {
    // The check bodies are bundled rather than re-implemented. Two copies of an
    // assertion is two things to keep in step, and the whole premise of this
    // suite is that the same assertions run in both arms.
    const bundled = await build({
      entryPoints: [fileURLToPath(new URL('./contract.ts', import.meta.url))],
      bundle: true,
      format: 'iife',
      globalName: 'Conformance',
      platform: 'browser',
      write: false
    });
    const source = bundled.outputFiles[0].text;

    // Web Bluetooth is a secure-context API, and `about:blank` is NOT a secure
    // context -- its origin is `null`, so `navigator.bluetooth` is UNDEFINED
    // there no matter what flags Chromium was launched with. Probed, not
    // assumed. This spec used to navigate to about:blank, which would have made
    // the first hardware run die on `Cannot read properties of undefined
    // (reading 'requestDevice')` and read as a broken adapter.
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><html><body>arm B</body></html>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await page.goto(`http://localhost:${port}/`);
      const secure = await page.evaluate(() => window.isSecureContext);
      if (!secure) throw new Error('arm B page is not a secure context; Web Bluetooth will be absent');
      const present = await page.evaluate(() => typeof (navigator as any).bluetooth);
      if (present === 'undefined') {
        throw new Error(
          'navigator.bluetooth is undefined. Chromium exposes it only with ' +
            '--enable-features=WebBluetooth (set in playwright.conformance.config.ts) ' +
            'and only in a secure context.'
        );
      }
      await page.addScriptTag({ content: source });

    const config = requireUuids();

    const results = await page.evaluate(async (cfg) => {
      const { CONFORMANCE_CHECKS, partitionChecks } = (window as any).Conformance;

      // The real API is the provider. Its capabilities are honest about what a
      // real peripheral cannot be made to do on cue.
      const provider = {
        name: 'arm B (real Chromium navigator.bluetooth)',
        capabilities: {
          injectNotification: false,
          dropLink: false,
          testingApi: false,
          aliasableUuids: cfg.aliasable
        },
        async open() {
          const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [cfg.service] }],
            optionalServices: [cfg.service]
          });
          const server = await device.gatt.connect();
          const service = await server.getPrimaryService(cfg.service);
          return {
            device,
            server,
            service,
            writeCharacteristic: await service.getCharacteristic(cfg.write),
            notifyCharacteristic: await service.getCharacteristic(cfg.notify)
          };
        },
        async close(session: any) {
          try { session.server.disconnect(); } catch { /* already gone */ }
        },
        async inject() { throw new Error('arm B cannot inject a notification'); },
        async drop() { throw new Error('arm B cannot drop the link'); },
        bluetooth() { throw new Error('arm B has no testing API'); }
      };

      const { runnable, skipped } = partitionChecks(provider);
      const failures: Array<{ id: string; message: string }> = [];

      for (const check of runnable) {
        const session = await provider.open();
        try {
          await check.run(session, provider);
        } catch (error) {
          failures.push({ id: check.id, message: (error as Error).message });
        } finally {
          await provider.close(session);
        }
      }

      return {
        ran: runnable.map((c: any) => c.id),
        notRun: skipped.map((s: any) => ({ id: s.check.id, because: s.because })),
        failures,
        total: CONFORMANCE_CHECKS.length
      };
    }, config);

    // The result line carries what did NOT run, by name, for the same reason arm
    // A's banner does: a pass count quoted without its scope supports a stronger
    // conclusion than the run demonstrates.
    console.log(
      [
        '',
        '='.repeat(78),
        `CONFORMANCE: arm B (real Chromium navigator.bluetooth) -- ` +
          `${results.ran.length}/${results.total} checks run`,
        ...results.notRun.map((s: any) => `    NOT RUN ${s.id}: ${s.because}`),
        '='.repeat(78),
        ''
      ].join('\n')
    );

      expect(results.failures, 'fidelity clauses that the real API does not satisfy').toEqual([]);
      expect(results.ran.length, 'arm B ran no checks at all').toBeGreaterThan(0);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

export { ARM_B_ENV };
