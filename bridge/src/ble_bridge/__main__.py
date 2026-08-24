"""uvx entrypoint.

The bridge is a test fixture, not a supervised service: no systemd, no pm2, no
supervision shipped. Whatever runs the tests starts and stops it -- Playwright's
`webServer` hook is already the right shape for this.
"""

from __future__ import annotations

import asyncio
import logging
import signal

from ble_bridge.config import Config, from_env
from ble_bridge.esphome import transport_factory
from ble_bridge.habluetooth_runtime import setup_manager
from ble_bridge.transport import StubTransport, TransportFactory
from ble_bridge.ws.server import BridgeServer

logger = logging.getLogger("ble_bridge")


async def _select_transport(config: Config) -> TransportFactory:
    """Real device if one is configured, stub if none is -- and say which, loudly.

    The stub is not a fallback. It is reached only when NO proxy and NO device
    are configured at all, because `config.from_env` refuses a half-configured
    pair rather than handing one back. That distinction is the whole point: a
    bridge that quietly relays nothing has every symptom of a dead reader, and
    an operator will spend the evening on the radio.
    """
    if config.esphome is None:
        logger.warning(
            "running with the STUB transport: no real BLE device will be reached. "
            "Set ESPHOME_PROXY_HOST and BLE_MCP_DEVICE_MAC to reach one."
        )
        return lambda _params: StubTransport()

    await setup_manager()
    logger.info(
        "ESPHome transport: device %s via proxy %s:%d%s",
        config.esphome.device_mac,
        config.esphome.proxy_host,
        config.esphome.proxy_port,
        " (encrypted)" if config.esphome.noise_psk else "",
    )
    return transport_factory(config.esphome)


async def _run() -> None:
    config = from_env()

    server = BridgeServer(config, await _select_transport(config))
    await server.start()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    await stop.wait()
    logger.info("shutting down")
    await server.stop()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    asyncio.run(_run())


if __name__ == "__main__":
    main()
