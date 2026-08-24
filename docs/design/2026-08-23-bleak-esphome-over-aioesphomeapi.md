# Use bleak-esphome, not aioesphomeapi alone

**Status:** DECISION, 2026-08-23. Proposed on the TRA-1158 PR and revertible on its own commit.
**Tracking:** TRA-1158 (decided and implemented).

**Decision.** The Python BLE transport is built on **`bleak-esphome`**, which sits on
`aioesphomeapi` — not on `aioesphomeapi` directly.

This needs writing down because the obvious reading of the evidence points the other way, and
the next person to read `2026-08-23-bleak-esphome-notify-audit.md` will reach that reading
within about ten minutes.

---

## The argument for dropping bleak-esphome, which is strong

Every guarantee the notify audit established lives in **`aioesphomeapi`**, not in
`bleak-esphome`:

| Guarantee | Where it actually is |
|---|---|
| `(address, handle)` correlation — TRA-1154's class does not exist here | `aioesphomeapi/client_base.py:172` |
| No queue; backpressure rather than unbounded growth | `aioesphomeapi/connection.py:1175-1210` |
| Subscriptions cannot outlive their connection — `3f7eefb`'s class, structurally | `_message_handlers` on `APIConnection` |
| Handler exceptions isolated rather than tearing down the session | `aioesphomeapi/connection.py:1184-1192` |

`bleak-esphome`'s contribution to that entire trace is **one line** — the
`lambda handle, data: callback(data)` adapter at `backend/client.py:902`.

And our transport seam is not Bleak-shaped. `ble_bridge.transport.BleTransport` is four methods
of our own design, so `bleak-esphome` would be adapting `aioesphomeapi` to Bleak so that we could
adapt Bleak to `BleTransport` — two adapters where one would do.

**Measured dependency cost, 2026-08-23:**

```
aioesphomeapi alone   13 packages   protocol, crypto, network
+ bleak-esphome     + 24 packages   incl. dbus-fast, bluetooth-auto-recovery,
                                    pyric, btsocket, bluetooth-adapters, habluetooth
```

Those additions are **local-radio machinery**, in a design whose stated premise
(`2026-08-23-python-bridge-rewrite.md`) is that "once the BLE stack is a remote ESP32 reached
over TCP, **no local BLE library is in the path**."

So: one line of value, two adapters, and 24 packages of exactly the thing we set out to delete.

## What that argument misses, and it is decisive

**`aioesphomeapi.bluetooth_gatt_start_notify` does not write the CCCD.**

It registers the message callback and sends `BluetoothGATTNotifyRequest`
(`aioesphomeapi/client.py:1340-1380`). That tells the *proxy* to forward notifications. It does
not tell the *peripheral* to send them.

The descriptor write that actually enables them at the device is in **`bleak-esphome`**, at
`backend/client.py:908-941`, and it is not a one-liner:

- it is **gated on `BluetoothProxyFeature.REMOTE_CACHING`** — required on v3 connections, where
  the ESP32 deliberately has not resolved descriptors in order to avoid exhausting its memory,
  and skipped otherwise;
- it picks **`CCCD_NOTIFY_BYTES` vs `CCCD_INDICATE_BYTES` from the characteristic's own
  properties**, rather than assuming notify;
- it **unwinds the subscription** on any failure, `BaseException` included, so a failed CCCD
  write does not leave a half-subscribed handle behind.

`rust-ble-test/src/ble_esphome.rs:270-330` hand-rolls this: unconditional, always
`[0x01, 0x00]`, and a printed warning when no CCCD is found. That worked for one device on one
firmware. It is not a general implementation, and the difference is invisible until the day it
is a broken session nobody can explain.

**Dropping `bleak-esphome` therefore does not remove an adapter. It moves a correctness detail
out of a maintained library and into this repository, permanently.** That is the trade actually
on offer, and it is a bad one — this is the same reasoning that rejected
`@2colors/esphome-native-api` in the rewrite doc, which would have meant owning TRA-1154's and
#583's fixes in someone else's code.

## Consequences

- **The dependency tree is larger than the design doc implies, and that is accepted.** The
  local-radio packages are pulled in but never reached: we create no local scanner, so
  `dbus-fast`, `pyric` and `btsocket` are dead weight on disk rather than code in the path.
  Verified by construction — `BluetoothManager().async_setup()` completes in this container,
  where `AF_BLUETOOTH` returns errno 97 and there is no Bluetooth stack at all.
- **`habluetooth`'s manager is process-wide**, and is the single exception to the
  per-connection rule in `2026-08-23-transport-lifecycle-decision.md`. It is a registry of
  scanners: it holds no radio, opens no socket and reaches no device. Scanners are registered
  and unregistered per connection. A daemon with no clients still holds nothing.
- **A local radio would come back nearly free**, since `ESPHomeClient` is a `BaseBleakClient`.
  This is a genuine side benefit but it was **not** a reason for the decision — TRA-1155 exists
  to make the proxy the only backend, so a hypothetical second one should not carry weight.
- **If this is ever revisited**, the thing to re-check first is whether `aioesphomeapi` has
  absorbed the CCCD write. That single fact is what the decision turns on, and it is the kind of
  thing that changes upstream without anyone here noticing.

## What this does not claim

The transport has **not been executed against hardware** as of this writing. This decision is
about which library owns the CCCD path, and it is settled by reading both libraries' source. It
is not evidence that the resulting transport works — that is TRA-1158's hardware acceptance
criterion, and it is still open.
