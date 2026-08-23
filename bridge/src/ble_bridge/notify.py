"""The one place a device notification crosses into the bridge.

This module exists because the boundary has two obligations that are invisible
when the code is scattered across a transport, and both of them come from the
`bleak-esphome` notify audit rather than from taste.

**It runs synchronously on the event loop.** `aioesphomeapi` dispatches directly
from `APIConnection.data_received` with no queue in between, so whatever happens
here happens between two socket reads. Anything slow stalls the connection --
not just this notification, the whole session, including the pings that keep the
proxy from tearing the link down. So the only thing permitted here is a handoff.

**Exceptions raised here do not propagate.** `aioesphomeapi` wraps every handler
call in try/except and routes it to its own `_LOGGER.exception`, deliberately, so
that a buggy consumer cannot kill a session it does not own. That is right for
them and expensive for us: an exception raised here would be logged under
*their* logger name, with no indication it came from the bridge, and the bridge
itself would carry on believing it was relaying data. Notifications would stop
arriving at the client and nothing on our side would say so.

So this catches its own exceptions and reports them under our name, with a count.
Letting them reach `aioesphomeapi` is not an alternative -- it is the failure
mode, wearing the costume of an unhandled error being handled somewhere.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

logger = logging.getLogger(__name__)

#: Called with each notification's payload. Must not block and must not await.
DeliverCallback = Callable[[bytes], None]

#: After the first, report one in every N failures. A device that has started
#: failing on every notification at 45 msg/s would otherwise produce 45 identical
#: tracebacks a second, which buries the first one -- the only useful one.
FAILURE_LOG_INTERVAL = 100


class NotifySink:
    """Hands a notification off, and makes its own failures visible.

    Deliberately not a coroutine. Making it `async` would require the caller to
    schedule it, which is exactly the unawaited-task shape the ticket rules out,
    and would put a scheduling hop between the device and the relay for no gain.
    """

    __slots__ = ("_deliver", "_description", "delivered", "failed")

    def __init__(self, deliver: DeliverCallback, *, description: str = "notify") -> None:
        self._deliver = deliver
        self._description = description
        #: Notifications handed off without raising.
        self.delivered = 0
        #: Notifications whose handoff raised. Non-zero means data was LOST.
        self.failed = 0

    def __call__(self, payload: bytes) -> None:
        try:
            self._deliver(payload)
        except Exception:
            self.failed += 1
            if self.failed == 1 or self.failed % FAILURE_LOG_INTERVAL == 0:
                logger.exception(
                    "%s: handing a %d-byte notification to the relay raised. This "
                    "notification was LOST. %d of %d have now failed. aioesphomeapi "
                    "would have logged this under its own name and the bridge would "
                    "have carried on reporting a healthy session.",
                    self._description,
                    len(payload),
                    self.failed,
                    self.delivered + self.failed,
                )
        else:
            self.delivered += 1

    @property
    def healthy(self) -> bool:
        """False once any notification has been lost at this boundary."""
        return self.failed == 0

    def __repr__(self) -> str:
        return f"<NotifySink {self._description} delivered={self.delivered} failed={self.failed}>"
