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
from ble_bridge.log_buffer import LogBuffer
from ble_bridge.logging_setup import configure as configure_logging
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


async def _run(config: Config, log_buffer: LogBuffer) -> None:
    _log_operability(config, log_buffer)

    server = BridgeServer(config, await _select_transport(config), log_buffer=log_buffer)
    await server.start()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    await stop.wait()
    logger.info("shutting down")
    await server.stop()


def _log_operability(config: Config, log_buffer: LogBuffer) -> None:
    """Say what the operability surface is set to, at startup, every time.

    The TRA-1160 soak ran for 781 iterations with `BLE_MCP_LOG_LEVEL=debug` in the
    environment and INFO in the process, and nothing anywhere said so. A line that
    states the resolved values is what makes that discrepancy visible in the first
    minute rather than in the post-mortem.
    """
    logger.info(
        "log level %s, timestamps %s, log buffer %s",
        logging.getLevelName(config.log_level),
        "on" if config.log_timestamps else "off",
        f"{log_buffer.maxsize} entries" if log_buffer.enabled else "DISABLED",
    )
    if config.idle_timeout:
        logger.info(
            "idle timeout %gs: a writer that sends nothing for that long is released. "
            "Device notifications do NOT renew it -- only frames from the client.",
            config.idle_timeout,
        )
    else:
        logger.warning(
            "idle timeout DISABLED (%s=0): a client that connects and walks away holds "
            "the device until its socket drops.",
            "BLE_MCP_IDLE_TIMEOUT",
        )


def main() -> None:
    # Configuration is read BEFORE logging is set up, so the level the operator
    # asked for governs the very first line. The other order is how the level came
    # to be hardcoded here in the first place.
    config = from_env()
    log_buffer = configure_logging(config)
    asyncio.run(_run(config, log_buffer))


if __name__ == "__main__":
    main()
