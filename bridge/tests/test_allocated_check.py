"""Ask the proxy who it is already connected to, before waiting 30s to guess.

Measured 2026-08-26 (TRA-1174): a second bridge asking for a MAC another bridge
holds is refused after `ADVERTISEMENT_TIMEOUT_S` — the peripheral stops
advertising while connected, so the scanner never hears it. That works, and it
is slow, and **it only works because the CS108 is single-connection.**

A multi-connect peripheral keeps advertising while connected — that is how it
accepts the second link. Against one of those the advertisement wait succeeds,
both bridges connect, and TRA-1154's no-op-code-correlation hazard goes live
with nothing catching it. This repo is device-agnostic by design, so resting the
safety property on a trait of the reference device is not good enough.

The proxy already knows. `aioesphomeapi` pushes `allocated` — the MAC addresses
it currently holds connections to — and `bleak_esphome` keeps it live on
`ESPHomeBluetoothDevice.ble_allocations`. Asking is immediate and does not
depend on the peripheral's advertising behaviour.

**The trap this file mostly exists to pin.** An empty `allocated` means either
"nothing is held" or "this firmware does not report the list" — bleak_esphome's
own comment: *"older firmware reports free/limit with no allocated at all, which
looks like an empty list."* Reading absence as "free" would be a silent fallback
of exactly the class this project keeps finding. So the check refuses only on
positive evidence and otherwise falls through to the advertisement wait, which
is the behaviour that already works.
"""

import pytest

from ble_bridge.esphome import EsphomeTransport, GattTarget
from ble_bridge.transport import DeviceInfo, TransportError

TARGET = GattTarget(service="9800", write="9900", notify="9901")
MAC = "6C:79:B8:26:03:A7"

#: The target as the proxy reports it: an int, not a string.
TARGET_INT = 0x6C79B82603A7
OTHER_INT = 0xAABBCCDDEEFF


class AllocSession:
    """A ProxySession that answers the occupancy question however the test wants."""

    def __init__(self, held_elsewhere: bool | None) -> None:
        self.calls: list[str] = []
        self.proxy_reachable = False
        self.device_connected = False
        self._held = held_elsewhere

    async def open_proxy(self) -> None:
        self.calls.append("open_proxy")
        self.proxy_reachable = True

    async def held_by_another_client(self) -> bool | None:
        self.calls.append("held_by_another_client")
        return self._held

    async def await_advertisement(self, timeout: float) -> None:
        self.calls.append("await_advertisement")

    async def connect_device(self, timeout: float) -> DeviceInfo:
        self.calls.append("connect_device")
        self.device_connected = True
        return DeviceInfo("CS108", MAC)

    async def start_notify(self, notify_uuid: str, sink) -> None:  # noqa: ANN001
        self.calls.append("start_notify")

    async def write(self, write_uuid: str, data: bytes) -> None:
        self.calls.append("write")

    async def close(self) -> None:
        self.calls.append("close")


def build(session: AllocSession) -> EsphomeTransport:
    t = EsphomeTransport(session, TARGET, description="test")
    t.set_data_callback(lambda _p: None)
    return t


async def test_a_device_the_proxy_already_holds_is_refused_at_once():
    session = AllocSession(held_elsewhere=True)
    with pytest.raises(TransportError) as caught:
        await build(session).connect()

    # The point is the WAIT that does not happen. Refusing after 30s of silence
    # is the behaviour this replaces.
    assert "await_advertisement" not in session.calls
    assert "connect_device" not in session.calls
    # And it must say which situation this is, not merely that it failed.
    assert "already" in str(caught.value)


async def test_a_free_device_proceeds_normally():
    session = AllocSession(held_elsewhere=False)
    await build(session).connect()
    assert session.calls == [
        "open_proxy",
        "held_by_another_client",
        "await_advertisement",
        "connect_device",
        "start_notify",
    ]


async def test_an_unknown_answer_falls_through_rather_than_guessing():
    """`None` means the proxy did not say -- old firmware, or nothing heard yet.

    It must NOT be read as "free". Falling through to the advertisement wait is
    the pre-existing behaviour, which is correct for a single-connection
    peripheral; short-circuiting on absent evidence would be the silent fallback
    this whole check exists to avoid.
    """
    session = AllocSession(held_elsewhere=None)
    await build(session).connect()
    assert "await_advertisement" in session.calls
    assert "connect_device" in session.calls


# --- the occupancy reading itself, where the firmware trap lives ---------------


def _reading(*, limit: int, free: int, allocated: list[int], mac: str = MAC):
    from ble_bridge.esphome import occupancy_from_allocations

    return occupancy_from_allocations(mac, limit=limit, free=free, allocated=allocated)


def test_the_target_in_the_allocated_list_is_held():
    assert _reading(limit=4, free=3, allocated=[TARGET_INT]) is True


def test_someone_else_in_the_list_leaves_the_target_free():
    assert _reading(limit=4, free=3, allocated=[OTHER_INT]) is False


def test_nothing_heard_from_the_proxy_yet_is_unknown_not_free():
    """limit == 0 means no slot report has arrived. Absence of evidence."""
    assert _reading(limit=0, free=0, allocated=[]) is None


def test_firmware_that_reports_no_list_is_unknown_not_free():
    """The trap. used=1 with an empty list means the list is not being reported.

    bleak_esphome: "older firmware reports free/limit with no allocated at all,
    which looks like an empty list". Reading that as "free" would let a second
    writer onto a held device on exactly the firmware that cannot warn you.
    """
    assert _reading(limit=4, free=3, allocated=[]) is None


def test_an_inconsistent_list_is_unknown_not_free():
    """Slot accounting disagreeing with the list is not something to reason from."""
    assert _reading(limit=4, free=2, allocated=[OTHER_INT]) is None


def test_a_consistent_empty_list_really_is_free():
    """used == 0 AND an empty list agree with each other, so this one is trustworthy."""
    assert _reading(limit=4, free=4, allocated=[]) is False
