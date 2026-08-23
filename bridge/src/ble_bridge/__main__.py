"""uvx entrypoint.

The bridge is a test fixture, not a supervised service: no systemd, no pm2, no
supervision shipped. Whatever runs the tests starts and stops it -- Playwright's
`webServer` hook is already the right shape for this.
"""

from __future__ import annotations

import asyncio
import logging
import signal

from ble_bridge.config import from_env
from ble_bridge.transport import StubTransport
from ble_bridge.ws.server import BridgeServer

logger = logging.getLogger("ble_bridge")


async def _run() -> None:
    config = from_env()

    # TRA-1158 replaces this with the ESPHome transport. Until it lands the
    # relay runs against a stub, which is precisely what makes TRA-1157
    # testable end to end with no radio in the path.
    server = BridgeServer(config, lambda _params: StubTransport())
    await server.start()
    logger.warning("running with the STUB transport: no real BLE device will be reached")

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
