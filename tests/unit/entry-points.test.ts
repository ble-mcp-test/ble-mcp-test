import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import * as barrel from '../../src/index.js';

/**
 * The package has TWO entry points and ONE implementation, and the axis between
 * them is import-vs-inject -- not browser-vs-node.
 *
 * The old axis was `./browser` vs `./node`, which reads as two implementations of
 * `navigator.bluetooth`, one per runtime. There is one. `src/node/` is a second,
 * hand-written GATT chain that nothing has ever constructed (no `requestDevice`,
 * no factory) and nothing ever routes notifications into -- so it resolves a
 * service, resolves a characteristic, returns from `startNotifications()`, and
 * then never fires an event. It is item 4's subject and is still shipped here.
 *
 * `.` exists because the browser bundle is an esbuild IIFE with zero `export`
 * statements: it assigns `window.WebBleMock` and requires a `window`, so vitest
 * cannot import it at all. `./browser` stays exactly as it is, because
 * Playwright's `addInitScript` and platform's `transformIndexHtml` genuinely
 * cannot import -- that is a real constraint, not a compatibility concession.
 */
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const pkg = JSON.parse(readFileSync(projectRoot + 'package.json', 'utf-8'));

describe('the `.` entry point', () => {
  it('exports the Web Bluetooth implementation', () => {
    expect(typeof barrel.MockBluetooth).toBe('function');
    expect(typeof barrel.MockBluetoothRemoteGATTCharacteristic).toBe('function');
    expect(typeof barrel.injectWebBluetoothMock).toBe('function');
  });

  it('exports the transport and the config surface', () => {
    expect(typeof barrel.WebSocketTransport).toBe('function');
    expect(typeof barrel.updateMockConfig).toBe('function');
    expect(typeof barrel.resolveMockConfig).toBe('function');
    expect(barrel.DEFAULT_MOCK_CONFIG).toBeTypeOf('object');
  });

  it('exports the version constant, not a function that guesses at one', () => {
    expect(barrel.VERSION).toBe(pkg.version);
  });

  it('is declared in the exports map', () => {
    expect(pkg.exports['.']).toBeDefined();
    expect(pkg.exports['.'].import).toBe('./dist/index.js');
    expect(pkg.exports['.'].types).toBe('./dist/index.d.ts');
  });

  it('keeps ./browser pointing at the IIFE, unchanged', () => {
    // Playwright's addInitScript and platform's transformIndexHtml cannot import.
    expect(pkg.exports['./browser']).toBe('./dist/web-ble-mock.bundle.js');
  });
});

describe('the built package', () => {
  // Skipped rather than failed when dist/ is absent: a fresh clone has not built
  // yet, and a red test that only means "you have not run pnpm build" trains
  // people to ignore this file. Loud about which case it is, either way.
  const built = existsSync(projectRoot + 'dist/index.js');

  it.skipIf(!built)('has the file the exports map promises', () => {
    expect(existsSync(projectRoot + 'dist/index.js')).toBe(true);
    expect(existsSync(projectRoot + 'dist/index.d.ts')).toBe(true);
  });

  it.skipIf(!built)('reaches no filesystem API from the ESM entry point', () => {
    // The whole reason `.` did not exist before: ws-transport reached
    // package-metadata.js through a dynamic import, and that reads package.json
    // with readFileSync from inside connect(). Invisible to a static read of the
    // import graph, because `await import()` is not an `import` line.
    const chain = ['dist/index.js', 'dist/mock-bluetooth.js', 'dist/ws-transport.js']
      .map(f => readFileSync(projectRoot + f, 'utf-8'))
      .join('\n')
      // Comments only, stripped -- tsc preserves them, and these very files
      // explain in prose what they no longer do. The claim is about code.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(chain).not.toMatch(/from ['"]fs['"]/);
    expect(chain).not.toMatch(/readFileSync/);
    expect(chain).not.toMatch(/await import\(/);
  });
});
