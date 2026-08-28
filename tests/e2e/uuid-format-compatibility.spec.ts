import { test, expect } from '@playwright/test';
import { setupMockPage, getBleConfig, injectMockInPage } from './test-config';

/**
 * UUID handling, through the BROWSER BUNDLE.
 *
 * ## Why this file still exists after the conformance suite
 *
 * Arm A drives the mock via the `.` ESM entry point. This drives the `./browser`
 * IIFE bundle that Playwright injects and that platform's vite plugin serves --
 * a different packaging of the same implementation, and the one consumers
 * actually load. A defect introduced by the bundler (a stripped module, a
 * mangled regex) is invisible to arm A and visible here.
 *
 * ## What it used to assert, and why that was backwards
 *
 * It asserted that the SHORT form ('9800') worked, in three tests. That was true
 * of the mock and false of real Chromium, which rejects it with
 * `TypeError: Invalid Service name: '9800'`. So the file pinned a divergence in
 * place as though it were a requirement: it would pass against the mock forever
 * while the same code threw on the first write of every real Chrome session.
 *
 * That is the inversion this ticket exists to remove -- the mock defining
 * reality for the thing it doubles. Rewritten to assert what Chromium does,
 * probed rather than assumed (Chromium 139).
 */

/** Chrome's canonical form: 128-bit, lowercase. */
const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.describe('UUID handling in the browser bundle', () => {
  test.describe('forms real Chromium rejects', () => {
    // These never reach the bridge: argument validation precedes any connect,
    // which is exactly why they are cheap and worth having.

    test('rejects the short form that this repo used to configure everywhere', async ({ page }) => {
      await setupMockPage(page, '<html><body>Short UUID</body></html>');

      const result = await page.evaluate(async () => {
        try {
          await navigator.bluetooth.requestDevice({ filters: [{ services: ['9800'] }] });
          return { threw: false, message: '' };
        } catch (error: any) {
          return { threw: true, message: String(error?.message ?? error) };
        }
      });

      expect(result.threw, "requestDevice(['9800']) must reject, as Chromium does").toBe(true);
      expect(result.message).toMatch(/Invalid Service name/i);
    });

    test('rejects an uppercase 128-bit UUID rather than downcasing it', async ({ page }) => {
      await setupMockPage(page, '<html><body>Uppercase UUID</body></html>');

      const result = await page.evaluate(async () => {
        try {
          await navigator.bluetooth.requestDevice({
            filters: [{ services: ['00009800-0000-1000-8000-00805F9B34FB'] }]
          });
          return { threw: false, message: '' };
        } catch (error: any) {
          return { threw: true, message: String(error?.message ?? error) };
        }
      });

      expect(result.threw, 'uppercase hex must reject').toBe(true);
      expect(result.message).toMatch(/Invalid Service name/i);
    });
  });

  test.describe('forms real Chromium accepts', () => {
    test('resolves the full lowercase form, and reports canonical uuids', async ({ page }) => {
      await setupMockPage(page, '<html><body>Canonical UUID</body></html>');
      const config = getBleConfig();
      await injectMockInPage(page, config);

      const result = await page.evaluate(async ({ cfg }) => {
        try {
          const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [cfg.service] }]
          });
          const server = await device.gatt!.connect();
          try {
            const service = await server.getPrimaryService(cfg.service);
            const writeChar = await service.getCharacteristic(cfg.write);
            const notifyChar = await service.getCharacteristic(cfg.notify);
            return {
              success: true,
              error: '',
              serviceUuid: service.uuid,
              writeUuid: writeChar.uuid,
              notifyUuid: notifyChar.uuid
            };
          } finally {
            // One writer slot on the bridge: release it, or the next spec's
            // connect fails with "Device is busy" naming this session.
            server.disconnect();
          }
        } catch (error: any) {
          return { success: false, error: String(error?.message ?? error) };
        }
      }, { cfg: config });

      expect(result.error).toBe('');
      expect(result.success).toBe(true);
      expect(result.serviceUuid).toMatch(CANONICAL);
      expect(result.writeUuid).toMatch(CANONICAL);
      expect(result.notifyUuid).toMatch(CANONICAL);
    });

    test('treats a numeric alias and its expansion as one characteristic', async ({ page }) => {
      await setupMockPage(page, '<html><body>Alias UUID</body></html>');
      const config = getBleConfig();
      await injectMockInPage(page, config);

      const result = await page.evaluate(async ({ cfg }) => {
        try {
          const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [cfg.service] }]
          });
          const server = await device.gatt!.connect();
          try {
            const service = await server.getPrimaryService(cfg.service);
            const canonical: string = cfg.notify;
            if (!canonical.endsWith('-0000-1000-8000-00805f9b34fb')) {
              return { skipped: true, same: false, uuid: '' };
            }
            const alias = parseInt(canonical.slice(0, 8), 16);
            const viaAlias = await service.getCharacteristic(alias as any);
            const viaString = await service.getCharacteristic(canonical);
            return { skipped: false, same: viaAlias === viaString, uuid: viaAlias.uuid };
          } finally {
            server.disconnect();
          }
        } catch (error: any) {
          return { skipped: false, same: false, uuid: '', error: String(error?.message ?? error) };
        }
      }, { cfg: config });

      test.skip(result.skipped === true, 'configured device has no 16/32-bit UUID alias');
      expect(result.same, 'alias and expanded string must return the same instance').toBe(true);
      expect(result.uuid).toMatch(CANONICAL);
    });
  });
});
