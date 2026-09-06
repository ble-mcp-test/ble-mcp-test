# Defects that conceal each other

**Status:** proposed
**Tracking:** TRA-1255
**Date:** 2026-09-06

Two bugs, each of which would be caught on its own, arranged so that the first
supplies the condition under which the second is harmless. Nothing is slow,
nothing is red, and the test suite documents one of them as intended behaviour.

Sibling of [tests that assert a coincidence](2026-08-29-tests-that-assert-a-coincidence.md):
there a check passed about the wrong subject; here every check passed about the
right subject, and the subject was two-thirds of a defect.

## The instance

The mock had both of these, from different years:

- **`requestDevice()` minted a fresh `BluetoothDevice` per call.** Real Chromium
  returns the same object — the spec keys a per-realm map on the device
  (`index.bs:2285`).
- **A disconnect never emptied the attribute cache.** The spec empties it
  (`index.bs:4417`, step 5), so a reconnect discovers new services and
  characteristics.

Alone, the second is severe: a consumer reconnects, re-runs its connect chain,
and receives the *previous* connection's characteristic objects, still carrying
that connection's subscription state and its listeners. Its freshly attached
listener sits on an object the transport no longer feeds; the old object keeps
receiving into handlers the consumer believes it replaced. Nothing raises,
because a stale characteristic is indistinguishable from a live one right up
until frames do not arrive.

It was not severe, because the first defect meant a reconnect that went through
`requestDevice()` got a new device, and therefore new attributes. The bug was
real, reachable only through `disconnect()`/`connect()` on a held device, and
never reached that way in practice.

## What that did to the tree

**The compensating defect got written down as the design.** The contract
document said *"a **fresh device per call** — that is what keeps a reconnect
from colliding with the previous session's objects"*, which is an accurate
description of a mechanism nobody would choose. `requestDevice` was doing the
job an invalidation step should have been doing, and the document explained why
that was correct.

**A unit test pinned the missing invalidation as intended.**

```ts
// Same characteristic instance comes back out of the cache, which is exactly
// why the old lazy wiring never re-ran.
expect(second.characteristic).toBe(first.characteristic);
```

**And the conformance suite called the same fact a hazard,** four files away, in
a comment on the check that asserted the other half. Both statements were in the
tree at once and neither could see the other.

## The tell, and why it is not "look harder"

There was no missing check, no un-run arm, and no gap in review — the ticket for
this arrived from arm B, the one thing capable of comparing the mock against the
API it doubles, and even arm B saw only the visible half.

The tell available *before* that is the shape of the justification. A comment
explaining why one mechanism is load-bearing for a guarantee that is not its job
is describing a compensation. `requestDevice` has no reason to care about
characteristic lifetimes; that it did, and that the document said so approvingly,
was the whole disclosure.

> **When something is doing a job that belongs to something else, ask what
> happens to the guarantee if you fix it.**

## The consequence for how they get fixed

> **This is not two independent bugs. It is one hazard with two locks on it, and
> removing one lock is the dangerous operation.**

That framing is `platform`'s, offered while checking their own exposure to this
change, and it is sharper than the one this document was first written with. It
also gives the operational instruction the shape needs: the question is never
"which of these should I fix" but "what does the other one become once this is
gone".

**Fixing one alone makes things worse than fixing neither.** Landing the device
identity without the cache invalidation would have promoted a hazard nobody hit
into the ordinary path of every reconnect — silently, with a green suite and a
conformance arm reporting one more clause satisfied than before.

So a defect of this shape is not a defect that can be scoped down. The ticket
asked for the identity fix; it needed three changes, and shipping the one that
was asked for would have been the worst available outcome.

Two other things follow, both worth doing before the fix rather than after:

- **Check the consumer against the *combination*.** platform survives this
  because it nulls every reference in one teardown owner and re-derives on every
  connect. That is a property of their code, not an inference from ours, and it
  was read rather than assumed.

  **And the reason it is true is a fix of theirs, not a habit of theirs.** The
  exposed surface was never the transport — it was their e2e hooks, which reach
  a characteristic through `window.__TRANSPORT_MANAGER__` across a reconnect.
  They resolve it at the moment of use and fail loudly when it is absent because
  of **TRA-1179**, where two teardown paths cleared different amounts and left
  those hooks injecting into an orphaned characteristic on real hardware. They
  had already paid for the *stale-object* form of this bug; that payment is what
  makes the *stale-cache* fix a non-event on their side.

  Neither repo records the dependency, and neither could see it from its own
  tree: a consumer's history can be load-bearing for a change here, and the only
  way to find that out is to read their code and ask them what it is for.
- **Expect a test to have to change, and read it as evidence.** The unit test
  that went red here was not stale and not wrong about its own subject. It was
  correctly asserting the compensating behaviour. A test that must be inverted to
  land a fix is the second defect announcing itself.
