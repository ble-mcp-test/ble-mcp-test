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

This repository publishes **two clients**. The server is Python and lives in
`bridge/`, which npm never sees.

| Component | Path | Role |
| -- | -- | -- |
| Browser mock | `src/mock-bluetooth.ts` | Replaces `navigator.bluetooth`. Published as `ble-mcp-test/browser`. |
| Mock transport | `src/ws-transport.ts` | The mock's WebSocket client. |
| Shared constants | `src/constants.ts` | UUIDs and defaults. |
| Manifest helper | `src/package-metadata.ts` | Resolves name/version; both clients stamp `_mv` onto the connect URL. |
| Node client | `src/node/` | Test-harness client for driving the bridge from Node. Published as `ble-mcp-test/node`. |
| Bridge | `bridge/` | The Python WebSocket relay. Not published to npm. |

`mock-bluetooth.ts` imports exactly one local module, `ws-transport.ts`, which
imports `constants.ts` and `package-metadata.ts`. That is the whole browser
closure.

### Two clients, both supported

The **browser mock** is the reason this project exists: it gives Playwright a
`navigator.bluetooth` to drive, so a web app under test talks to real hardware
without a browser that supports Web Bluetooth.

The **Node client** (`src/node/`) is a separate entry point for integration
tests that drive a device's protocol directly, with no browser involved. It is a
plain `ws` client — it does not care what language answers, only that the wire
protocol holds. `trakrf/platform` is its live consumer.

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
