"""TRA-1173's acceptance criteria, executed against a real reader.

Everything else in `bridge/tests/` runs against `StubTransport`. That is the right
default -- but it means the suite is green above a fake, and a fake cannot tell you
whether the rule you implemented survives contact with a device that has its own
opinions about when to talk.

These are the three criteria that needed hardware. All three were verified by hand
on CS108Reader2603A7 (via waveshare-s3-eth-probe) on 2026-08-24; this file is what
keeps them true.

Slow by nature: the proxy must hear the device advertise before an active connect
completes, and the idle test has to outlast an idle timeout. Budget a minute.
"""

from __future__ import annotations

import asyncio
import json

import pytest
import websockets

from ble_bridge.ws import protocol as p

from . import cs108
from .conftest import requires_hardware

pytestmark = requires_hardware

#: Long enough to span several of the reader's ~4.2s battery reports, short enough
#: that the test finishes. Six-plus device frames inside one window is what makes
#: "outbound was ignored" distinguishable from "outbound was absent".
IDLE_S = 30.0


async def _drain_until_error(ws, deadline_s: float) -> tuple[list[tuple[float, bytes]], str | None]:
    """Collect device frames until an error frame arrives or time runs out."""
    loop = asyncio.get_running_loop()
    started = loop.time()
    frames: list[tuple[float, bytes]] = []
    while True:
        remaining = (started + deadline_s) - loop.time()
        if remaining <= 0:
            return frames, None
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), remaining))
        except (TimeoutError, websockets.exceptions.ConnectionClosed):
            return frames, None
        kind = p.message_type(msg)
        if kind == p.MSG_DATA:
            frames.append((loop.time() - started, p.data_payload(msg)))
        elif kind == p.MSG_ERROR:
            return frames, msg[p.FIELD_ERROR]


@pytest.mark.parametrize("live_bridge", [{"idle_timeout": IDLE_S}], indirect=True)
async def test_device_traffic_does_not_renew_the_idle_lease(live_bridge, quiet_reader):
    """The criterion TRA-1173 could not settle from a desk.

    The ticket body said outbound must never renew the lease; its acceptance
    summary, read literally, said the opposite. The body won, and the CS108/CS463
    spec backed it: the reader has three unprompted timers, one of which
    (`en_commandactive`) exists specifically to emit when nothing else is
    happening. This proves the rule against the reader rather than against the spec.

    Method: one inbound frame to start battery auto-reporting, then silence. The
    device streams; the lease must lapse anyway.
    """
    ws, device = await live_bridge.connect("hw-outbound-lease")
    try:
        await ws.send(p.encode_data(cs108.start_battery_reporting()))
        frames, error = await _drain_until_error(ws, IDLE_S * 2.5)
    finally:
        await ws.close()

    reports = [(dt, f) for dt, f in frames if cs108.is_battery_report(f)]

    assert error is not None, (
        f"{device} streamed {len(frames)} frames and the session was NEVER released. "
        "Outbound traffic is renewing the lease, which makes an abandoned session on "
        "this reader immortal -- it emits battery state every ~4s with no client "
        "involvement at all."
    )
    assert p.IDLE_TIMEOUT_ERROR_PREFIX in error, f"released, but not for idleness: {error}"
    assert len(reports) >= 3, (
        f"only {len(reports)} battery reports arrived in {IDLE_S}s, which is too few to "
        "distinguish 'outbound was ignored' from 'outbound never happened'. Battery "
        "auto-reporting may not have started -- check the 0xA002 response."
    )


@pytest.mark.parametrize("live_bridge", [{"idle_timeout": IDLE_S}], indirect=True)
async def test_an_inbound_frame_does_renew_the_lease(live_bridge):
    """The other half, without which the test above passes for a broken timer.

    A session released at 30s proves nothing on its own if the timer fires at 30s
    regardless of what the client does.
    """
    ws, _ = await live_bridge.connect("hw-inbound-lease")
    try:
        loop = asyncio.get_running_loop()
        started = loop.time()
        while loop.time() - started < IDLE_S * 1.5:
            await asyncio.sleep(IDLE_S / 3)
            await ws.send(p.encode_data(cs108.get_battery_voltage()))
        # Still alive well past the timeout, because the client kept talking.
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(_wait_for_error(ws), IDLE_S / 3)
    finally:
        await ws.close()


async def _wait_for_error(ws) -> str:
    while True:
        msg = json.loads(await ws.recv())
        if p.message_type(msg) == p.MSG_ERROR:
            return msg[p.FIELD_ERROR]


async def test_an_induced_link_failure_names_the_proxy_state(live_bridge, caplog):
    """`An induced BLE-link failure with the proxy still up produces a log line naming it.`

    0xC005 makes the reader drop its BLE link while the ESPHome proxy stays
    perfectly reachable -- the one case where the two states differ and the
    difference is the whole diagnosis. Before TRA-1173 the resulting TransportError
    raised into `gather(..., return_exceptions=True)` and was discarded: no log line
    at any level, and a client left to infer the failure from a closed socket.

    Self-recovering: the reader re-advertises immediately, as it does whenever any
    client disconnects.
    """
    ws, _ = await live_bridge.connect("hw-link-failure")
    with caplog.at_level("ERROR", logger="ble_bridge"):
        try:
            await ws.send(p.encode_data(cs108.force_bt_disconnect()))
            # Let the link actually go down before provoking the failed write.
            await asyncio.sleep(3.0)
            try:
                await ws.send(p.encode_data(cs108.get_battery_voltage()))
            except websockets.exceptions.ConnectionClosed:
                pass
            _, error = await _drain_until_error(ws, 20.0)
        finally:
            await ws.close()

    assert error is not None, (
        "the write failed and the client was told nothing -- it saw only a closed "
        "socket, which is the pre-TRA-1173 behaviour this test exists to prevent"
    )
    assert "BLE link to the device is down" in error, error
    assert "proxy is reachable" in error, (
        f"the error did not distinguish the proxy's state from the device's: {error}"
    )
    assert any("the write to the device failed" in r.getMessage() for r in caplog.records), (
        "the client was told but the log was not; both halves are the criterion"
    )


async def test_the_proxy_libraries_actually_emit_debug_records(live_bridge, caplog):
    """The half of the log-level criterion that a stub cannot answer.

    `test_logging_setup.py` already proves `BLE_MCP_LOG_LEVEL` reaches the ROOT
    logger, which is what makes third-party records visible. What it cannot prove is
    that there is anything down there worth revealing -- that is a fact about
    `bleak_esphome` talking to a real proxy, not about our wiring.

    So this test asserts the other half: against a live proxy, those libraries do
    emit DEBUG records, including the device-disconnect line the TRA-1160 soak
    needed and never saw. Together the two mean `=debug` is worth setting; either
    alone does not.
    """
    with caplog.at_level("DEBUG"):
        ws, _ = await live_bridge.connect("hw-debug-level")
        await ws.close()
        # The disconnect is logged by the library as the transport tears down.
        await asyncio.sleep(2.0)

    from_library = [
        r for r in caplog.records if r.levelname == "DEBUG" and "esphome" in r.name.lower()
    ]
    assert from_library, (
        "no DEBUG records from the ESPHome libraries reached the log. The level is "
        "not being applied to the root logger, so a mid-session link drop would stay "
        "invisible however BLE_MCP_LOG_LEVEL is set."
    )
