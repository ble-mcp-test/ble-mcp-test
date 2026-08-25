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
    text lives in protocol.py alongside every other wire string.
    """


class CommandPathBusy(OwnershipError):
    """Another connection owns the command path."""

    def __init__(self, holder: str) -> None:
        super().__init__(f"{p.BUSY_ERROR_PREFIX} (session {holder!r}). {p.BUSY_ERROR_ADVICE}")
        self.holder = holder


class CommandPathNotReady(OwnershipError):
    """The path is claimed but its device link is not up yet. Worth retrying."""

    def __init__(self) -> None:
        super().__init__(p.NOT_READY_ERROR)


class NothingToObserve(OwnershipError):
    """No connection owns the command path, so there is no stream to attach to."""

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
    evicted: Claim | None = None
    #: Set on the DISPLACED claim, naming who displaced it, so its own handler can
    #: tell the client why its stream ended rather than just dropping the socket.
    evicted_by: str | None = None
    #: Set by this claim's own handler once its transport is cleaned up -- never by
    #: release(), which runs first and would make the flag lie. A displacing
    #: connection waits on this before building its transport, so two transports
    #: never hold the one radio at the same time.
    torn_down: asyncio.Event = field(default_factory=asyncio.Event)
    own_subscription: Subscription = field(init=False)
    device: DeviceInfo | None = None
    _observers: list[Subscription] = field(default_factory=list)
    _live: bool = True

    def __post_init__(self) -> None:
        self.own_subscription = Subscription(session=self.session)

    @property
    def is_ready(self) -> bool:
        return self.device is not None

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

    def claim(self, session: str, *, force: bool) -> Claim:
        """Take the command path, or raise saying who has it.

        Synchronous on purpose: the slot is occupied from this instant, before the
        caller awaits connect(), so a second writer in the same tick is refused
        rather than admitted alongside the first.
        """
        current = self._held
        if current is None:
            self._held = Claim(session=session, path=self)
            return self._held

        if not force:
            raise CommandPathBusy(current.session)

        if not current.is_ready:
            # A forced takeover of a half-built device link would leave the
            # survivor holding a transport in an unknown state. "Retry, this
            # resolves in a moment" is true and distinguishable, which is more than
            # the alternative offers.
            raise CommandPathNotReady

        current.evicted_by = session
        self._held = Claim(session=session, path=self, evicted=current)
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
