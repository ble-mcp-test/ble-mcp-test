# The conformance suite

One set of contract checks, two arms. The contract itself is
[`docs/design/2026-08-27-client-contract.md`](../../docs/design/2026-08-27-client-contract.md);
this directory is what holds an implementation to it.

| file | what it is |
|---|---|
| `contract.ts` | the checks. Imports no test runner, because it runs under two. |
| `mock-provider.ts` | arm A's provider: the mock, over a real connect. |
| `stub-bridge.ts` | an in-process WS server, so that connect is real. |
| `arm-a.test.ts` | arm A, under vitest. Runs in `just validate`. |
| `arm-b.spec.ts` | arm B, under Playwright, against real `navigator.bluetooth`. |
| `arm-status.ts` | the banner, and arm B's status inside it. |

`*.test.ts` is vitest, `*.spec.ts` is Playwright. Both runners are pointed at this
directory, and that naming is the only thing keeping them apart.

## Why two arms

**Fidelity is a comparison against the real API.** A suite that can only drive the
mock establishes that the mock agrees with itself — a control that cannot go red,
which is the failure this repo keeps paying for. Only a run that puts real
`navigator.bluetooth` under the *same* assertions can settle whether the mock
agrees with the thing it doubles, and that run is **deferred to the operator, to
be run interactively** — `requestDevice` requires a user gesture, so no CI box
can produce it. See requirement 4.

**That deferral is not the whole fidelity story, and this file used to imply it
was.** Two separate claims got collapsed:

- **Is the mock Web-Bluetooth-*shaped*?** Arm A, against the spec. Automated,
  every run, no hardware.
- **Does exercising that shape produce Web-Bluetooth-*like results from real
  hardware*?** The suites above this directory answer that, automated, against
  the bridge and a live device: `tests/integration/` drives the mock's Web
  Bluetooth surface directly from Node, and `tests/e2e/` drives the same surface
  through the browser bundle under Playwright. Both reach the real reader by way
  of the mock and the bridge.

Only the third question — *does the mock agree with Chromium's own
implementation* — needs the interactive arm. It is the narrowest of the three,
and the only one a human has to sit down for.

This is also why the suite lives here rather than in `platform`. Platform's
Playwright only ever injects the mock and drives the app; it never touches real
`navigator.bluetooth` anywhere. So it can verify *"sufficient for platform"* and
can never verify *"faithful to the spec"* — a checkable property of their test
tree, not a preference about repo boundaries.

The corollary is the half that matters, because it is where the damage happens:

> **A green platform e2e run is not evidence that the mock is faithful.** That
> inference is invalid by construction, not merely weak. Platform green means
> "platform works against this build". It never means "this build is faithful to
> Web Bluetooth."

## Arm A — the mock, every run

```bash
just test          # or: pnpm run test:conformance
```

Runs all 28 checks against the mock, through a real `requestDevice` →
`gatt.connect()` → `getPrimaryService` → `getCharacteristic` chain, against an
in-process stub bridge.

**Nothing here sets `gatt.connected` by hand.** Four unit files used to, with the
note *"a real connect needs a live bridge, and none of the lifecycle behaviour
under test touches the wire."* True of the behaviour, and fatal to the suite: a
fixture that reaches into the object under test cannot be pointed at real
`navigator.bluetooth`, so anything built on it can never compare the two, no
matter what it asserts. Replacing that reach-in was the actual work of item 2.

**What arm A does not prove.** The stub bridge models no roles, no takeover, no
release timing, no error frames. It proves the *client surface* and nothing about
the wire. That caveat is printed in the result line, not only written here — a
caveat in a file header is one nobody reads at the moment they need it, and the
pass count is what gets quoted. Release timing is the most dangerous silence
specifically, because it is the property four e2e specs encoded wrong for months
with nothing to contradict them.

## Arm B — real Chromium, opt-in

```bash
just conformance-real
```

**⚠ This arm has never been run.** It was written under TRA-1187 and no result
has been recorded. Arm A's green does not cover it — blocking exactly that
inference is what the banner is for.

Being unrun is not the same as being unfinished. Requirement 4 below is why: this
arm is interactive by construction and therefore **deferred to the operator**, so
"has anyone sat down at the box with the adapter and clicked through the chooser"
is the only thing standing between here and a result.

It needs, and none of these is optional:

1. `BLE_MCP_CONFORMANCE_ARM_B=1`
2. a machine whose Chromium can reach a real BLE adapter — BlueZ over D-Bus and a
   working `AF_BLUETOOTH` socket. **The ESPHome proxy does not count**: that is
   the *bridge's* route to the device, and Chrome knows nothing about it. So this
   is a **different host from the one the bridge runs on**, unlike every other
   hardware test here.

   ⚠ **Check the socket, not `/sys`.** Inside an unprivileged container,
   `/sys/class/bluetooth/hci0` and a `btusb` entry in `/proc/modules` can be the
   *host's* views leaking through, on a machine with no usable stack of its own.
   The test that actually answers the question:

   ```
   python3 -c "import socket; socket.socket(31, socket.SOCK_RAW, 1)"
   ```

   `[Errno 97] Address family not supported by protocol` means no, whatever
   `/sys` says.
