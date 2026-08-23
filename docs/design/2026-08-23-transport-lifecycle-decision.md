# The bridge process must not hold the radio

**Status:** DECISION, 2026-08-23. Proposed on PR #49 and revertible on its own commit.
**Tracking:** TRA-1157 (decided and implemented), TRA-1158 (must not undo it).

**Decision.** The Python bridge constructs its BLE transport **inside the per-connection
handler**, not once at process start. A daemon with no WebSocket clients holds no device. The
last client disconnecting releases it.

This inverts `rust-ble-test`, and the inversion is deliberate rather than incidental — so it
needs to be written down, because the next person implementing a transport will otherwise
reproduce the shape they see in the Rust code.

---

## The constraint that produced it

`rust-ble-test/src/main.rs` calls `transport.connect()` once at startup and holds the CS108 link
for the lifetime of the process. A WebSocket client disconnecting releases nothing. `SIGTERM` is
the only release.

Three consequences follow, and only the first is obvious:

1. **The bridge holds the radio whether or not anyone is using it.** Process lifetime is a
   *resource claim*, not just a server being available.
2. **Any direct-Web-Bluetooth workflow on the same machine is mutually exclusive with the bridge
   merely RUNNING.** Not with the bridge being *used* — with it being *up*. Stopping the tests is
   not enough; the process must die. The peripheral will not accept a second connection.
3. **An idle listening port does not mean the device is free.** A browser holding the CS108 never
   appears as a WebSocket client, so the two states an operator can distinguish — port listening,
   port quiet — are both compatible with the radio being held by someone else.

## How it was found

Not by reading the code. On 2026-08-23 a person wanted to hand-test against the reader through
`navigator.bluetooth`, and could not: the bridge process was up, idle, with zero WebSocket
clients, holding the link. It had been orphaned to init by a session that had long since ended,
so nobody owned its lifecycle. `SIGTERM` to PID 1709591 freed the device.

The first hypothesis was a bind-address problem — the bridge listens on `127.0.0.1`, and the
browser was reaching a preview deployment, so loopback-vs-`0.0.0.0` looked like the cause. It was
not, and the check that killed that theory is worth recording: the mock is injected only when
`VITE_BLE_BRIDGE_ENABLED === 'true'`, with an explicit early return otherwise, so a preview build
never routes through this bridge at all. Acting on the first hypothesis would have meant exposing
an unauthenticated WebSocket endpoint to the LAN to fix a problem that did not exist.

**The bridge is test tooling and never part of a production path.** The product reaches a device
through `navigator.bluetooth` directly, in prod, in preview, and in every normal build. Framing it
as "one of two ways to reach the reader" invites someone to imagine a supported bridge-in-production
path that must never exist.

## Why per-connection rather than an idle timeout

The TypeScript bridge had an idle timeout (`session-manager.ts:27`, default 60s) and the Rust
bridge dropped it. An idle timeout is the same idea with a delay bolted on: it narrows the window
in which the claim is held pointlessly, but it does not remove it, and it introduces a second
question — how long — whose answer is a guess. Binding the claim to the thing that actually needs
it removes the window instead of shrinking it.

The Python structure gets this for free rather than by mechanism. `BridgeServer._handle` calls
`self._factory(params)` per connection and `transport.cleanup()` in its `finally`. There is no
process-lifetime transport to release because none is ever constructed.

## Consequences

- **TRA-1158 must not connect at startup.** The ESPHome transport satisfies `BleTransport` and is
  built by the factory like any other. A module-level connection would silently reintroduce
  everything above.
- **Connection cost moves into the first client's connect.** A real device takes seconds to link
  where a stub takes microseconds, so the first `connected` frame will be slower than the
  firehose suggests. That is the correct place for the cost to land: it is paid by whoever asked
  for the device.
- **Concurrent clients need an ownership model.** Per-connection transports mean two clients get
  two transports, which a single physical peripheral cannot honour. TRA-1159 owns single-writer /
  multi-observer. This decision does not answer that question; it only ensures the answer is not
  "whoever started the process first, forever."
- **The startup log must state the radio posture, not just the port.** Consequence 3 above is
  precisely the failure class CLAUDE.md warns about: the operator's evidence is identical in both
  states. `ws/server.py` logs the resolved bind, whether it is loopback, and that no device is
  held until a client connects.

## What is pinned, and where

`test_a_daemon_with_no_clients_holds_no_transport` and
`test_transport_is_cleaned_up_when_the_client_goes_away` in `bridge/tests/test_relay.py`. Both
would pass trivially against a process-lifetime transport if written carelessly, so the first
asserts the factory was never called rather than asserting some observable absence.
