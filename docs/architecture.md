# ble-mcp-test Architecture

## Overview

Browser-based E2E tests drive **real BLE hardware** from headless environments —
CI, VMs, containers, agent sessions.

What this project mocks is the `navigator.bluetooth` **Web API**, not the
hardware. Commands travel browser → mock → WebSocket → bridge → real device, and
the responses come back the same way. If no device is reachable, connections
fail. That is correct behaviour, not a gap in the mock.

```
[Playwright/browser] → [mock-bluetooth.ts] → (WebSocket) → [Python bridge]
                                                                 ↓ TCP
                                                        [ESPHome proxy, ESP32-S3]
                                                                 ↓ BLE
                                                            [BLE device]
```

There is **no local-radio path**. The host running the tests needs no Bluetooth
stack; it reaches the reader over TCP through the ESPHome proxy. This is what
lets the suite run in a container.

Device-agnostic by design: any GATT device works, configured by UUID environment
variables. CS108 UHF RFID is the reference device, not a requirement.

## What lives where

This repository publishes **one client**, in two entry points. The server is
Python and lives in `bridge/`, which npm never sees.

| Component | Path | Role |
| -- | -- | -- |
| The mock | `src/mock-bluetooth.ts` | Replaces `navigator.bluetooth`. The whole implementation. |
| Importable entry | `src/index.ts` | The `.` entry point. Hands you the classes; where they go is the caller's business. |
| Injectable entry | `src/mock-browser-entry.ts` | The `./browser` esbuild IIFE. Assigns `window.WebBleMock`. |
| Mock transport | `src/ws-transport.ts` | The mock's WebSocket client. |
| Shared constants | `src/constants.ts` | Close-code messages and defaults. |
| UUID canonicalisation | `src/uuid.ts` | Accepts the two forms real Chromium accepts, and maps both to one canonical string. |
| Version marker | `src/version.ts` | Generated from `package.json`; stamped onto the connect URL as `_mv`. |
| Bridge | `bridge/` | The Python WebSocket relay. Not published to npm. |

`mock-bluetooth.ts` imports two local modules, `ws-transport.ts` and `uuid.ts`;
`ws-transport.ts` imports `constants.ts` and `version.ts`. That is the whole
closure, and it reaches no filesystem API — `tests/unit/entry-points.test.ts`
asserts that, because the `.` entry point did not work until it was true.

### One implementation, two entry points

The axis is **import vs inject**, not browser vs node. `window` appears nowhere
in `MockBluetooth`, `MockGATT`, `MockService` or `MockCharacteristic` — only
inside `injectWebBluetoothMock`, whose whole job is putting the mock onto a
page's navigator. So `.` serves vitest, plain Node and bundlers, and `./browser`
exists because Playwright's `addInitScript` and platform's `transformIndexHtml`
genuinely cannot `import`.

**There is no Node client.** `ble-mcp-test/node` shipped a second, hand-written
GATT chain (`NodeBleClient` and friends) that nothing ever drove: no
`requestDevice` existed on it in any released version, nothing constructed a
`NodeBleDevice`, and every inbound frame went to one flat handler, so a
hand-built device there resolved a service, resolved a characteristic, returned
from `startNotifications()` and then never fired an event. It was deleted in
0.9.0 by TRA-1187 item 4, after `trakrf/platform` — its only consumer — moved its
integration suite onto the Web Bluetooth surface.

## Ownership model

The bridge holds **one writer slot** — not a pool, and not a registry keyed on
session or device. A second key would mean a second writer on the one physical
reader the process fronts.

- **One writer at a time.** A second writer is refused with `Device is busy`
  naming the holder — *including when both connections carry the same session
  id*. The session id is a diagnostic label, not a lock.
- **Observers** (`role=observer`) attach read-only to the writer's notification
  stream. They build no transport and hold no device.
- **Takeover** (`force=true`) displaces the current writer, which is told why its
  stream ended.
- **Release is immediate.** When a writer's socket closes, the device link is
  released. No grace period, no pooling, no recovery window. A bridge that is
  merely running holds no radio.

Because release completes when the *server* processes the close, a client that
disconnects fire-and-forget can race its own next connect and be refused as busy
by its own session. Await the disconnect.

Why single-writer rather than pooling: with no op-code correlation, two writers
on one reader means client A's response settles client B's pending command. A
wrong answer, delivered promptly, wearing the shape of a right one — and neither
client is slow or sees an error.

## Protocol

The wire protocol is specified in
[`design/2026-08-23-ws-protocol-spec.md`](design/2026-08-23-ws-protocol-spec.md),
which is the acceptance criterion for the bridge. It is not restated here: two
copies of a protocol drift, and only one of them gets checked.

`docs/API.md` documents the two client APIs and the session semantics above.

## Design records

`docs/design/` holds dated ADRs — the Python replatform, the transport-lifecycle
decision, the choice of `bleak-esphome` over raw `aioesphomeapi`, and the mock
lifecycle realignment. They are point-in-time records: read them for the
reasoning, and verify against the code before acting on them.
