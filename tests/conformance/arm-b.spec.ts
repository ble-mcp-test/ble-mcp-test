import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { armBStatus, ARM_B_ENV } from './arm-status.js';

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
 * ## What running it requires, and none of it is optional
 *
 * 1. `BLE_MCP_CONFORMANCE_ARM_B=1`.
 * 2. A machine whose Chromium can reach a real BLE adapter -- BlueZ over D-Bus
 *    and a working AF_BLUETOOTH socket. The ESPHome proxy path does NOT count:
 *    that is the BRIDGE's route to the device, and Chrome knows nothing about it.
 * 3. A powered peripheral in range advertising the configured service.
 * 4. Headed Chromium with `--enable-features=WebBluetooth` and the chooser
 *    bypassed, because `requestDevice` needs a user gesture and a device picker.
 *
 * ## Status, stated rather than implied
 *
 * ⚠ THIS ARM HAS NEVER BEEN RUN. It was written under TRA-1187 and no run has
 * been recorded. Do not read arm A's green as covering it -- that is precisely
 * the inference the loud banner exists to block. The first person to run it
 * should expect to fix things here, and should record the result on the ticket.
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

    await page.goto('about:blank');
    await page.addScriptTag({ content: source });

    const config = {
      service: process.env.BLE_MCP_SERVICE_UUID ?? '9800',
      write: process.env.BLE_MCP_WRITE_UUID ?? '9900',
      notify: process.env.BLE_MCP_NOTIFY_UUID ?? '9901'
    };

    const results = await page.evaluate(async (cfg) => {
      const { CONFORMANCE_CHECKS, partitionChecks } = (window as any).Conformance;

      // The real API is the provider. Its capabilities are honest about what a
      // real peripheral cannot be made to do on cue.
      const provider = {
        name: 'arm B (real Chromium navigator.bluetooth)',
        capabilities: { injectNotification: false, dropLink: false, testingApi: false },
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
  });
});

export { ARM_B_ENV };
