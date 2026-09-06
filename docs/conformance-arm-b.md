# Running conformance arm B

Arm B is the only check in this repo that can establish **fidelity** — that the
mock agrees with the API it doubles, rather than with itself. It runs real
Chromium `navigator.bluetooth` against a real peripheral, under the same
contract checks arm A runs against the mock.

It is **manual, permanently**, and it needs a host the bridge does not run on.
This file is how to run it without rediscovering any of that.

## Current status: known-red, 18/19

First run 2026-09-06 on `knuckles` against a real CS108. One failure,
`chain/second-device-is-distinct`, tracked by **TRA-1255**: real Chromium returns
the same `BluetoothDevice` for a second `requestDevice()` on the same peripheral
and the mock returns a distinct one. The spec is on Chrome's side, so the mock is
the defect.

Expect that one red until TRA-1255 lands. A **second** failure is news.

## Why it needs its own host

Chrome talks to a BLE adapter through BlueZ over D-Bus. The ESPHome proxy is the
**bridge's** route to the device; Chrome knows nothing about it. So arm B needs a
machine with a real radio of its own — unlike every other hardware test here,
which only needs the bridge to have one.

`mssb` can never be that host: `AF_BLUETOOTH` returns errno 97 there
permanently. Check the socket, never `/sys` — inside a container
`/sys/class/bluetooth/hci0` can be the host's view leaking through:

```bash
python3 -c "import socket; socket.socket(31, socket.SOCK_RAW, 1)"
```

## The host: knuckles

Verified 2026-09-06, by command:

| | |
|---|---|
| host | `knuckles` (Intel NUC5), dedicated to this repo |
| adapter | `hci0`, USB `0b05:1bf6` — **ASUS BT500** (Realtek), BD `BC:FC:E7:2D:76:12` |
| onboard radio | Intel `8087:0a2a`, **deauthorized** by `/etc/udev/rules.d/81-ble-mcp-disable-intel-bt.rules` |
| display | xrdp → XFCE, `DISPLAY=:10.0` |
| toolchain | fnm; node 24.8.0, pnpm 10.17.0 |

**Only one `hci` device exists, and that is deliberate.** The Intel radio is the
one measured to fail disconnect recovery silently; the udev rule sets
`authorized=0` on it at plug time so it never enumerates. If `hciconfig` ever
shows two adapters, stop — Chrome will pick one and you will not be told which.

Confirm the active adapter is the ASUS, rather than assuming:

```bash
for d in /sys/class/bluetooth/hci*; do
  p=$(readlink -f "$d/device")
  echo "$d vendor=$(cat "$p/../idVendor") product=$(cat "$p/../idProduct")"
done
# want: vendor=0b05 product=1bf6
```

### The login-shell trap

Node on knuckles is managed by **fnm**, which initialises from the shell rc
file. A non-interactive `ssh knuckles.local 'node -v'` never sources it and
reports `command not found` — which reads as *not installed* rather than *not on
this shell's PATH*, and has already sent one round of work chasing an install
that was never needed. Use a login shell for anything scripted:

```bash
ssh knuckles.local 'bash -lic "node -v"'
```

An XFCE terminal over xrdp is already a login shell, so working there sidesteps
this entirely — and you need to be at that desktop anyway, to answer the chooser.

## The UUIDs, which have no fallback

Arm B requires the three `BLE_MCP_*_UUID` variables in **canonical form**: full
lowercase 128-bit. There is deliberately no default — this repo is
device-agnostic, and a default would silently aim a hardware run at one vendor's
reader.

⚠ **`.env.local` on knuckles carries the short forms** (`9800`, `9900`, `9901`)
from the v0.4.0 local-BlueZ era. Real Chromium rejects that spelling outright
(`TypeError: Invalid Service name: '9800'`), so a run that inherits them dies at
the first call, before the chooser, looking like a hardware fault. Pass the
expanded forms explicitly:

```bash
BLE_MCP_SERVICE_UUID=00009800-0000-1000-8000-00805f9b34fb
BLE_MCP_WRITE_UUID=00009900-0000-1000-8000-00805f9b34fb
BLE_MCP_NOTIFY_UUID=00009901-0000-1000-8000-00805f9b34fb
```

Those are the CS108's. A different peripheral means different values; nothing in
the suite assumes these.

## Coordinating the radio

