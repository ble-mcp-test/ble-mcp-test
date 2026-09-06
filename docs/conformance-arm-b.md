# Running conformance arm B

Arm B is the only check in this repo that can establish **fidelity** — that the
mock agrees with the API it doubles, rather than with itself. It runs real
Chromium `navigator.bluetooth` against a real peripheral, under the same
contract checks arm A runs against the mock.

It is **manual, permanently**, and it needs a host the bridge does not run on.
This file is how to run it without rediscovering any of that.

## Current status: GREEN, 21/21

Confirmed 2026-09-06 on `knuckles` against a real CS108 over BlueZ, **twice
consecutively**, exit 0 both times. The first outright pass this arm has ever
produced.

**Confirmed again the same day on `cheetah` — macOS, CoreBluetooth, installed
Google Chrome 152 — 21/21, exit 0, twice consecutively, in 1.6m and 1.3m.**
That is the run that
matters most, because all preview and prod hardware testing is done from that
machine: fidelity established only on knuckles left the shipping stack
unmeasured. Two platform stacks, one skip set, no divergence on either. So
"the mock is faithful to Web Bluetooth" now needs no qualification by platform,
and `docs/design/2026-08-27-client-contract.md` gains no platform column.

⚠ **The skip set being identical across hosts is structural, not evidence.**
Both runs report `21/42 checks run`, but which 21 is computed from
`CONFORMANCE_CHECKS` and the provider's `capabilities` literal in
`tests/conformance/arm-b.spec.ts` (`injectNotification: false`,
`dropLink: false`) — neither of which can vary by host. Do not read the
matching skip lists as a second measurement. The measurement is that both ran
green.