3. a powered peripheral in range advertising the configured service
4. **a human at the keyboard.** `requestDevice()` requires transient activation
   and a user-driven chooser. The spec mandates both — *"Check that the algorithm
   is triggered while its relevant global object has a transient activation,
   otherwise throw a `SecurityError`"* and *"prompt the user to choose one of the
   devices in scanResult"* — and gives the reason: *"Pairing individual devices
   instead of device classes requires at least a user action before a device can
   be exploited."*
   ([spec](https://webbluetoothcg.github.io/web-bluetooth/#requestDevice-user-gesture))

   **That requirement is why this project exists**, so it is not a gap in arm B —
   it is arm B's permanent shape. A headless CI box cannot produce the gesture or
   answer the chooser, and routing around that is the whole point of the bridge
   and the mock. Arm B is therefore a **manual check, run by a human on a box with
   a real adapter**, not automation nobody has written yet.

   Two roads out of this were already walked and closed. A patched Chromium build
   was evaluated and lost to the bridge once the debug tooling was weighed. CDP
   `BluetoothEmulation` presents a **fake adapter**, which would have arm B
   asserting the mock against another double and destroy the only reason this arm
   exists. Neither is a live option; do not re-propose them.
5. **a secure context and the feature flag**, both probed on Chromium 139 and
   both silent when missing:
   - `navigator.bluetooth` **does not exist** in Playwright's Chromium without
     `--enable-features=WebBluetooth` — in the headless shell *or* the full
     channel. It is set in `playwright.conformance.config.ts`.
   - `about:blank` is **not a secure context** (its origin is `null`), so the API
     is absent there whatever the flags say. Arm B serves its page from
     `localhost`. It used to navigate to `about:blank`, which would have made the
     first hardware run die on `Cannot read properties of undefined (reading
     'requestDevice')` — an error that reads as a broken adapter.
6. **the three `BLE_MCP_*_UUID` variables, in canonical form.** There is no
   fallback: this repo is device-agnostic, and the old `?? '9800'` default aimed
   a hardware run at one vendor's reader. Worse, real Chromium rejects that
   spelling outright, so arm B would have died at the first call on every
   machine, before the chooser, looking like a hardware fault.

Arm B declares `injectNotification: false` and `dropLink: false`, because a real
peripheral sends what it sends when it sends it. The checks that need those
capabilities are reported **NOT RUN, by name**, rather than quietly dropped.

## Skipping is loud, on purpose

A skipped-by-default arm is only worth having if its absence is loud. A suite
reporting green with arm B silently skipped is **worse than a one-armed suite,
because it looks two-armed** — and the summary line travels while the config does
not. So arm B's status goes in what the run *prints*, and `arm-a.test.ts` asserts
the banner says which of the two cases it is. Losing the banner is a test failure,
not a quieter run.

## The three categories

- **fidelity** — must hold of the mock *and* of real `navigator.bluetooth`. Both arms.
- **divergence** — the mock is deliberately *stricter* than the real API. Arm A only,
  and each check records what the real API does instead, so the divergence stays a
  decision on the record rather than becoming folklore.
- **mock-only** — surface the real API does not have at all (`testing.*`). Arm A only.

## Proving it can go red

Not optional, and not a one-off: a check nobody has watched fail is a check nobody
has any evidence about. Two breaks demonstrated on this branch:

| break | check that caught it | what it said |
|---|---|---|
| remove the identity cache from `getCharacteristic` | `chain/characteristic-identity` | `getCharacteristic returned a different instance` |
| same break | `notify/second-lookup-does-not-evict-the-first-reference` | `notifications reaching the original reference: expected 1, got 0` |
| flip `connected` after the await in `disconnect()` | `chain/disconnect-is-synchronous` | `connected immediately after calling disconnect(): expected false, got true` |
| key `getCharacteristic` on the raw argument instead of the canonical UUID | `uuid/rejects-bare-16-bit-string` | `getCharacteristic('1234'): resolved, but should have rejected` |
| same break | `uuid/rejects-uppercase-128-bit` | `getCharacteristic() with uppercase hex: resolved, but should have rejected` |
| same break | `uuid/alias-and-expansion-are-one-characteristic` | `getCharacteristic(alias) and getCharacteristic(canonical string) returned different instances: 48879 vs 0000beef-0000-1000-8000-00805f9b34fb` |

That last row is worth reading twice: `48879` is `0xbeef` used verbatim as a map
key. The message only says that because breaking the mock showed the first
version of the check reporting `Converting circular structure to JSON` instead —
`assertEqual` stringifies, and a characteristic holds a parent back-reference. A
check whose failure message is unreadable is only half a control, and there is no
way to discover that without watching it fail.

The second row is the interesting one. It is the *silent* half of the eviction
bug — identity and delivery are two different questions, and the delivery failure
is the one that used to reach a consumer as nothing at all.
