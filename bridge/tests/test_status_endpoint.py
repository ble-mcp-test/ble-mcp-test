"""The HTTP status endpoint on the WebSocket port.

Why HTTP rather than a WebSocket frame or the MCP socket: `getAvailability()`
runs in a browser, pre-connect. It cannot reach the MCP unix socket, and asking
over WebSocket would mean opening a connection to find out whether opening a
connection is possible. A plain GET answers before any claim is made.

Why this port rather than a second one: the bridge already answers plain HTTP
here with 426, and a consumer already depends on that (platform's dev-bridge
probe treats any HTTP status as "listening"). Adding a path is cheaper than
adding a port, and it keeps the 426 contract intact for everything else.

There is deliberately no heartbeat and no TTL. The port answering IS the
liveness signal: a dead bridge refuses the connection, which is unambiguous and
needs no expiry logic. A record that outlives its process is what forces a TTL,
and this one cannot.
"""

import asyncio
import json
import urllib.error
import urllib.request

import pytest
import websockets

from ble_bridge.config import Config
from ble_bridge.transport import StubTransport
from ble_bridge.ws import status as status_endpoint
from ble_bridge.ws.server import BridgeServer

REQUIRED = "service=180a&write=2a01&notify=2a02"


@pytest.fixture
async def relay():
    """An ephemeral loopback port. Never 8080 -- see test_relay for why."""

    def factory(_params):
        return StubTransport()

    server = BridgeServer(Config(ws_host="127.0.0.1", ws_port=0), factory)
    port = await server.start()
    assert port != 8080
    try:
        yield port
    finally:
        await server.stop()


async def _get(port: int, path: str = "/status") -> tuple[int, dict, dict]:
    """Fetch over real HTTP, off the event loop thread.

    urllib in a thread rather than an async client: this is the only HTTP call
    in the suite and it is not worth a dependency, but it must not block the
    loop the server is running on.
    """

    def fetch() -> tuple[int, dict, dict]:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as r:
                return r.status, dict(r.headers), json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), {}

    return await asyncio.to_thread(fetch)


async def test_status_reports_free_when_nothing_holds_the_path(relay):
    status, _, body = await _get(relay)
    assert status == 200
    assert body["held"] is False
    assert body["session"] is None
    assert body["acquired_at"] is None
    assert body["held_seconds"] is None


async def test_status_names_the_holder_and_when_it_took_the_path(relay):
    async with websockets.connect(f"ws://127.0.0.1:{relay}/?{REQUIRED}&session=holder-1") as ws:
        await ws.recv()  # connected
        status, _, body = await _get(relay)

    assert status == 200
    assert body["held"] is True
    assert body["session"] == "holder-1"
    assert body["device_name"] == "StubDevice"
    # The two questions a blocked person actually asks: who, and since when.
    assert body["acquired_at"].endswith("Z")
    assert isinstance(body["held_seconds"], (int, float))
    assert body["held_seconds"] >= 0


async def test_status_goes_back_to_free_after_the_holder_disconnects(relay):
    async with websockets.connect(f"ws://127.0.0.1:{relay}/?{REQUIRED}&session=holder-2") as ws:
        await ws.recv()
    # Release lands when the server processes the close, not when the client
    # returns from the context manager -- the same race the e2e helpers hit.
    for _ in range(50):
        _, _, body = await _get(relay)
        if not body["held"]:
            break
        await asyncio.sleep(0.05)
    assert body["held"] is False


async def test_status_is_fetchable_cross_origin(relay):
    """The mock fetches this from a page origin, so it must survive CORS.

    GET only and no credentials: this exposes what any local process can already
    read from the MCP socket, and the bridge binds loopback by default.
    """
    _, headers, _ = await _get(relay)
    assert headers.get("Access-Control-Allow-Origin") == "*"


def test_cors_is_withheld_when_the_bind_is_not_loopback():
    """The unsafe combination is unrepresentable, not merely warned about.

    mcp-http-transport.ts:23 set `origin: '*'` on a 0.0.0.0 bind and TRA-1161
    deleted it. The hazard was never `*` alone -- it was `*` co-occurring with a
    wide bind, and neither half is dangerous by itself, which is why the
    combination survived review. A static `*` plus a loopback default would
    reproduce that shape, safe only by a default that someone can change.

    Tested as a pure function on purpose: asserting it by actually binding
    0.0.0.0 would mean a test that opens a port to the network to prove a
    security property, which is its own bad idea.
    """
    assert status_endpoint.cors_headers(is_loopback=True) != []
    assert status_endpoint.cors_headers(is_loopback=False) == []


def test_encode_carries_the_bind_through_to_the_headers():
    """The conditional is wired, not just defined."""
    wide = dict(status_endpoint.encode({"held": False}, is_loopback=False)[1])
    local = dict(status_endpoint.encode({"held": False}, is_loopback=True)[1])
    assert "Access-Control-Allow-Origin" not in wide
    assert local["Access-Control-Allow-Origin"] == "*"


async def test_every_other_path_still_gets_426(relay):
    """platform's dev-bridge probe depends on plain HTTP answering here.

    It treats any status as "listening" and connection-refused as "not running",
    so the contract that must not break is that something answers -- but 426 is
    the specific thing a non-upgrade request has always got, and narrowing it to
    only /status would be a silent change to a surface someone reads.
    """
    status, _, _ = await _get(relay, "/")
    assert status == 426
