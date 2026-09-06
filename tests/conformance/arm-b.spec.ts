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
 * ✅ GREEN: 21/21 runnable checks, confirmed 2026-09-06 on knuckles (ASUS BT500,
 * hci0) against a real CS108, TWICE consecutively. The first outright pass this
 * arm has produced.
 *
 * It got there in two steps. The arm's first ever run, the same day, was 18/19
 * twice over: `chain/second-device-is-distinct` failed because real Chromium
 * returns the SAME BluetoothDevice for a second requestDevice() on one
 * peripheral, as the spec's per-realm device map requires, while the mock minted
 * a distinct one. TRA-1255 fixed the mock, inverted that clause, and added
 * `connect-when-connected-resolves-the-same-server` and
 * `reconnect-replaces-attributes`. All three are green on hardware.
 *
 * ⚠ It only passes with `blueman` STOPPED. blueman-applet and blueman-tray are a
 * second BlueZ client on the same adapter that pairs and auto-connects,
 * contending for the peripheral while the chooser is open. With them running,
 * two post-fix runs failed two different ways; with them stopped, two passed
 * clean. A mechanism plus that correlation makes it the leading explanation, but
 * the decisive experiment -- put blueman back and watch it fail -- has not been
 * run, so it is a PRECONDITION here rather than a closed case. See
 * docs/conformance-arm-b.md.
 *
 * Three defects in THIS repo, not on the bench, are why it had never produced a
 * result before that date: no transient activation under page.evaluate(), a
 * headless browser with no chooser to answer, and 120s budgeted for all 19
 * answers together. See tests/conformance/README.md and
 * docs/conformance-arm-b.md.
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

    // `requestDevice()` needs TRANSIENT ACTIVATION, and page.evaluate() has
    // none -- injected script is not user-driven. The first hardware run of this
    // arm died on
    //   SecurityError: Must be handling a user gesture to show a permission request
    // thrown before any chooser appeared. THAT is why this arm had never
    // produced a result: not the hardware, not the operator, and not the
    // headless flag. The docstring above quotes the very requirement the old
    // shape could not satisfy -- failure class 1 from CLAUDE.md, in the file
    // that names it.
    //
    // So the gesture comes from a real click on a real button, dispatched
    // through Chromium's input pipeline, which grants activation exactly as a
    // hand-driven click does. The HUMAN still answers the chooser, which is the
    // part no automation can supply and the whole reason this arm exists.
    // Driving the button is not faking the adapter: the radio, the peripheral,
    // the chooser and the choice all stay real. The gesture was never the part
    // that needed a person -- the CHOICE is.
    const setup = await page.evaluate((cfg) => {
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
          // The LINK is retried; the CHOICE is not. A real peripheral needs a
          // moment to tear the previous connection down and resume advertising,
          // and this arm reconnects once per check -- 19 times in a row, far
          // harder on the radio than any normal client. Observed 2026-09-06: five
          // checks in, `Connection Error: Connection attempt failed.`
          //
          // Retrying here rather than re-entering requestDevice() keeps the
          // operator's single answer per check. Nothing in the contract asserts
          // that gatt.connect() succeeds first time, so this hides no clause --
          // it makes the transport reliable enough to ask about the ones that
          // ARE asserted.
          let server;
          for (let attempt = 1; ; attempt++) {
            try {
              server = await device.gatt.connect();
              break;
            } catch (error) {
              if (attempt >= 4) throw error;
              await new Promise(resolve => setTimeout(resolve, 800 * attempt));
            }
          }
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
          // Settle before the next check reconnects. The mock takes a
          // post-disconnect delay for the same reason; a real CS108 over BlueZ
          // is no more forgiving of an immediate re-attach.
          await new Promise(resolve => setTimeout(resolve, 750));
        },
        async reconnect(session: any) {
          // Down and back up on the SAME device object -- no requestDevice, so
          // no second chooser answer and no transient activation needed. The
          // operator still answers exactly once per check.
          //
          // Same settle and same four attempts as `open()`, and for the same
          // reason: a real peripheral needs a moment to tear the link down and
          // resume advertising, and a flake here would be recorded as a fidelity
          // failure against a clause about object identity.
          try { session.server.disconnect(); } catch { /* already gone */ }
          await new Promise(resolve => setTimeout(resolve, 750));
          for (let attempt = 1; ; attempt++) {
            try {
              await session.device.gatt.connect();
              break;
            } catch (error) {
              if (attempt >= 4) throw error;
              await new Promise(resolve => setTimeout(resolve, 800 * attempt));
            }
          }
        },
        async inject() { throw new Error('arm B cannot inject a notification'); },
        async drop() { throw new Error('arm B cannot drop the link'); },
        bluetooth() { throw new Error('arm B has no testing API'); }
      };

      const { runnable, skipped } = partitionChecks(provider);
      const state = {
        provider,
        runnable,
        ran: [] as string[],
        failures: [] as Array<{ id: string; message: string }>,
        aborted: null as { id: string; message: string; cancelled: boolean } | null,
        index: 0,
        pending: null as Promise<void> | null
      };
      (window as any).__armB = state;

      const button = document.createElement('button');
      button.id = 'arm-b-next';
      button.textContent = 'run next conformance check';
      button.style.cssText = 'font-size:20px;padding:16px 24px;margin:24px';
      document.body.appendChild(button);

      button.addEventListener('click', () => {
        const check = state.runnable[state.index];
        if (!check) return;
        // Everything up to `requestDevice()` runs synchronously inside this
        // handler -- the async IIFE reaches `provider.open()`, which reaches
        // `requestDevice()`, before it yields -- so the activation this click
        // carries is still live when the chooser is asked for. Awaiting
        // anything first would spend it, and the SecurityError would be back.
        state.pending = (async () => {
          let session;
          try {
            session = await state.provider.open();
          } catch (error) {
            // Answering the chooser is the OPERATOR's step, not the API's. A
            // cancelled or unanswered picker is an aborted run and never a
            // fidelity failure -- recording it as one would put "real Chromium
            // violates this clause" on the record because somebody stepped away
            // from the keyboard. Ask of this branch what CLAUDE.md asks of every
            // negative assertion: it exists so that a human error and an API
            // error cannot arrive at the same conclusion.
            const cause = error as Error;
            state.aborted = {
              id: check.id,
              message: cause.message,
              // A cancelled picker and a radio that would not attach are
              // different events with different remedies, and reporting both as
              // "answer the chooser" sends the next operator to the wrong one.
              cancelled: cause.name === 'NotFoundError'
            };
            return;
          }
          try {
            await check.run(session, state.provider);
          } catch (error) {
            state.failures.push({ id: check.id, message: (error as Error).message });
          } finally {
            await state.provider.close(session);
          }
          state.ran.push(check.id);
          state.index += 1;
        })();
      });

      return {
        runnable: runnable.map((c: any) => c.id),
        notRun: skipped.map((s: any) => ({ id: s.check.id, because: s.because })),
        total: CONFORMANCE_CHECKS.length
      };
    }, config);

    // One click, one check, one chooser -- and the operator is told which is
    // which, because "the chooser appeared again" is otherwise indistinguishable
    // from "it hung and came back".
    for (const [position, id] of setup.runnable.entries()) {
      console.log(`arm B: check ${position + 1}/${setup.runnable.length} -- ${id}; answer the chooser`);
      await page.click('#arm-b-next');
      await page.evaluate(() => (window as any).__armB.pending);
      const aborted = await page.evaluate(() => (window as any).__armB.aborted);
      if (aborted) break;
    }

    const results = await page.evaluate(() => {
      const state = (window as any).__armB;
      return { ran: state.ran, failures: state.failures, aborted: state.aborted };
    });

    // The result line carries what did NOT run, by name, for the same reason arm
    // A's banner does: a pass count quoted without its scope supports a stronger
    // conclusion than the run demonstrates.
    console.log(
      [
        '',
        '='.repeat(78),
        `CONFORMANCE: arm B (real Chromium navigator.bluetooth) -- ` +
          `${results.ran.length}/${setup.total} checks run`,
        ...setup.notRun.map((s: any) => `    NOT RUN ${s.id}: ${s.because}`),
        '='.repeat(78),
        ''
      ].join('\n')
    );

      // Stated before the assertions so a partial run still leaves a record of
      // how far it got, rather than only the reason it stopped.
      if (results.aborted) {
        throw new Error(
          `arm B ABORTED at ${results.aborted.id} after ${results.ran.length}/` +
            `${setup.runnable.length} checks: ${results.aborted.message}\n` +
            (results.aborted.cancelled
              ? 'The chooser was dismissed. Re-run with the operator at the keyboard.'
              : 'The link would not attach -- the peripheral, its range or its ' +
                'power, not the chooser. gatt.connect() is already retried four ' +
                'times here, so this outlasted that.') +
            '\nEither way this says nothing about fidelity: it is an unfinished ' +
            'run, not a red one. See docs/conformance-arm-b.md.'
        );
      }
      expect(results.failures, 'fidelity clauses that the real API does not satisfy').toEqual([]);
      expect(results.ran.length, 'arm B ran no checks at all').toBeGreaterThan(0);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

export { ARM_B_ENV };
