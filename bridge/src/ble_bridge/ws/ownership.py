"""One writer owns the command path; everyone else reads.

The model, and why each half of it exists.

**One writer.** `CommandManager` settles a pending command with whatever
command-class packet arrives, with no op-code correlation (TRA-1154). Put a second
writer on the same physical reader and client A's response settles client B's
pending command -- a wrong answer, delivered promptly, wearing the shape of a right
one. That compounds rather than adds: neither client is slow and neither sees an
error.

**Read-only observers.** A pure single-client lock would block a legitimate use --
platform attaches the mock to watch the transport stream while debugging unexpected
reader behaviour. Unrestricted multi-client permits the dangerous one. Read-only
attachment is the shape that allows the first without the second, and it has to be
read-only *by construction* rather than by convention, because the dangerous path is
the debugging path: a second tab on localhost:5173 during a soak arrives with the
mock injected, the same pinned session id, and full write access.

**Per connection, not per session.** This is the requirement most likely to be got
wrong. The TypeScript guard at session-manager.ts:51-56 rejects a *different session*
holding the transport, but ble-session.ts:18 keeps a Set of WebSockets per session,
all sharing one transport with write access, and both repos pin one session id per
host. So shared-writer was the configured norm and the guard fired only in the case
that did not happen. A claim here is refused even when the session ids are identical.

The slot is taken synchronously, before any await. Two writers arriving in the same
tick must not both get past the guard while the first one's connect() is in flight.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

from ble_bridge.transport import DeviceInfo
from ble_bridge.ws import protocol as p


class EndOfStream:
    """Queue sentinel: this subscription is over. A distinct type so it can never
    collide with a payload, and so a stream that ends is distinguishable from one
    that has merely gone quiet."""


END_OF_STREAM = EndOfStream()


class OwnershipError(Exception):
    """A claim on the command path was refused.

    The message is client-facing and is sent verbatim in an `error` frame, so the
    text lives in protocol.py alongside every other wire string. `code` is what
    the client actually discriminates on -- the text is free to be reworded.
    """

    code: str = p.ERR_DEVICE_BUSY


class CommandPathBusy(OwnershipError):
    """Another connection owns the command path."""

    def __init__(self, holder: str) -> None:
        super().__init__(f"{p.BUSY_ERROR_PREFIX} (session {holder!r}). {p.BUSY_ERROR_ADVICE}")
        self.holder = holder

    code = p.ERR_DEVICE_BUSY


class CommandPathBusySelf(CommandPathBusy):
    """Our own previous connection owns the path and is already releasing it.

    A subclass of CommandPathBusy rather than a sibling, because it IS the busy
    refusal -- it differs only in being survivable. Anything catching
    CommandPathBusy keeps catching this, which is the safe direction for a new
    exception: an unhandled refusal is worse than an over-broad one.

    Retryable, and it is the only busy case that is. See BUSY_SELF_ERROR_PREFIX for
    why the discriminator is `Claim.closing` and not the session id.
    """

    code = p.ERR_DEVICE_BUSY_SELF

    def __init__(self, holder: str) -> None:
        # Deliberately not super().__init__() -- CommandPathBusy's message names a
        # different situation and offers force=true, which is the wrong advice here.
        OwnershipError.__init__(
            self, f"{p.BUSY_SELF_ERROR_PREFIX} (session {holder!r}). {p.BUSY_SELF_ERROR_ADVICE}"
        )
        self.holder = holder


class CommandPathNotReady(OwnershipError):
    """The path is claimed but its device link is not up yet. Worth retrying."""

    code = p.ERR_NOT_READY

    def __init__(self) -> None:
        super().__init__(p.NOT_READY_ERROR)


class NothingToObserve(OwnershipError):
    """No connection owns the command path, so there is no stream to attach to."""

    code = p.ERR_NOTHING_TO_OBSERVE

    def __init__(self) -> None:
        super().__init__(p.NOTHING_TO_OBSERVE_ERROR)


@dataclass
class Subscription:
    """One consumer of the notification stream, owner or observer alike."""

    session: str
    device: DeviceInfo | None = None
    queue: asyncio.Queue[bytes | EndOfStream] = field(default_factory=asyncio.Queue)

    def end(self) -> None:
        self.queue.put_nowait(END_OF_STREAM)


@dataclass
class Claim:
    """One connection's hold on the command path, plus the observers attached to it.

    `evicted` names the claim this one displaced, and is None in the ordinary case.
    The new owner is responsible for tearing the displaced one down -- doing it
    inside claim() would mean awaiting a socket close while holding the slot.
    """

    session: str
    path: CommandPath
    #: The `_mv` this connection arrived with, or None if it sent none. Carried
    #: on the claim rather than looked up later because it is a property of the
    #: connection that took the slot, and by the time anyone asks, the
    #: connection's parameters are gone. TRA-1211: this is what
    #: get_connection_state reports, and it is the WRITER's version -- an
    #: observer's stale mock must not be attributed to the writer driving the
    #: device.
    mock_version: str | None = None
    evicted: Claim | None = None
    #: Set on the DISPLACED claim, naming who displaced it, so its own handler can
    #: tell the client why its stream ended rather than just dropping the socket.
    evicted_by: str | None = None
    #: Set by this claim's own handler once its transport is cleaned up -- never by
    #: release(), which runs first and would make the flag lie. A displacing
    #: connection waits on this before building its transport, so two transports
    #: never hold the one radio at the same time.
    torn_down: asyncio.Event = field(default_factory=asyncio.Event)
    #: TRA-1216. This claim is on its way out: its socket is gone and its handler is
    #: inside teardown. Set by the WS handler at the top of `_relay`'s `finally`,
    #: BEFORE `transport.cleanup()` -- because cleanup IS the 12-21ms window, and a
    #: flag set after it would be true only once there was nothing left to wait for.
    #:
    #: ⚠ It cannot be set here. `ownership.py` has no way to see a socket close, and
    #: that split is the hazard this flag lives in the middle of: every unit test of
    #: `claim()` can pass while the handler never sets it, in which case
    #: DEVICE_BUSY_SELF is a code the bridge can never emit and the client retries on
    #: a condition nothing satisfies. `torn_down` above answers a different question
    #: -- "is the radio free yet" -- and is set on the far side of the same window.
    closing: bool = False
    own_subscription: Subscription = field(init=False)
    device: DeviceInfo | None = None
    #: Wall clock, for "since when" in a human-readable answer. Paired with a
    #: monotonic reading rather than used alone: wall clock can jump, and
    #: "held for -4 seconds" after an NTP step is worse than no number.
    acquired_at: float = field(default_factory=time.time)
    _acquired_monotonic: float = field(default_factory=time.monotonic)
    _observers: list[Subscription] = field(default_factory=list)
    _live: bool = True

    def __post_init__(self) -> None:
        self.own_subscription = Subscription(session=self.session)

    @property
    def is_ready(self) -> bool:
        return self.device is not None

    @property
    def held_seconds(self) -> float:
        """How long this claim has held the path.

        Derived from the monotonic clock, so a wall-clock step cannot make it
        negative. This is the number that answers the question a blocked person
        actually asks -- "has someone had this for four seconds or forty
        minutes" -- which a session id alone does not.
        """
        return round(time.monotonic() - self._acquired_monotonic, 3)

    @property
    def observer_count(self) -> int:
        """How many read-only connections are attached to this claim.

        Reported by MCP's get_connection_state: "one writer" and "one writer with
        three watchers" are different situations to be debugging, and the second
        one is where a stray browser tab shows up.
        """
        return len(self._observers)

    def ready(self, device: DeviceInfo) -> Claim:
        """Mark the device link up. Returns self so a test can claim-ready in one line."""
        self.device = device
        self.own_subscription.device = device
        return self

    def attach(self, session: str) -> Subscription:
        subscription = Subscription(session=session, device=self.device)
        self._observers.append(subscription)
        return subscription

    def fan_out(self, payload: bytes) -> None:
        """Deliver one notification to every subscriber.

        Synchronous and non-blocking by contract: this runs on the transport's
        callback, where anything slow stalls the notification source -- and in the
        ESPHome case the source swallows exceptions into its own logger, so a
        failure here would not even be visible.

        A released claim delivers to nobody. A stale transport pushing into a live
        subscriber's stream is the bug class where events from a dead link are
        processed as current.
        """
        if not self._live:
            return
        self.own_subscription.queue.put_nowait(payload)
        for observer in self._observers:
            observer.queue.put_nowait(payload)

    def release(self) -> list[Subscription]:
        """Free the slot and end every stream this claim was feeding.

        Returns the observers ended, so the caller can close their sockets.

        The slot is freed only if this claim still holds it. That guard is the
        point: an evicted owner's `finally` runs *after* the new owner has claimed,
        and clearing the slot there would silently un-own a live connection, letting
        the next writer in alongside it. Nothing would be slow -- there would just
        be two writers on one reader, which is the whole hazard.

        Idempotent, for the same reason.
        """
        if not self._live:
            return []
        self._live = False
        if self.path.holder is self:
            self.path.detach(self)
        self.own_subscription.end()
        ended = list(self._observers)
        self._observers.clear()
        for observer in ended:
            observer.end()
        return ended


class CommandPath:
    """The single-writer slot for this bridge process.

    One slot, not a registry keyed on device or session. A keyed registry would
    reproduce the hazard in a new costume: a second key means a second writer on the
    one physical reader this process fronts.
    """

    def __init__(self) -> None:
        self._held: Claim | None = None

    @property
    def is_held(self) -> bool:
        return self._held is not None

    @property
    def holder(self) -> Claim | None:
        return self._held

    def claim(self, session: str, *, force: bool, mock_version: str | None = None) -> Claim:
        """Take the command path, or raise saying who has it.

        Synchronous on purpose: the slot is occupied from this instant, before the
        caller awaits connect(), so a second writer in the same tick is refused
        rather than admitted alongside the first.
        """
        current = self._held
        if current is None:
            self._held = Claim(session=session, path=self, mock_version=mock_version)
            return self._held

        if not force:
            # TRA-1216. `closing` is what carries the meaning: waiting only helps
            # when the holder is already on its way out, and then it helps a lot --
            # 63 measured refusals, every holder released within 21ms. The session
            # match merely adds "and it was mine".
            #
            # Both conditions, in this order, and neither is redundant:
            #
            # - Drop `closing` and a LIVE holder wearing our own name becomes
            #   retryable. Both repos derive the session id from the hostname
            #   deliberately, for pool reuse, so two live platform processes on one
            #   host are indistinguishable by name -- the second would be handed a
            #   ~2.4s retry against a genuinely foreign holder, which is the precise
            #   case DEVICE_BUSY exists to refuse loudly.
            # - Drop the non-empty `session` test and two ANONYMOUS clients match
            #   each other, because params.py fills an absent session with a fresh
            #   uuid4 and "" == "". An empty name is the absence of identity; a
            #   client that does not pin one has no claim to be its own predecessor.
            if session and current.session == session and current.closing:
                raise CommandPathBusySelf(current.session)
            raise CommandPathBusy(current.session)

        if not current.is_ready:
            # A forced takeover of a half-built device link would leave the
            # survivor holding a transport in an unknown state. "Retry, this
            # resolves in a moment" is true and distinguishable, which is more than
            # the alternative offers.
            raise CommandPathNotReady

        current.evicted_by = session
        self._held = Claim(session=session, path=self, mock_version=mock_version, evicted=current)
        return self._held

    def observe(self, session: str = "") -> Subscription:
        """Attach read-only to the current owner's notification stream."""
        current = self._held
        if current is None:
            raise NothingToObserve
        if not current.is_ready:
            raise CommandPathNotReady
        return current.attach(session)

    def detach(self, claim: Claim) -> None:
        """Empty the slot. Called by Claim.release(), which owns the guard."""
        if self._held is claim:
            self._held = None
