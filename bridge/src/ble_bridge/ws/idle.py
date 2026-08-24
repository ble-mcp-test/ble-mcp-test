"""When a writer has gone away without saying so.

A client that connects, takes the command path and then walks away holds the
device until its socket drops -- which, on a wedged browser or a suspended laptop,
is never. `BLE_MCP_IDLE_TIMEOUT=600` had been in `.env.local` throughout and was
read by nothing.

## The measurement rule, which is the whole difficulty

**Only INBOUND traffic renews the lease.** A well-formed `data` frame from the
client stamps this clock; nothing else does. In particular a notification
travelling device -> client does not.

That asymmetry is not fastidiousness. The reader emits unprompted traffic all by
itself: timed battery state, heartbeat notifications, and during inventory a
continuous tag stream. Count outbound as activity and an abandoned session renews
its own lease forever -- the device is never released, the timeout looks
configured and working, and nothing is even slow. It is the same shape as the four
inert variables this ticket restores, one layer further in.

The TypeScript implementation got this right and is the reference for the rule
only: all four `recordActivity()` sites in `ble-session.ts` are inbound or
lifecycle, and none is a notification.

The cost of the rule is the reason the floor is ten minutes rather than one. A
long LOCATE hold streams outbound for minutes while sending nothing in, and under
an inbound-only clock that is indistinguishable from an abandoned session. Too
short a timeout turns this into a timer firing during real work, presenting as a
device that drops mid-test for no reason. Pick the floor against the longest
legitimate silence, not against the soak's 29-second runs.

## Shape

Deadline-based, not polled. `wait_for_expiry` sleeps exactly as long as the
current deadline allows and only re-enters the loop when a stamp moved it, so a
stamped timer costs one wakeup per stamp rather than one per tick.
"""

from __future__ import annotations

import asyncio


class IdleTimer:
    """Fires when `timeout` seconds pass with no `stamp()`."""

    def __init__(self, timeout: float) -> None:
        if timeout <= 0:
            raise ValueError(
                f"idle timeout {timeout} is not positive. A disabled timeout is the "
                "absence of a timer, decided by the caller -- never a timer set to "
                "fire immediately."
            )
        self._timeout = timeout
        self._loop = asyncio.get_event_loop()
        self._deadline = self._loop.time() + timeout

    @property
    def timeout(self) -> float:
        return self._timeout

    def stamp(self) -> None:
        """Renew the lease. Called from exactly one place; see ws/server.py."""
        self._deadline = self._loop.time() + self._timeout

    async def wait_for_expiry(self) -> bool:
        """Sleep until the deadline has actually passed. Always returns True.

        The return value exists so the caller can tell expiry apart from
        cancellation, which is the difference between "released for idleness" and
        "the socket closed first" -- and those get different messages.
        """
        while True:
            remaining = self._deadline - self._loop.time()
            if remaining <= 0:
                return True
            await asyncio.sleep(remaining)