Getting the **first** green took two things, both of them knuckles' story rather
than the arm's. TRA-1255 fixed the mock defect the arm's first ever run found (`chain/second-device-is-distinct`: real Chromium returns the *same*
`BluetoothDevice` for a second `requestDevice()` on one peripheral; the mock minted
a distinct one, and the spec is on Chrome's side). And **blueman had to be
stopped** — see below, because it is now a precondition of the run.

A **second** failure, or this one returning, is news.

### ⚠ Kill blueman before every run (Linux hosts)

This one is `knuckles`-shaped, not universal. macOS has no blueman; its
equivalent hazard is the TCC Bluetooth grant, which fails the same way — an empty
chooser that reads as an absent device. The general rule behind both: **anything
else that can claim the adapter is a precondition to check, not background.**

```bash
pkill -f '[b]lueman-applet'; pkill -f '[b]lueman-tray'
```

The bracket in `[b]lueman` is not a typo. `pkill -f` matches against full command
lines including its own, so a plain `pkill -f blueman-applet` run from a shell
whose command line contains that string kills the shell too. Observed.

`blueman-applet` and `blueman-tray` are a **second BlueZ client** on the same
adapter, and they pair and auto-connect — contending for the peripheral Chrome is
asking for, in the window while the chooser is open. With them running, two
post-fix runs failed in two different ways: `GATT Error Unknown.` from
`startNotifications()`, and a second `requestDevice()` returning the right device
with a *different service object*, which is what a dropped link looks like. With
them stopped, two runs passed clean.

That is a well-supported hypothesis with a mechanism, **not a closed case**: the
decisive experiment — restore blueman, watch the failures come back — has not been
run, and the machine's load fell at the same time. Kill it anyway; the cost is
nothing and the alternative is a test that fails for reasons that have nothing to
do with the mock.

They come back on next login (XFCE autostart), so this is per-session unless
someone disables the autostart entries.

### ⚠ This host is slow enough to be a measurement hazard

knuckles is a 2-core 1.6GHz Celeron N3050. A headed Chromium under xrdp saturates
it — load average ~2.1 on 2 cores, to the point that terminal input lags. So
**delays between BLE operations here are scheduling latency, not operator
latency**, and answering the chooser faster changes nothing.

Arm B is timing-sensitive by construction: `chain/second-request-returns-the-same-device`
assumes the link does not drop between two `requestDevice()` calls, and on this box
that gap is wide enough for an idle CS108 to drop it. A green run from here is
therefore worth less than a green run from a fast machine. TRA-1256 moves the
confirming run to macOS/CoreBluetooth, which is both quicker and the stack that
actually ships.

## Why it needs its own host

Chrome talks to a BLE adapter through the host's own stack — BlueZ over D-Bus on
Linux, CoreBluetooth on macOS. The ESPHome proxy is the **bridge's** route to the
device; Chrome knows nothing about it. So arm B needs a machine with a real radio
of its own — unlike every other hardware test here, which only needs the bridge to
have one.

A corollary worth stating because it has already cost one wrong probe: **arm B
does not touch the bridge or the proxy at all**, so neither is a thing to check
before a run. The one shared resource is the peripheral itself, which has a
single link.

`mssb` can never be that host: `AF_BLUETOOTH` returns errno 97 there
permanently. Check the socket, never `/sys` — inside a container
`/sys/class/bluetooth/hci0` can be the host's view leaking through:

```bash
python3 -c "import socket; socket.socket(31, socket.SOCK_RAW, 1)"
```

## What `just validate` means on an arm-B host

**A clean run here is not the same command's result as a clean run on the bridge
host, and the difference is printed rather than assumed.**

`just validate` is the whole gate, but part of that gate is scaffolding that
needs things only the bridge's host has: `flock(1)`, `/proc`, `getconf CLK_TCK`,
`lsof`. An arm-B host is *structurally* not the bridge's host, and macOS has
neither `flock(1)` nor `/proc` at all. Before TRA-1257 that meant the gate was
red by construction here — 25 red on `cheetah`, 13 on `knuckles` — and a
permanent red baseline hides the next real failure inside it.

Now those suites **skip with a named reason** and the run prints which ones:

```
  present  flock(1)
  ABSENT   /proc
  ...
==============================================================================
VITEST HOST GATE on cheetah (darwin)
  N checks NOT RUN on this host:
    - ble-radio-lock  (tests/unit/radio-lock.test.ts)
        needs flock(1). ...
==============================================================================
```

So when you run the gate here:

* **Read the banner, not just the exit code.** It appears twice — once before
  the run and once beside the summary — and it is the only place the skip set
  is stated. `scripts/pre-test-cleanup.js` prints its own copy for the checks it
  could not do.
* **The skip set is pinned.** `tests/support/host-gate.ts` declares every
  host-dependent suite, and `tests/unit/host-gate.test.ts` fails if one joins
  the set without an entry. A suite cannot go quiet on its own.
* **Everything that is not scaffolding still runs here, and can still go red.**
  The mock, the client contract and conformance arm A are host-independent; none
  of them is in the skip set on any host. A green gate on this box is a real
  statement about the shipped package.
* **A skip is not a portability exemption.** Each suite names the capabilities
  it needs, so a check skipped on macOS for lacking `flock(1)` still runs — and
  can still fail — on `knuckles` and on `mssb`.

⚠ **The staleness guard does not degrade into a shrug here.** "This host cannot
inspect processes" is never on its own a pass. With nothing listening on the
bridge port it passes, because there is genuinely no daemon to be stale; with
something listening that it cannot age, it FAILS. An arm-B host runs no bridge,
so the first branch is the one you should see.

`lsof` is the one capability that is a package rather than a platform fact. If
it is missing the gate stops and says so by name — that is a real failure with a
one-line remedy, not a host quirk to absorb.

## The hosts

Arm B needs a host with a real radio of its own; **which** host is not fixed, and
results are only meaningful when the host is named alongside them. Two are in
play.

| host | stack | status |
|---|---|---|
| `knuckles` (Linux) | Blink on **BlueZ** | in use; green 21/21, 2026-09-06. Slow — see the hazard above. |
| `cheetah` (MacBook, M1) | Blink on **CoreBluetooth** | in use; **green 21/21, 2026-09-06, twice consecutively**, 1.6m and 1.3m. Fast, and the stack preview and prod testing actually use. |

`cheetah` matters for more than speed: all preview and prod hardware testing is
done from it, so fidelity established only on knuckles would leave the shipping
stack unmeasured. Safari is not an option on either — WebKit declined Web
Bluetooth, as did Firefox.

### knuckles (Linux, BlueZ)

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

### cheetah (macOS, CoreBluetooth)

Verified 2026-09-06, by command:

| | |
|---|---|
| host | `cheetah`, MacBook (Apple M1) |
| adapter | built-in Apple `BCM_4387`, controller `F4:D4:88:78:C9:66`, PCIe |
| browser | **installed Google Chrome** 152.0.7977.82, driven by `channel: 'chrome'` |
| toolchain | node 24, pnpm; Playwright 1.54.1 |
| result | 21/21, exit 0, **twice consecutively** — 1.6m and 1.3m |

#### ⚠ It must be installed Chrome, not Playwright's Chromium

macOS gates Bluetooth **per application**, in System Settings → Privacy &
Security → Bluetooth, keyed on bundle identity. Playwright's bundled Chromium is
ad-hoc-signed with no stable identity, so a grant for it is unreliable and can
evaporate between runs.

`playwright.conformance.config.ts` therefore sets `channel: 'chrome'` on darwin,
via `armBChannel(process.platform)`. It is **not** applied on other platforms:
knuckles' green was produced by bundled Chromium, and switching Linux to a
different binary would retire that baseline. `tests/unit/conformance-arm-b-headed.test.ts`
holds all three halves of that — darwin gets the channel, other platforms do not,
and the config actually passes it to the project it launches.

An ungranted app is **not refused**. It is handed an **empty chooser**, which
reads as an out-of-range peripheral or a dead adapter — the same failure shape
blueman produces on knuckles, and CLAUDE.md's failure class 2 exactly. If the
chooser comes up with nothing in it, check the permission before the bench.

The grant cannot be read from a script: `TCC.db` returns `authorization denied`
without Full Disk Access. So it is confirmed by running, not by querying. On a
first run against a Chrome that has never used Bluetooth, macOS prompts — answer
it; that path is fine, and it is only a **previously denied** grant that produces
the silent empty chooser.

#### CoreBluetooth does not expose MAC addresses

Peripherals are per-host UUIDs, so the CS108 does **not** appear as
`6C:79:B8:26:03:A7` the way it does on knuckles. Harmless — arm B filters on
service UUID — but it will look wrong to anyone diffing the two runs side by
side. Pick `CS108Reader2603A7` by name.

#### No blueman here, and nothing that replaces it

macOS has no second BLE client daemon contending for the adapter, so the
knuckles precondition does not carry over. The general rule behind it still
does: anything else able to claim the adapter is a precondition to check. On
this host that list is short — an already-paired CS108 held by another app, or
a bridge holding the reader's single link from elsewhere.

#### This host is fast, which is the point

21 checks in **1.6 and 1.3 minutes**, operator-paced throughout. Contrast knuckles,
where the same 1.6m is scheduling latency on a saturated 2-core Celeron. The
timing-sensitive check — `chain/second-request-returns-the-same-device`, which
assumes the link survives the gap between two `requestDevice()` calls — has the
narrowest window it will get here. That is why `cheetah` is the confirming run
rather than a second opinion.

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

`.env.local` on `cheetah` already carries the canonical forms, so that trap is
knuckles-specific. Pass them explicitly anyway — the Playwright config loads no
dotenv file, so an inherited value is a property of your shell rather than of
the run.

## Coordinating the radio

`just conformance-real` is **deliberately not under the radio lock**, and this is
the one hole in that lock's coverage. `flock` is same-kernel: a lock held on mssb
is invisible on knuckles, so wrapping arm B would read as coverage while
excluding nothing.

Worse, the two claimants are mutually invisible. Arm B reaches the CS108 through
the arm-B host's own Bluetooth stack; the bridge reaches it over TCP through the
ESPHome proxy. Neither can see the other. Contention surfaces on the bridge side as a
connect failure against a reader it believes is free.

So **coordinate by hand, and confirm it with a person**:

1. Query `get_connection_state` on the bridge — it reports `held`, `session` and
   `observer_count`.
2. `held: false` answers *ownership*, not *intent*. Someone may be about to take
   it. Say out loud that you are taking the radio.
3. Check for a browser session on any other machine holding the reader.

## Running it

From the repo on whichever host you are using — knuckles at the XFCE desktop,
cheetah at the Mac desktop — with that host's setup section above satisfied:

```bash
BLE_MCP_CONFORMANCE_ARM_B=1 \
BLE_MCP_SERVICE_UUID=00009800-0000-1000-8000-00805f9b34fb \
BLE_MCP_WRITE_UUID=00009900-0000-1000-8000-00805f9b34fb \
BLE_MCP_NOTIFY_UUID=00009901-0000-1000-8000-00805f9b34fb \
pnpm run test:conformance:real
```

`just conformance-real` sets only `BLE_MCP_CONFORMANCE_ARM_B`; the UUIDs are
yours to supply.

A browser window opens — bundled Chromium on Linux, installed Google Chrome on
macOS. **The chooser appears once per runnable check** — 21 as the contract
stands — because every check calls `provider.open()` and each `requestDevice()`
needs its own gesture and its own choice. Pick the peripheral
(`CS108Reader2603A7`) and confirm, each time. The run prints which check it is
waiting on, so a chooser reappearing is distinguishable from one that hung.

The only bytes arm B writes are `0x01 0x02`, which is not a valid CS108 frame
(those open `A7 B3`). It will not start an inventory.

### The reconnect churn, which is harder on the radio than any real client

Every check opens its own session, so a full run connects and disconnects 21
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

This path has now fired on both hosts and behaved both times — once on knuckles
(operator stepped away, `0/19`) and once on cheetah between its two greens
(chooser dismissed, `0/21`, exit 1). Both were discarded rather than recorded.
That is the mechanism working, and it is the reason a cancelled chooser cannot
enter the fidelity record as "real Chromium violates this clause".

⚠ **Read the run's own exit code, not a wrapper's.** A backgrounded run reports
the wrapper's status, which is 0 even when the run inside it exited 1. The
banner and the `ABORTED` line are what say which happened.

## Three things that must not be re-broken

All three are held by `tests/unit/conformance-arm-b-headed.test.ts`. Two were
discovered the first time this arm was actually run; the third, on the first
macOS run. They share a shape: each one fails as **an empty or absent chooser**,
which reads as broken hardware rather than as a misconfigured browser.

0. **It drives installed Chrome on macOS.** See the `cheetah` section — bundled
   Chromium cannot hold the TCC grant, and the failure is an empty chooser rather
   than an error.
1. **It runs headed.** `playwright.conformance.config.ts` sets `headless` from
   `armBStatus(process.env)`, so it is false exactly when arm B is requested. A
   headless browser shows no chooser, `requestDevice()` never settles, and the
   run dies on the test timeout looking like a dead adapter.
2. **The timeout is a person's, not a machine's.** All 21 chooser answers happen
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
