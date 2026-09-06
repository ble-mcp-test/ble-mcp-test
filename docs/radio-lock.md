# The radio lock

One reader, two repos, and no way to ask politely.

`bin/ble-radio-lock` holds the shared CS108 for the duration of an **operation** —
not for the duration of a connection, a command, or a test. It ships as an npm
`bin`, so anything that depends on `ble-mcp-test` gets it:

```bash
ble-radio-lock --label platform-integration -- pnpm test:integration
ble-radio-lock hold          # multi-command operations; release by exiting the shell
ble-radio-lock path          # the file both sides must agree on
```

## Why a lock and not a flag

On 2026-08-31 two sessions collided on the reader and **`held: false` was
telling the truth the entire time.**

A publish ran its hardware gate, died on an expired OTP, and re-attempted 26
seconds later. A poll landed in that gap, read a device that genuinely was not
held, and took it. The second attempt then ate `DEVICE_BUSY` on every connect —
8 of 23 failed. Nobody ignored a lock and nobody read a stale value.

The failure was that **the critical section was longer than the hold protecting
it.** The critical section was *publish*; the hold was *one gate run*. It
released inside itself, twice.

So the requirement is not a better flag:

> something whose hold spans a whole operation, including retries and the gaps
> between attempts, and which is enforced rather than observed.

`held` answers *"is the device in use right now"*. Both parties were asking it
*"is someone mid-operation that needs the device"*. Nothing represented the
second thing. This does.

## The contract is the path, not this script

The mechanism is **`flock(2)` on `/tmp/ble-mcp-test.radio.lock`.** Anything that
flocks that file participates correctly, in any language — `flock(1)` from a
shell script works, and a test asserts it. The script exists to make the refusal
legible and to give an entry point one thing to wrap.

**That path is one literal with no computed default.** Not `$XDG_RUNTIME_DIR`,
not a repo root, not anything derived from the environment. Two sides resolving
different paths would each acquire successfully and exclude nothing, while every
symptom said "configured" — this codebase's second named failure class, and the
single most dangerous bug available in this design. `BLE_MCP_RADIO_LOCK` exists
for tests; it is an override, not a fallback chain, and the resolved path is
printed on every refusal so a mismatch is visible rather than silent.

## There is no way to ask whether it is free

Acquisition is the only interface. There is no `status`, no `--check`, no
`is-free`.

This is deliberate and it is the whole lesson of 2026-08-31: an observation API
is what that poll used, and **a reading that is true when taken and false when
acted upon** is how the collision happened. Any answer such a call could give is
stale by the time the caller branches on it. You cannot poll what does not
exist.

The refusal names the holder, which is the only moment that information is both
available and actionable.

## What it guarantees

**A dead holder does not deadlock the reader.** The kernel owns the lock, not a
file's contents. `Ctrl-C`, a killed vitest, an OOM, `SIGKILL` — the lock is
released when the holding process dies, by any means, with no stale-lock logic
and no liveness heuristic to get wrong. A test kills a holder with `SIGKILL` and
asserts the next acquire succeeds; a pidfile-based design turns that test red,
which is what it is for.

**It survives the holder's own disconnects.** The lock is a file. Nothing about
it touches the bridge, a WebSocket, or a device, so specs that disconnect
between reps — and best-effort `afterAll` teardown — cannot flap it.

**A contended acquire fails immediately**, exits **75** (`EX_TEMPFAIL`), and
names the holder, its pid, what it is running and for how long. It never queues:
a run that waits invisibly behind a publish is worse than one that fails saying
why. When the tool is invoked through `just`, a failed recipe reports 101
instead — the banner on stderr is the reliable signal there.

**Wrapping twice is safe.** A wrapper nested inside an ancestor's hold passes
through instead of refusing, so "one wrapping per entry point" composes rather
than becoming a question of which of two wraps to leave off. It fails closed:
the pass-through requires the same lock path, a live pid, *and* that pid being
an ancestor. Anything unverifiable falls back to a real acquire, so a marker
left exported in a stale shell buys nothing.

