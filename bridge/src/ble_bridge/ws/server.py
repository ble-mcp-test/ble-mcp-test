"""The WebSocket relay: `connected` and `data`, in both directions.

Scope follows the protocol spec's section 4 sequencing. In practice
platform<->bridge traffic is `connected` + `data` and nothing else; the Rust
bridge has run for hours implementing only those two and drives the entire soak.
So those are what this ticket builds, and they are what the firehose exercises.
`error` and `warning` beyond parameter validation, `force_cleanup`, and the
single-writer / multi-observer ownership model are TRA-1159.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import websockets
from websockets.asyncio.server import Server, ServerConnection, serve

from ble_bridge.config import Config
from ble_bridge.mock_version import expected_mock_version
from ble_bridge.transport import BleTransport, TransportFactory
from ble_bridge.ws import protocol as p
from ble_bridge.ws.params import (
    MOCK_VERSION_PARAM,
    ConnectionParams,
    InvalidParameterError,
    MissingParametersError,
    parse_params,
)

logger = logging.getLogger(__name__)


class _Stop:
    """Queue sentinel. A distinct type so it can never collide with a payload."""


_STOP = _Stop()


class BridgeServer:
    """Relays between one WebSocket client and one BLE transport.

    The transport is constructed inside the connection handler, deliberately.
    See ble_bridge.transport for why process lifetime must not be a claim on
    the radio.
    """

    def __init__(self, config: Config, transport_factory: TransportFactory) -> None:
        self._config = config
        self._factory = transport_factory
        self._server: Server | None = None
        self._port: int | None = None

    @property
    def port(self) -> int:
        if self._port is None:
            raise RuntimeError("server is not started")
        return self._port

    async def start(self) -> int:
        """Bind and begin serving. Returns the port actually bound.

        Returning the resolved port is what lets tests ask for an ephemeral one
        rather than colliding with a bridge someone else is running on 8080.
        """
        self._server = await serve(self._handle, self._config.ws_host, self._config.ws_port)
        self._port = next(iter(self._server.sockets)).getsockname()[1]
        self._log_bind()
        return self._port

    def _log_bind(self) -> None:
        """State the reachable address and the radio posture, not just the port.

        "The server is up" is identical evidence whether or not anything off-box
        can reach it, and whether or not it is holding a device. Both have
        misled an operator in this project already.
        """
        where = f"{self._config.ws_host}:{self._port}"
        if self._config.is_loopback:
            logger.info("bridge listening on %s (loopback: reachable only from this host)", where)
        else:
            logger.warning(
                "bridge listening on %s -- NOT loopback. Every host that can route here can "
                "drive the BLE device, and there is no authentication on this path.",
                where,
            )
        logger.info("no device is held until a client connects; disconnecting releases it")

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
            self._port = None

    async def _handle(self, ws: ServerConnection) -> None:
        try:
            params = parse_params(ws.request.path)
        except (MissingParametersError, InvalidParameterError) as exc:
            # bridge-server.ts:84 -- send the error, then close. No transport is
            # built, so a rejected connection never claims the device.
            await ws.send(p.encode_error(str(exc)))
            await ws.close()
            return

        _log_mock_version(params)

        transport = self._factory(params)
        queue: asyncio.Queue[bytes | _Stop] = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def on_data(payload: bytes) -> None:
            # Synchronous, and called on the transport's loop: hand off and
            # return. Anything slower here blocks the notification source, which
            # in the ESPHome case also swallows exceptions into its own logger.
            loop.call_soon_threadsafe(queue.put_nowait, payload)

        transport.set_data_callback(on_data)

        device = await transport.connect()
        await ws.send(p.encode_connected(device.name))
        logger.info("session %s connected to %s", params.session, device.name)

        sender = asyncio.create_task(_drain(ws, queue))
        try:
            await self._receive(ws, transport)
        finally:
            await queue.put(_STOP)
            await sender
            await transport.cleanup()
            logger.info("session %s released %s", params.session, device.name)

    async def _receive(self, ws: ServerConnection, transport: BleTransport) -> None:
        try:
            async for raw in ws:
                try:
                    msg = p.decode(raw)
                except p.ProtocolError as exc:
                    # Undecodable frames are dropped rather than fatal: one bad
                    # frame must not tear down a session mid-soak.
                    logger.warning("dropped an undecodable frame: %s", exc)
                    continue
                if p.message_type(msg) != p.MSG_DATA:
                    continue
                try:
                    payload = p.data_payload(msg)
                except p.ProtocolError as exc:
                    logger.warning("dropped a malformed data frame: %s", exc)
                    continue
                await transport.write(payload)
        except websockets.exceptions.ConnectionClosed:
            pass


async def _drain(ws: ServerConnection, queue: asyncio.Queue[Any]) -> None:
    """One sender task per connection, so notifications keep their order.

    Awaiting ws.send inside the transport callback would block the notification
    source; spawning a task per notification would let them race and arrive out
    of order, which the firehose's sequence-gap accounting would report as loss.
    """
    while True:
        payload = await queue.get()
        if isinstance(payload, _Stop):
            return
        try:
            await ws.send(p.encode_data(payload))
        except websockets.exceptions.ConnectionClosed:
            return


def _log_mock_version(params: ConnectionParams) -> None:
    """Telemetry only.

    The spec is explicit that both outcomes here are server-side logging: no
    message is sent to the client, nothing is rejected, no behaviour changes.
    `_mv` is version *observation*, not negotiation, and porting it as
    negotiation would invent a mechanism that has never existed. If real
    negotiation is wanted it should be designed rather than inherited.
    """
    if params.mock_version is None:
        logger.warning(
            "WebSocket connection with no %s: this client is bypassing the Web Bluetooth "
            "mock and connecting directly. It should be using injectWebBluetoothMock(). "
            "See README.md.",
            MOCK_VERSION_PARAM,
        )
        return

    expected = expected_mock_version()
    if expected is None:
        logger.debug(
            "cannot compare %s=%s: the npm package version could not be resolved",
            MOCK_VERSION_PARAM,
            params.mock_version,
        )
    elif params.mock_version != expected:
        logger.warning(
            "mock version mismatch: expected %s, got %s",
            expected,
            params.mock_version,
        )
