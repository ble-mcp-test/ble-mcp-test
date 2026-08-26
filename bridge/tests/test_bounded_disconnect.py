"""A BLE disconnect that hangs must not hold the release open behind it.

Measured on hardware 2026-08-26 (TRA-1174). When a second ESPHome client touches
the proxy, `bluetooth_device_disconnect` gets no answer and aioesphomeapi gives
up after its own 20s response timeout:

    13:40:29.909  disconnect request sent   (exactly 45.010s -- idle timer correct)
    13:40:49.914  BLE device disconnected   (exactly 20.005s later)
    13:40:49.915  ERROR: disconnecting the BLE link raised

Those 20 seconds are spent politely asking. The API-level close that follows --
which is what actually tears the session down -- took 4ms.

**The cost lands on exactly the wrong person.** The relay tells the client the
path is free only after `cleanup()` returns, so a successor waits the extra 20s;
and the contention that causes the stall is *someone waiting for the device*.
The release is slowest precisely when someone needs it.

Bounding the polite disconnect does not make the proxy answer. It stops the
teardown queueing behind an answer that is not coming, so the API close --
observed at 4ms -- happens promptly instead of 20s late.

**What this cannot establish without hardware:** whether closing the API session
actually releases the link at the proxy. That is a claim about the far end and
is verified by a successor connecting, not by these tests.
"""

import asyncio

import pytest

from ble_bridge.esphome import BLE_DISCONNECT_TIMEOUT_S, EsphomeTransport, GattTarget

TARGET = GattTarget(service="9800", write="9900", notify="9901")


class HangingBle:
    """A BLE client whose disconnect never returns, like a contended proxy."""

    def __init__(self) -> None:
        self.disconnect_started = False

    @property
    def is_connected(self) -> bool:
        return True

    async def disconnect(self) -> None:
        self.disconnect_started = True
        await asyncio.sleep(3600)


class HangingSession:
    """Real `close()` ordering, with a BLE disconnect that never completes."""

    def __init__(self) -> None:
        self.api_closed = False
        self.ble = HangingBle()
        self.proxy_reachable = True
        self.device_connected = True

    async def close(self) -> None:
        from ble_bridge.esphome import disconnect_ble_bounded

        await disconnect_ble_bounded(self.ble)
        # The step that actually tears the session down. It must be reached.
        self.api_closed = True


async def test_a_hanging_ble_disconnect_does_not_block_the_api_close():
    session = HangingSession()
    await asyncio.wait_for(session.close(), timeout=BLE_DISCONNECT_TIMEOUT_S + 5)

    assert session.ble.disconnect_started, "the polite disconnect must still be attempted first"
    assert session.api_closed, "teardown must continue past a disconnect that never answers"


async def test_the_bound_is_well_under_the_api_response_timeout():
    """Otherwise it would never fire before aioesphomeapi's own 20s does.

    A bound at or above that is decorative: the thing it is meant to pre-empt
    always wins.
    """
    from ble_bridge.esphome import CONNECT_TIMEOUT_S

    assert BLE_DISCONNECT_TIMEOUT_S < CONNECT_TIMEOUT_S


async def test_a_disconnect_that_answers_promptly_is_not_cut_short():
    """The bound must not truncate the normal path, which takes milliseconds."""

    class QuickBle:
        def __init__(self) -> None:
            self.done = False

        @property
        def is_connected(self) -> bool:
            return True

        async def disconnect(self) -> None:
            await asyncio.sleep(0)
            self.done = True

    from ble_bridge.esphome import disconnect_ble_bounded

    ble = QuickBle()
    await disconnect_ble_bounded(ble)
    assert ble.done


async def test_a_disconnect_that_raises_is_swallowed_not_propagated():
    """`close()` runs in a finally. Raising here would mask what ended the session."""

    class AngryBle:
        @property
        def is_connected(self) -> bool:
            return True

        async def disconnect(self) -> None:
            raise RuntimeError("proxy said no")

    from ble_bridge.esphome import disconnect_ble_bounded

    await disconnect_ble_bounded(AngryBle())  # must not raise


def test_the_transport_still_satisfies_the_relay_protocol():
    from ble_bridge.transport import BleTransport

    t = EsphomeTransport(HangingSession(), TARGET, description="test")
    t.set_data_callback(lambda _p: None)
    assert isinstance(t, BleTransport)


@pytest.mark.parametrize("bound", [BLE_DISCONNECT_TIMEOUT_S])
def test_the_bound_is_long_enough_for_a_healthy_round_trip(bound: float):
    """4ms observed for the API close on hardware; 3s leaves three orders of margin.

    Too tight and a merely slow proxy gets cut off mid-disconnect, which would
    trade a 20s stall for a half-released link -- strictly worse.
    """
    assert bound >= 1.0
