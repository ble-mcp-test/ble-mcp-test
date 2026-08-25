"""Opt-in fixtures for tests that drive a real BLE device.

Nothing here runs under `just validate`. These need a powered reader in range of a
reachable ESPHome proxy, so they are gated the same way `tests/stress` gates the
firehose ladder: an environment variable you have to set on purpose.

**The gate is two-part, and the second half matters.** `BLE_MCP_HARDWARE=1` says
you meant to run them; the proxy configuration says they *can* run. Without the
second check a misconfigured box would fall through to `StubTransport` and every
assertion here would pass against a fake -- a green hardware suite that never
touched hardware, which is worse than no suite at all. `config.from_env` already
refuses a half-configured pair, so checking `config.esphome is None` is enough.
"""

from __future__ import annotations

import asyncio
import json
import os

import pytest
import websockets

from ble_bridge.config import Config, from_env
from ble_bridge.esphome import transport_factory
from ble_bridge.habluetooth_runtime import setup_manager
from ble_bridge.ws import protocol as p
from ble_bridge.ws.server import BridgeServer

from . import cs108

#: CS108 defaults. Overridable for a different peripheral, since nothing in the
#: bridge is CS108-specific -- but the protocol helpers in cs108.py are.
SERVICE = os.environ.get("BLE_MCP_SERVICE_UUID", "9800")
WRITE = os.environ.get("BLE_MCP_WRITE_UUID", "9900")
NOTIFY = os.environ.get("BLE_MCP_NOTIFY_UUID", "9901")

#: The proxy must have heard the device advertise before an active connect
#: completes, so first contact is slow. See esphome.ADVERTISEMENT_TIMEOUT_S.
CONNECT_TIMEOUT_S = 45.0

requires_hardware = pytest.mark.skipif(
    not os.environ.get("BLE_MCP_HARDWARE"),
    reason="opt-in: needs a powered BLE device reachable through an ESPHome proxy. "
    "Run with BLE_MCP_HARDWARE=1, or `just hardware` from bridge/.",
)


def _live_config(**overrides) -> Config:
    """The environment's real proxy configuration, with test overrides applied.

    Refuses rather than degrading to the stub: a hardware test that silently ran
    against a fake would report success for a device it never reached.
    """
    base = from_env()
    if base.esphome is None:
        pytest.fail(
            "BLE_MCP_HARDWARE is set but no ESPHome proxy is configured. "
            "Set ESPHOME_PROXY_HOST and BLE_MCP_DEVICE_MAC. Refusing to fall back "
            "to the stub transport, which would pass every assertion here against "
            "no device at all."
        )
    # Ephemeral port, never 8080: a real bridge may be running there, and a test
    # that quietly attached to it would be driving somebody else's device.
    return Config(
        ws_host="127.0.0.1",
        ws_port=0,
        esphome=base.esphome,
        log_level=base.log_level,
        log_timestamps=base.log_timestamps,
        log_buffer_size=base.log_buffer_size,
        **overrides,
    )


class LiveBridge:
    """A bridge on an ephemeral port, wired to the real transport."""

    def __init__(self, server: BridgeServer, url: str) -> None:
        self.server = server
        self.url = url

    def client_url(self, session: str, **params) -> str:
        query = f"service={SERVICE}&write={WRITE}&notify={NOTIFY}&session={session}"
        for key, value in params.items():
            query += f"&{key}={value}"
        return f"{self.url}/?{query}"

    async def connect(self, session: str, **params):
        """Open a writer connection and consume the `connected` frame.

        Returns (websocket, device_name). The caller owns closing it.
        """
        ws = await websockets.connect(self.client_url(session, **params))
        frame = json.loads(await asyncio.wait_for(ws.recv(), CONNECT_TIMEOUT_S))
        if p.message_type(frame) != p.MSG_CONNECTED:
            await ws.close()
            raise AssertionError(f"expected {p.MSG_CONNECTED}, got {frame}")
        return ws, frame[p.FIELD_DEVICE]


@pytest.fixture
async def live_bridge(request):
    """A bridge against the real device. Parameterise with `idle_timeout`.

    Usage:
        @pytest.mark.parametrize("live_bridge", [{"idle_timeout": 30}], indirect=True)
    """
    overrides = getattr(request, "param", None) or {}
    config = _live_config(**overrides)
    await setup_manager()
    server = BridgeServer(config, transport_factory(config.esphome))
    port = await server.start()
    assert port != 8080
    try:
        yield LiveBridge(server, f"ws://127.0.0.1:{port}")
    finally:
        await server.stop()


@pytest.fixture
async def quiet_reader(live_bridge):
    """Leaves the reader as it was found: battery auto-reporting off.

    A test that enables it and dies mid-run would otherwise hand the next
    connection -- or the next engineer -- a device chattering every four seconds
    for reasons nothing explains.
    """
    yield
    try:
        ws, _ = await live_bridge.connect("hw-teardown")
        try:
            await ws.send(p.encode_data(cs108.stop_battery_reporting()))
            await asyncio.sleep(1.0)
        finally:
            await ws.close()
    except Exception as exc:  # pragma: no cover - best effort, never fails a test
        print(f"\nteardown: could not stop battery reporting ({exc})")
