"""The transport surface the relay actually uses.

Mirrors `src/ble-transport.ts`, which TRA-1156 declared separately so that a
harness could drive the relay at rate with no radio and no reader present, and so
that this port would have an explicit contract to reproduce. Keep the shape:
TRA-1158 supplies the ESPHome implementation, and nothing above this seam should
need to change when it lands.

Two design notes that are not arbitrary.

**Data arrives through a synchronous callback, not an async generator.** The
bleak-esphome notify audit found that `aioesphomeapi` invokes its notification
callback on the event loop and swallows any exception it raises into its own
logger -- correct design on their side, since a buggy callback should not tear
down the session, but it transfers two obligations here: hand off immediately
without blocking, and surface errors deliberately rather than trusting them to
propagate. A callback makes that boundary a single reviewable line.

**Transports are built per connection, not once per process.** `rust-ble-test`'s
main.rs calls `transport.connect()` at startup and holds the device link for the
lifetime of the process, so a WebSocket client disconnecting releases nothing and
SIGTERM is the only release. That makes process lifetime a resource claim: while
the bridge merely RUNS, no other consumer on the machine can reach the device,
and an idle listening port is indistinguishable from a busy one. Constructing the
transport inside the connection handler is what removes that, so a daemon with no
clients holds no radio.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

#: Called on the transport's loop for each notification. Must not block.
DataCallback = Callable[[bytes], None]


class TransportError(RuntimeError):
    """The device link could not be established, or could not be used.

    Declared here rather than in `esphome.py` because the relay has to catch it:
    a write that fails has to be logged and reported to the client, and having
    `ws/server.py` import the ESPHome implementation to name its exception would
    invert this seam for one class.

    The message is written to be shown to a human verbatim -- notably, whether the
    PROXY was still reachable when the BLE link was not, which is the one genuinely
    diagnostic distinction the two-state model exists to draw.
    """


@dataclass(frozen=True)
class DeviceInfo:
    name: str
    id: str


@runtime_checkable
class BleTransport(Protocol):
    """What the relay needs from a device link, and nothing more."""

    def set_data_callback(self, callback: DataCallback) -> None: ...

    async def connect(self) -> DeviceInfo: ...

    async def write(self, data: bytes) -> None: ...

    async def cleanup(self) -> None: ...

    def is_connected(self) -> bool: ...


#: Builds a transport for one connection. TRA-1158 supplies the real one.
TransportFactory = Callable[..., BleTransport]


@dataclass
class StubTransport:
    """A transport with no device behind it; notifications are injected by hand.

    This is what makes TRA-1157 testable end to end with no hardware: the relay
    above it cannot tell a stub from a radio.
    """

    device: DeviceInfo = field(default_factory=lambda: DeviceInfo("StubDevice", "stub"))
    writes: list[bytes] = field(default_factory=list)
    _connected: bool = False
    _callback: DataCallback | None = None

    def set_data_callback(self, callback: DataCallback) -> None:
        self._callback = callback

    async def connect(self) -> DeviceInfo:
        self._connected = True
        return self.device

    async def write(self, data: bytes) -> None:
        self.writes.append(bytes(data))

    async def cleanup(self) -> None:
        self._connected = False

    def is_connected(self) -> bool:
        return self._connected

    def inject(self, payload: bytes) -> None:
        """Deliver a synthetic notification as if the device had sent it.

        Raises rather than returning quietly when there is nowhere to deliver it:
        a swallowed injection would be indistinguishable from a relay that
        dropped the notification, which is the one thing the firehose measures.
        """
        if not self._connected:
            raise RuntimeError("inject() before connect(): nothing is listening yet")
        if self._callback is None:
            raise RuntimeError("inject() with no data callback set: the payload would vanish")
        self._callback(payload)
