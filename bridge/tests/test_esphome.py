"""The transport's orchestration, executed with no radio, proxy or reader.

What is covered here is everything with a decision in it: the ordering the proxy
requires, the two-state discipline, what happens to an acquired resource when a
later step fails, and the refusal to write down a dead link. What is NOT covered
is the bleak-esphome wiring in `BleakEsphomeSession`, which only hardware can
validate -- see the PR, where that is stated rather than implied.
"""

from __future__ import annotations

import asyncio
import logging

import pytest

from ble_bridge.esphome import (
    EsphomeTransport,
    GattTarget,
    TransportError,
    normalise_uuid,
)
from ble_bridge.transport import BleTransport, DeviceInfo

TARGET = GattTarget(
    service=normalise_uuid("9800", "service"),
    write=normalise_uuid("9900", "write"),
    notify=normalise_uuid("9901", "notify"),
)


class FakeSession:
    """A ProxySession that records the order it was driven in."""

    def __init__(self, *, fail_at: str | None = None, exc: Exception | None = None) -> None:
        self.calls: list[str] = []
        self.writes: list[tuple[str, bytes]] = []
        self.proxy_reachable = False
        self.device_connected = False
        self._fail_at = fail_at
        self._exc = exc or RuntimeError("boom")
        self.sink = None

    def _maybe_fail(self, step: str) -> None:
        if self._fail_at == step:
            raise self._exc

    async def open_proxy(self) -> None:
        self.calls.append("open_proxy")
        self._maybe_fail("open_proxy")
        self.proxy_reachable = True

    async def await_advertisement(self, timeout: float) -> None:
        self.calls.append("await_advertisement")
        self._maybe_fail("await_advertisement")

    async def connect_device(self, timeout: float) -> DeviceInfo:
        self.calls.append("connect_device")
        self._maybe_fail("connect_device")
        self.device_connected = True
        return DeviceInfo("CS108", "6C:79:B8:11:22:33")

    async def start_notify(self, notify_uuid: str, sink) -> None:
        self.calls.append("start_notify")
        self._maybe_fail("start_notify")
        self.sink = sink

    async def write(self, write_uuid: str, data: bytes) -> None:
        self.calls.append("write")
        self._maybe_fail("write")
        self.writes.append((write_uuid, data))

    async def close(self) -> None:
        self.calls.append("close")
        self.proxy_reachable = False
        self.device_connected = False


def build(session: FakeSession) -> EsphomeTransport:
    transport = EsphomeTransport(session, TARGET, description="test")
    transport.set_data_callback(lambda _payload: None)
    return transport


# --- the contract above the seam ----------------------------------------------


def test_the_transport_satisfies_the_relay_s_protocol():
    """If this drifts, the relay above it breaks at runtime rather than here."""
    assert isinstance(build(FakeSession()), BleTransport)


async def test_connect_drives_the_proxy_in_the_order_it_requires():
    """Advertisement BEFORE connect is structural, not defensive.

    The proxy's scanner must have seen the device before an active connection by
    address completes. Reordering these produces a connect that times out for a
    reason the log does not explain.
    """
    session = FakeSession()
    device = await build(session).connect()

    assert session.calls == [
        "open_proxy",
        "await_advertisement",
        "connect_device",
        "start_notify",
    ]
    assert device.name == "CS108"


# --- the two states -----------------------------------------------------------


async def test_is_connected_reports_the_ble_link_not_the_proxy():
    """The stale-transport class, one layer down.

    A proxy is a separate computer. It stays reachable when the peripheral
    walks out of range, and `main.rs:120` reported connected on exactly that
    evidence.
    """
    session = FakeSession()
    transport = build(session)
    await transport.connect()
    assert transport.is_connected() is True

    session.device_connected = False  # peripheral gone; TCP to the proxy is fine
    assert session.proxy_reachable is True
    assert transport.is_connected() is False
    assert transport.proxy_reachable is True


async def test_a_write_is_refused_when_only_the_proxy_is_up():
    session = FakeSession()
    transport = build(session)
    await transport.connect()
    session.device_connected = False

    with pytest.raises(TransportError) as exc:
        await transport.write(b"\xa7\xb3")

    assert "BLE link" in str(exc.value)
    assert "reachable" in str(exc.value)
    assert ("write", b"\xa7\xb3") not in session.writes


async def test_a_write_reaches_the_device_on_the_write_characteristic():
    session = FakeSession()
    transport = build(session)
    await transport.connect()

    await transport.write(b"\xa7\xb3\x02")

    assert session.writes == [(TARGET.write, b"\xa7\xb3\x02")]


# --- failure releases what was already acquired -------------------------------


