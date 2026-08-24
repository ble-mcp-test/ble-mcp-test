"""When a writer has gone away without saying so.

A client that connects, takes the command path and then walks away holds the
device until its socket drops -- which, on a wedged browser or a suspended laptop,
is never. `BLE_MCP_IDLE_TIMEOUT=600` had been in `.env.local` throughout and was
read by nothing.

## The measurement rule, which is the whole difficulty

**Only INBOUND traffic renews the lease.** A well-formed `data` frame from the
client stamps this clock; nothing else does. In particular a notification
travelling device -> client does not.

Put plainly: you do not get to keep the connection because your reader is
reporting battery voltage every five seconds.

The lease belongs to the client and is earned by the client doing something. A
device talking to itself is not evidence that anyone is still there -- and the
reference reader talks to itself on three separate timers, none of which needs a
client. From *CS108 and CS463 Bluetooth and USB Byte Stream API Specifications*:

  0xA002           "Start battery 5 seconds auto reporting (for BT connection
                   only)". Five seconds, fixed -- the interval is part of the
                   command, not a parameter.
  0xA008           "Start trigger state auto reporting (for BT connection only),
                   1 byte value = interval in second". One second, if asked.
  en_commandactive Bit 9 of the packet-enable register: "Enable periodic output of
                   Command Active packet for long running commands, IN THE ABSENCE
                   OF ANY OTHER HOST INTERFACE OUTPUT". The spec's own note: during
                   inventory with no tag in front of the reader, it "will still
                   send out, every 3 seconds, a Command Active packet, so that the
                   user will know the reader is still in inventory mode".

That last one deserves its name read twice. It is a keepalive whose entire purpose
is to emit when nothing else is happening -- so under an outbound-counting clock it
would not merely renew the lease, it would renew it *hardest* in exactly the
condition an idle timeout exists to detect. The timeout would be defeated by
design rather than by accident.

So on this hardware, counting outbound does not weaken the timeout, it deletes it.
A five-second report against a ten-minute lease renews it a hundred and twenty
times over before the timer could ever fire. The abandoned session becomes
immortal, the device is never released, and the timeout looks configured and
working the entire time. Nothing is slow and nothing reports an error -- the same
shape as the four inert variables this module was written alongside, one layer
further in.

It is also why the rule cannot be softened to "outbound counts, but only
sometimes". Any device-driven renewal is a renewal the client never asked for.

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
