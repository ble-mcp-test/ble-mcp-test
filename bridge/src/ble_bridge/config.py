"""Environment-only configuration, read at startup.

No file parsing, deliberately. The Rust bridge's `Config::from_env()` silently
ignored a `.env.local` holding precisely the two variables that selected its
ESPHome backend -- configuration that was present, correct-looking, and dropped
on the floor. A process must never appear to support a file it ignores, so this
one reads the environment and says so plainly.

The same rule drives the parsing below: a variable that is present but unusable
raises rather than falling back. A silent fallback succeeds against the *wrong*
input, so it looks like correctness and nothing is even slow.
"""

from __future__ import annotations

import ipaddress
import os
from collections.abc import Mapping
from dataclasses import dataclass

#: Loopback, not a deployment setting. See test_default_bind_is_loopback.
DEFAULT_WS_HOST = "127.0.0.1"
DEFAULT_WS_PORT = 8080

HOST_ENV = "BLE_MCP_WS_HOST"
PORT_ENV = "BLE_MCP_WS_PORT"


class ConfigError(ValueError):
    """A configuration value was present but unusable. Never falls back."""


@dataclass(frozen=True)
class Config:
    ws_host: str = DEFAULT_WS_HOST
    ws_port: int = DEFAULT_WS_PORT

    @property
    def ws_bind(self) -> str:
        return f"{self.ws_host}:{self.ws_port}"

    @property
    def is_loopback(self) -> bool:
        """Whether the bind surface is reachable only from this host.

        Reported in the startup log because "the server is up" is identical
        evidence whether or not anything off-box can reach it.
        """
        if self.ws_host == "localhost":
            return True
        try:
            return ipaddress.ip_address(self.ws_host).is_loopback
        except ValueError:
            return False


def _present(env: Mapping[str, str], key: str) -> str | None:
    """A blank or whitespace-only value is absent, matching the Rust `!is_empty()`."""
    raw = env.get(key)
    if raw is None or not raw.strip():
        return None
    return raw.strip()


def from_env(env: Mapping[str, str] | None = None) -> Config:
    env = os.environ if env is None else env

    host = _present(env, HOST_ENV) or DEFAULT_WS_HOST

    raw_port = _present(env, PORT_ENV)
    if raw_port is None:
        port = DEFAULT_WS_PORT
    else:
        try:
            port = int(raw_port)
        except ValueError as exc:
            raise ConfigError(
                f"{PORT_ENV} is set to {raw_port!r}, which is not an integer. "
                f"Refusing to fall back to {DEFAULT_WS_PORT}."
            ) from exc
        if not 1 <= port <= 65535:
            raise ConfigError(
                f"{PORT_ENV} is set to {port}, which is outside 1-65535. "
                f"Refusing to fall back to {DEFAULT_WS_PORT}."
            )

    return Config(ws_host=host, ws_port=port)
