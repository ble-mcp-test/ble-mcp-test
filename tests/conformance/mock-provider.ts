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
import type { ConformanceProvider, ConformanceSession } from './contract.js';

const SERVICE = '9800';
const WRITE = '9900';
const NOTIFY = '9901';

export interface MockProvider extends ConformanceProvider {
  /** Shut down the stub bridge. Call once, after all checks. */
  shutdown(): Promise<void>;
}

export async function createMockProvider(): Promise<MockProvider> {
  const bridge: StubBridge = await startStubBridge();
  const openSessions = new Set<ConformanceSession>();

  return {
    name: 'arm A (mock + in-process stub bridge)',
    capabilities: {
      injectNotification: true,
      dropLink: true,
      testingApi: true
    },

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