`just conformance-real` is **deliberately not under the radio lock**, and this is
the one hole in that lock's coverage. `flock` is same-kernel: a lock held on mssb
is invisible on knuckles, so wrapping arm B would read as coverage while
excluding nothing.

Worse, the two claimants are mutually invisible. Arm B reaches the CS108 through
knuckles' own Bluetooth stack; the bridge reaches it over TCP through the ESPHome
proxy. Neither can see the other. Contention surfaces on the bridge side as a
connect failure against a reader it believes is free.

So **coordinate by hand, and confirm it with a person**:

1. Query `get_connection_state` on the bridge — it reports `held`, `session` and
   `observer_count`.
2. `held: false` answers *ownership*, not *intent*. Someone may be about to take
   it. Say out loud that you are taking the radio.
3. Check for a browser session on any other machine holding the reader.

## Running it

From the repo on knuckles, at the XFCE desktop:

```bash
BLE_MCP_CONFORMANCE_ARM_B=1 \
BLE_MCP_SERVICE_UUID=00009800-0000-1000-8000-00805f9b34fb \
BLE_MCP_WRITE_UUID=00009900-0000-1000-8000-00805f9b34fb \
BLE_MCP_NOTIFY_UUID=00009901-0000-1000-8000-00805f9b34fb \
pnpm run test:conformance:real
```

`just conformance-real` sets only `BLE_MCP_CONFORMANCE_ARM_B`; the UUIDs are
yours to supply.

A Chromium window opens. **The chooser appears once per runnable check** — 19 as
the contract stands — because every check calls `provider.open()` and each
`requestDevice()` needs its own gesture and its own choice. Pick the peripheral
(`CS108Reader2603A7`) and confirm, each time. The run prints which check it is
waiting on, so a chooser reappearing is distinguishable from one that hung.

The only bytes arm B writes are `0x01 0x02`, which is not a valid CS108 frame
(those open `A7 B3`). It will not start an inventory.

### The reconnect churn, which is harder on the radio than any real client

Every check opens its own session, so a full run connects and disconnects 19
times in a row. Nothing a consumer does looks like that. Observed 2026-09-06:
five checks in, `Connection Error: Connection attempt failed.` — the peripheral
had not finished tearing the previous link down and resuming advertising.

So `close()` settles for 750ms, and `gatt.connect()` is retried four times with
a backoff. **The retry is on the link, never on the choice** — re-entering
`requestDevice()` would cost the operator an extra chooser per attempt, and the
whole run is paced by that keyboard. Nothing in the contract asserts that
`gatt.connect()` succeeds first time, so retrying it conceals no clause; it
makes the transport reliable enough to ask about the clauses that *are*
asserted.

An abort that outlives four attempts is reported as a link failure, and a
dismissed chooser is reported as a dismissed chooser. They have different
remedies, so the run does not describe them with one sentence.

### An aborted run is not a red run

If the chooser goes unanswered or the link will not attach, arm B stops and says
how far it got. That is an **unfinished** run and says nothing about fidelity in
either direction. Only a completed run with failures is evidence against the
mock. Do not record an abort as a failure on the ticket, and do not record it as
a pass.

## Two things that must not be re-broken

Both were discovered the first time this arm was actually run, and both are held
by `tests/unit/conformance-arm-b-headed.test.ts`.

1. **It runs headed.** `playwright.conformance.config.ts` sets `headless` from
   `armBStatus(process.env)`, so it is false exactly when arm B is requested. A
   headless browser shows no chooser, `requestDevice()` never settles, and the
   run dies on the test timeout looking like a dead adapter.
2. **The timeout is a person's, not a machine's.** All 19 chooser answers happen
   inside a single `page.evaluate`, sharing one test timeout rather than getting
   one each. It is 45 minutes when arm B is requested.

And one in the spec itself, which is why the arm had never produced a result:
`requestDevice()` requires **transient activation**, and `page.evaluate()` has
none. Called from injected script it throws
`SecurityError: Must be handling a user gesture to show a permission request`
before any chooser appears. Arm B therefore drives a real button click, which
grants activation exactly as a hand-driven click does; the **human still answers
the chooser**. Driving the button is not faking the adapter — radio, peripheral,
chooser and choice all stay real. The gesture was never the part that needed a
person; the choice is.

Do not "fix" any of this by reaching for CDP `BluetoothEmulation`. It presents a
**fake adapter**, which would have arm B asserting the mock against another
double and destroy the only reason the arm exists.
