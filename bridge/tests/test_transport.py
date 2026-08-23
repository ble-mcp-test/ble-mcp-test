import pytest

from ble_bridge.transport import BleTransport, DeviceInfo, StubTransport


async def test_stub_connects_and_reports_a_device():
    t = StubTransport()
    assert t.is_connected() is False
    info = await t.connect()
    assert info == DeviceInfo(name="StubDevice", id="stub")
    assert t.is_connected() is True


async def test_stub_records_writes():
    t = StubTransport()
    await t.connect()
    await t.write(b"\x01\x02")
    assert t.writes == [b"\x01\x02"]


async def test_injected_data_reaches_the_callback():
    t = StubTransport()
    seen: list[bytes] = []
    t.set_data_callback(seen.append)
    await t.connect()
    t.inject(b"\xa7\xa7")
    assert seen == [b"\xa7\xa7"]


async def test_injection_before_connect_is_refused():
    """Silence would look like a relay that dropped the notification."""
    t = StubTransport()
    with pytest.raises(RuntimeError):
        t.inject(b"\x00")


async def test_injection_without_a_callback_is_refused():
    """Otherwise a harness misconfiguration reports as zero loss."""
    t = StubTransport()
    await t.connect()
    with pytest.raises(RuntimeError):
        t.inject(b"\x00")


async def test_cleanup_disconnects():
    t = StubTransport()
    await t.connect()
    await t.cleanup()
    assert t.is_connected() is False


def test_stub_satisfies_the_transport_protocol():
    """TRA-1158's ESPHome transport must satisfy the same Protocol."""
    assert isinstance(StubTransport(), BleTransport)