## What is wrapped here

| entry point | held? |
| --- | --- |
| `pnpm test:e2e`, `test:e2e:ci`, `test:e2e:dev` | yes — the wrap is outside `pretest`, which scans the device |
| `cd bridge && just hardware` | yes |
| `prepublishOnly` | the gate only — **not** the publish. See below. |
| `just conformance-real` (arm B) | **no.** See below. |

### Publish is held around the whole operation

```bash
just radio-hold        # opens a shell holding the reader
# inside it: the gate, the OTP, the retry on expiry -- all one critical section
exit                   # releases
```

`prepublishOnly` carries its own wrap, and that wrap passes through when it runs
inside the hold. **The gate's wrap is not the publish's protection**: a hold that
ends when the gate ends is precisely the 2026-08-31 defect, because the OTP and
its retry live outside it.

### Arm B is not covered, and cannot be

`just conformance-real` drives real Chromium `navigator.bluetooth` on knuckles.
`flock` is same-kernel: a lock held on mssb is invisible there, so wrapping that
recipe would read as coverage while excluding nothing.

Arm B is also invisible to the bridge — it reaches the reader through a real
Bluetooth stack rather than through the ESPHome proxy. On the other side it
surfaces as a **connect failure against a bridge reporting free**, which is not
`DEVICE_BUSY` and does not mean the transport is broken. Co-ordinate arm B by
hand.

**The lock does not shrink this rule — it makes it more important.** A green
acquisition will *feel* like clearance, and against a browser on knuckles it
still is not clearance. Holding the lock tells you no other **mssb** operation
is running; it says nothing whatsoever about the reader.

There is one observable, and it is not `held`. **A hand test holds the device
through a real connection, and a connected peripheral stops advertising** — so
the bridge cannot hear it. `held: false` is blind to that browser by
construction; the advertising probe is not. In the log:

```
esphome …: proxy reachable; waiting to hear the device      <- nothing is advertising
esphome …: heard the device advertising; requesting the BLE link
```

Read it in the honest direction. *Heard advertising* is real evidence nobody
holds the device. *Not heard* means something holds it **or** it is powered off
or out of range — those are indistinguishable from here, and it is still not a
lock. Use it to decide whether to ask, not as permission to proceed.

**You do not have to protect the gap between a hand test's reps.** A hand test
disconnects and reconnects; if the device is advertising and you take it in that
window, that is accepted — the person hand-testing would rather lose the reader
mid-session than have every automated run tiptoe around a browser that might
come back. Without this the observable above would be useless: *advertising now*
would always carry *"but someone may reconnect in a second"*, and there would be
nothing you could ever act on.

**The reciprocal is what makes that cheap, and it needs no announcement.** A hand
test that reconnects and does not find the device has its own tell — the device is
simply not there to pick — and the answer is to check the bridge's status and see
who took it. Each side's loss is visible to the side that suffers it, so neither
has to warn the other about this window. That is the whole reason it can be
conceded rather than co-ordinated.

**Same-host is the assumption.** Both participants run on mssb today. If that
stops being true, this mechanism does not survive it and the design has to
change — it will not degrade gracefully, it will silently stop excluding
anything.

## Adopting it from another repo

The reader's other consumer is `trakrf/platform`, which already depends on this
package. After a version bump:

```jsonc
"test:integration": "ble-radio-lock --label platform-integration -- vitest run tests/integration",
"test:hardware":    "ble-radio-lock --label platform-hardware    -- vitest run tests/hardware"
```

Wrap the **command**, not the connect call. Something that requires every
`connect()` to participate will be forgotten; something that wraps a whole
command composes and cannot be half-applied.

**Adopting this means deleting the convention it replaces.** The message-passing
practice — announce before taking the reader, announce on release, never act on
a `held: false` poll alone — was an interim standing in for this. Keeping both
is worse than either alone: a reader cannot tell which is authoritative, and each
side assumes the other is enforcing. Delete it in the same window the lock is
adopted, not afterwards.
