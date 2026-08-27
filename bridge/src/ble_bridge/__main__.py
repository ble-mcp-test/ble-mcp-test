"""uvx entrypoint.

The bridge is a test fixture, not a supervised service: no systemd, no pm2, no
supervision shipped. Whatever runs the tests starts and stops it -- Playwright's
`webServer` hook is already the right shape for this.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import time

from dotenv import find_dotenv, load_dotenv

from ble_bridge import write_mode
from ble_bridge.config import Config, from_env
from ble_bridge.control import ControlServer
from ble_bridge.esphome import transport_factory
from ble_bridge.habluetooth_runtime import setup_manager
from ble_bridge.log_buffer import LogBuffer
from ble_bridge.logging_setup import configure as configure_logging
from ble_bridge.transport import TransportFactory
from ble_bridge.ws.server import BridgeServer

logger = logging.getLogger("ble_bridge")


def _load_env_file() -> str | None:
    """Read `.env.local` ourselves rather than trusting the launching shell.

    direnv hooks `PROMPT_COMMAND`, which a one-shot agent tool shell never fires,
    so `cd`-ing into this repo does not load its `.envrc`: the process inherits
    whatever environment the *session* started with, from whichever repo that
    was. That is not fixable by launching from the right directory, because the
    directory is already right. Reading the file removes the dependency.

    Searches upward from the working directory, so `uv run ble-bridge` from
    `bridge/` finds the repo root. A real environment variable wins over the
    file, so overriding for a single run still works. Returns the path used, or
    None -- absence is not an error here; `_select_transport` is the guard.
    """
    path = find_dotenv(".env.local", usecwd=True)
    if not path:
        return None
    load_dotenv(path)
    return path


async def _select_transport(config: Config) -> TransportFactory:
    """A real device, or nothing at all.

    There is deliberately no stub fallback. A bridge that quietly relays nothing
    has every symptom of a dead reader, and worse: because trigger injection is
    mock-side, a browser suite passes green against it. That is a false hardware
    verification, which is more expensive than any startup failure.
    """
    if config.esphome is None:
        raise SystemExit(
            "no BLE device configured: set ESPHOME_PROXY_HOST and "
            "BLE_MCP_DEVICE_MAC (the bridge reads .env.local from the repo "
            "root). Refusing to start -- a bridge that relays nothing passes "
            "tests that never reached a radio."
        )

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

    # The MCP surface. Started here rather than inside BridgeServer because it is a
    # second consumer of the relay's state, not part of the relay: it holds no
    # device, accepts no writes, and its absence changes nothing about the BLE link.
    control = ControlServer(
        config,
        log_buffer=log_buffer,
        command_path=server.command_path,
        started_at=time.monotonic(),
    )
    await control.start()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    try:
        await stop.wait()
        logger.info("shutting down")
    finally:
        # In a `finally` so a cancelled or killed daemon still unlinks its socket.
        # A file left behind with nothing listening is what the next start has to
        # recognise as stale, and the fewer times it has to make that judgement the
        # better.
        await control.stop()
        await server.stop()


def _log_operability(config: Config, log_buffer: LogBuffer) -> None:
    """Say what the operability surface is set to, at startup, every time.

    The TRA-1160 soak ran for 781 iterations with `BLE_MCP_LOG_LEVEL=debug` in the
    environment and INFO in the process, and nothing anywhere said so. A line that
    states the resolved values is what makes that discrepancy visible in the first
    minute rather than in the post-mortem.
    """
    logger.info(
        "GATT write mode: %s. TRA-1153 item 5 flips this per run over the control "
        "socket; the authoritative value for any one connection is the 'write path:' "
        "line that connection logs, not this one.",
        write_mode.describe(),
    )
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
    # The file is read before anything looks at the environment, or the values in
    # it are not there to be read.
    _load_env_file()

    # Configuration is read BEFORE logging is set up, so the level the operator
    # asked for governs the very first line. The other order is how the level came
    # to be hardcoded here in the first place.
    config = from_env()
    write_mode.set_mode(config.write_response)
    log_buffer = configure_logging(config)
    asyncio.run(_run(config, log_buffer))


if __name__ == "__main__":
    main()