@pytest.mark.parametrize("fail_at", ["await_advertisement", "connect_device", "start_notify"])
async def test_a_failure_part_way_through_releases_the_proxy_session(fail_at):
    """Half-open is the worst outcome available here.

    It holds a TCP session and possibly a BLE link that nothing owns, and the
    NEXT attempt then fails for a reason unrelated to what is actually wrong.
    """
    session = FakeSession(fail_at=fail_at)
    with pytest.raises(RuntimeError):
        await build(session).connect()

    assert session.calls[-1] == "close"
    assert session.proxy_reachable is False
    assert session.device_connected is False


async def test_a_failure_to_reach_the_proxy_still_closes():
    session = FakeSession(fail_at="open_proxy")
    with pytest.raises(RuntimeError):
        await build(session).connect()
    assert "close" in session.calls


async def test_an_advertisement_timeout_is_reported_as_a_transport_error():
    session = FakeSession(
        fail_at="await_advertisement",
        exc=TimeoutError("device 6C:79:B8:11:22:33 was not heard advertising"),
    )
    with pytest.raises(TransportError) as exc:
        await build(session).connect()
    assert "not heard advertising" in str(exc.value)


# --- lifecycle ----------------------------------------------------------------


async def test_connect_without_a_data_callback_is_refused():
    """Subscribing first would discard every notification that arrived between."""
    transport = EsphomeTransport(FakeSession(), TARGET)
    with pytest.raises(TransportError) as exc:
        await transport.connect()
    assert "set_data_callback" in str(exc.value)


async def test_cleanup_is_idempotent():
    """An evicted connection can reach the relay's finally by two paths."""
    session = FakeSession()
    transport = build(session)
    await transport.connect()

    await transport.cleanup()
    await transport.cleanup()

    assert session.calls.count("close") == 1


async def test_cleanup_never_raises():
    """It is called from the relay's finally; raising would mask the real cause."""
    session = FakeSession()
    transport = build(session)
    await transport.connect()

    async def explode() -> None:
        raise RuntimeError("release failed")

    session.close = explode
    await transport.cleanup()  # must not raise


async def test_reconnecting_a_cleaned_up_transport_is_refused():
    """Per connection means per connection. Reuse would be a second claim."""
    session = FakeSession()
    transport = build(session)
    await transport.connect()
    await transport.cleanup()

    with pytest.raises(TransportError) as exc:
        await transport.connect()
    assert "cleanup" in str(exc.value)


# --- the notify boundary, wired up --------------------------------------------


async def test_notifications_reach_the_relay_callback():
    session = FakeSession()
    seen: list[bytes] = []
    transport = EsphomeTransport(session, TARGET, description="test")
    transport.set_data_callback(seen.append)
    await transport.connect()

    session.sink(b"\x02\x00\xa7")

    assert seen == [b"\x02\x00\xa7"]
    assert transport.notifications_delivered == 1
    assert transport.notifications_lost == 0


async def test_a_lost_notification_is_counted_and_restated_at_teardown(caplog):
    """The per-notification log is rate-limited, so a long session buries it."""
    session = FakeSession()
    transport = EsphomeTransport(session, TARGET, description="test")
    transport.set_data_callback(_explode)
    await transport.connect()

    session.sink(b"x")
    assert transport.notifications_lost == 1

    with caplog.at_level(logging.ERROR, logger="ble_bridge.esphome"):
        await transport.cleanup()

    assert any("LOST 1 of 1" in r.getMessage() for r in caplog.records)


def _explode(_payload: bytes) -> None:
    raise RuntimeError("relay is gone")


# --- task discipline ----------------------------------------------------------


async def test_the_transport_creates_no_background_tasks():
    """ "Every task awaited or given a done-callback", satisfied by having none.

    A task created here would be invisible in review and would outlive the
    connection that made it. The library owns the background work.
    """
    before = asyncio.all_tasks()
    session = FakeSession()
    transport = build(session)
    await transport.connect()
    await transport.write(b"x")
    await transport.cleanup()
    assert asyncio.all_tasks() - before == set()


# --- UUID normalisation is single-sourced -------------------------------------


@pytest.mark.parametrize(
    "given",
    ["9800", "00009800-0000-1000-8000-00805f9b34fb", "00009800-0000-1000-8000-00805F9B34FB"],
)
def test_every_spelling_of_one_uuid_normalises_to_the_same_string(given):
    """Two normalisers that disagree read as a device missing a characteristic."""
    assert normalise_uuid(given, "service") == "00009800-0000-1000-8000-00805f9b34fb"


def test_an_unusable_uuid_raises_rather_than_being_passed_down():
    with pytest.raises(TransportError) as exc:
        normalise_uuid("not-a-uuid", "notify")
    assert "notify" in str(exc.value)
