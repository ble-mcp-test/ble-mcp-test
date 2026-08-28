/**
 * Arm A's provider: the mock, driven through a REAL connect against an
 * in-process stub bridge.
 *
 * The thing that makes this arm A rather than "the old unit tests in a new
 * directory" is that nothing here sets `gatt.connected`. Four unit files did,
 * with the note "a real connect needs a live bridge, and none of the lifecycle
 * behaviour under test touches the wire." True of the behaviour, fatal to the
 * suite: a fixture that reaches into the object under test cannot be pointed at
 * `navigator.bluetooth`, so a suite built on it can never compare the two.
 */
import { MockBluetooth } from '../../src/index.js';
import { startStubBridge, type StubBridge } from './stub-bridge.js';
import type { ConformanceProvider, ConformanceSession, ProviderCapabilities } from './contract.js';

/**
 * Deliberately synthetic, and deliberately NOT the CS108's real UUIDs.
 *
 * These reach a stub bridge that accepts anything, so their only job is to be
 * unmistakably fake -- using the reference device's real service here made an
 * arbitrary fixture look load-bearing, and this repo is device-agnostic by
 * design (CS108 is the reference device, not a requirement). They are 16-bit
 * aliases of the Bluetooth Base UUID so that `aliasableUuids` holds and the
 * two-spellings check can run.
 */
const SERVICE = '0000f00d-0000-1000-8000-00805f9b34fb';
const WRITE = '0000c0de-0000-1000-8000-00805f9b34fb';
const NOTIFY = '0000beef-0000-1000-8000-00805f9b34fb';

/**
 * Arm A's capabilities, exported because the suite must be partitioned at
 * COLLECTION time -- before `beforeAll` has built the provider.
 *
 * It lived as a second literal in arm-a.test.ts, cast `as MockProvider`, and the
 * cast is what let the two drift: adding a capability updated one copy and the
 * compiler had been told not to look at the other. Same defect class as the
 * ticket this suite was built for, one directory away.
 */
export const MOCK_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  injectNotification: true,
  dropLink: true,
  testingApi: true,
  aliasableUuids: true
};

export interface MockProvider extends ConformanceProvider {
  /** Shut down the stub bridge. Call once, after all checks. */
  shutdown(): Promise<void>;
}

export async function createMockProvider(): Promise<MockProvider> {
  const bridge: StubBridge = await startStubBridge();
  const openSessions = new Set<ConformanceSession>();

  return {
    name: 'arm A (mock + in-process stub bridge)',
    capabilities: MOCK_PROVIDER_CAPABILITIES,

    async open(): Promise<ConformanceSession> {
      const bluetooth = new MockBluetooth(bridge.url, {
        service: SERVICE,
        write: WRITE,
        notify: NOTIFY,
        sessionId: `conformance-${openSessions.size}`,
        timeout: 5000,
        onMultipleDevices: 'error'
      });
      const device: any = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE);
      const session: ConformanceSession = {
        device,
        server,
        service,
        writeCharacteristic: await service.getCharacteristic(WRITE),
        notifyCharacteristic: await service.getCharacteristic(NOTIFY)
      };
      // The mock instance is not on the session type -- it is not part of the
      // contract -- so it is stashed where `bluetooth()` can find it again.
      (session as any).__bluetooth = bluetooth;
      openSessions.add(session);
      return session;
    },

    async close(session) {
      openSessions.delete(session);
      try {
        await session.server.disconnect();
      } catch {
        // Already gone. A check that drops the link on purpose lands here.
      }
    },

    async inject(session, bytes) {
      // Pushed from the stub, so it arrives the way a device frame arrives:
      // through the transport, through the device's fan-out, through the
      // characteristic's subscription gate. Calling triggerNotification directly
      // would bypass every one of those and assert nothing about them.
      void session;
      bridge.notify(bytes);
    },

    async drop(session) {
      void session;
      bridge.drop();
    },

    bluetooth(session) {
      return (session as any).__bluetooth;
    },

    async shutdown() {
      for (const session of openSessions) {
        try {
          await session.server.disconnect();
        } catch {
          // best effort
        }
      }
      openSessions.clear();
      await bridge.close();
    }
  };
}
