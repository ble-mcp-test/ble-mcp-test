# Holding a shared device for an operation, not for a connection

**Status:** proposed
**Tracking:** TRA-1241. Related: TRA-1216 (`DEVICE_BUSY_SELF`), TRA-1225
**Date:** 2026-09-06

The mechanism is in [`../radio-lock.md`](../radio-lock.md). This records the four
decisions behind it and what each one rejected, because every one of them is a
thing the next person will otherwise re-decide the easy way.

## The problem is a duration, not a value

On 2026-08-31 two sessions collided on the reader while `held: false` reported
the truth throughout. A publish gate finished, an OTP expired, and a retry began
26 seconds later; a poll landed in the gap and took a device that genuinely was
free.

The obvious reading — the flag was wrong, or someone read it carelessly — is the
wrong one, and it is worth saying plainly because it is the reading that
produces a worse fix. **The flag was right and both parties read it correctly.**
The critical section was *publish*; the hold protecting it was *one gate run*.
It released inside itself, twice.

A value that is true when read and false when acted upon cannot be fixed by
making it more accurate. It has to be replaced by something with a *duration*.

## 1. Acquisition is the only interface

**There is no way to ask whether the lock is free.** No `status`, no `--check`.

This is the decision most likely to be reverted by someone being helpful, so:
an observation API is what the 2026-08-31 poll used. Any answer such a call can
give is stale by the time the caller branches on it — the gap between reading
and acting is the bug, and no amount of freshness closes it. Adding the call
back re-creates the incident with better telemetry.

The holder's identity is reported at exactly one moment: the refusal. That is
when it is both accurate and actionable.

**Rejected:** a `held`-style query with documentation saying not to trust it.
That is what already existed. A comment is not a mechanism.

## 2. `flock(2)`, not a pidfile

The lock is a kernel object, so it is released when its holder dies — `SIGKILL`,
OOM, `Ctrl-C`, a killed vitest, all of them — with **no stale-lock logic and no
liveness heuristic**. Platform's constraint was that a dead holder must not
deadlock the reader; this satisfies it by having no code path that could fail to.

**Rejected:** an exclusive-create pidfile with a `kill -0` staleness check. It
needs recovery logic, that logic needs to guess, and pid reuse makes the guess
wrong occasionally and unreproducibly. The test that kills a holder with
`SIGKILL` and asserts the next acquire succeeds turns red against a pidfile
design; that is what it is there for.

**Consequence:** same-kernel only. Named below.

## 3. One literal path, never a computed one

`/tmp/ble-mcp-test.radio.lock`, hardcoded. Not `$XDG_RUNTIME_DIR`, not a repo
root, not anything derived.

Two participants resolving *different* paths would each acquire successfully and
exclude nothing, and every symptom would say "configured": no error, no delay,
no red state — this codebase's second named failure class, in the one place
where it would silently unbuild the entire mechanism. A wrong shared path fails
loudly for everyone; a divergent path fails for no one until the reader is taken
twice.

`BLE_MCP_RADIO_LOCK` exists for tests. It is an override, not a fallback chain,
and the resolved path prints on every refusal so a mismatch is visible.

**Rejected:** `$XDG_RUNTIME_DIR` with a `/tmp` fallback. It is better hygiene and
it is exactly the shape that would break: the bridge runs under `systemd --user`
and has the variable, an agent's shell often does not.

## 4. Re-entrancy, failing closed

A wrapper nested inside an ancestor's hold passes through rather than refusing.
Without this, "one wrapping per entry point" is not achievable — a publish that
holds the reader across the whole operation contains a gate that wraps its own
hardware run, and someone has to remember which of the two to leave off. That
bookkeeping is the per-call-site burden the constraint exists to remove.

The pass-through requires **all three** of: same lock path, live pid, and that
pid an ancestor of ours. Anything unverifiable falls back to a real acquire.
Failing closed is what makes this an optimisation rather than a hole — a marker
left exported in a stale shell buys nothing.

**Discovered while testing it:** `radio-lock -- radio-lock -- cmd` execs the
inner over the outer, so the inner reopens fd 9, closes the outer's open file
description, and *releases the lock* before re-taking it. A momentary release
inside the operation — this document's own subject, in miniature. The first
version of the nesting test used that form and passed whether or not
pass-through existed.

## What this does not cover

**Arm B.** `just conformance-real` drives real Chromium on knuckles. `flock` is
same-kernel, so a lock held on mssb excludes nothing there, and wrapping that
recipe would read as coverage while providing none. It is also invisible to the
bridge, surfacing on the other side as a connect failure against a bridge
reporting free — which is neither `DEVICE_BUSY` nor evidence of a broken
transport.

**Same-host is an assumption, and it does not degrade gracefully.** If the two
participants stop sharing a kernel, this mechanism does not weaken — it stops
excluding anything, silently. That is the trigger to replace it, and it is worth
knowing in advance that nothing will announce it.

## The convention this replaces

The message-passing practice — announce before taking the reader, announce on
release, never act on a `held: false` poll alone — was adopted the day after the
incident and has worked. It is a convention with no red state: if either side
forgets to send the words, nothing fails, the sessions simply collide and the
reason is reconstructed afterwards. Attentiveness is precisely what is absent on
rep 400 of an overnight soak.

**Deleting it is part of adopting this, in the same window rather than after.**
Keeping both is worse than either alone: a reader cannot tell which is
authoritative, and each side assumes the other is enforcing.
