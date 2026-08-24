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

#: The ESPHome Bluetooth Proxy. Accepts "host" or "host:port", matching the Rust
#: bridge's `ESPHOME_PROXY_HOST` so an existing .env.local carries over unchanged.
ESPHOME_HOST_ENV = "ESPHOME_PROXY_HOST"
ESPHOME_PORT_ENV = "ESPHOME_PROXY_PORT"
ESPHOME_PSK_ENV = "ESPHOME_NOISE_PSK"
DEVICE_MAC_ENV = "BLE_MCP_DEVICE_MAC"

#: The ESPHome native API's registered port.
DEFAULT_ESPHOME_PORT = 6053


class ConfigError(ValueError):
    """A configuration value was present but unusable. Never falls back."""


@dataclass(frozen=True)
class EsphomeConfig:
    """Where the proxy is, and which peripheral behind it we want.

    The GATT UUIDs are deliberately absent. They arrive per connection as URL
    query parameters (`service`, `write`, `notify`) and belong to the client that
    asked, not to the daemon: two consumers of the same reader may legitimately
    want different characteristics, and baking them into process configuration
    would make the second one wrong in a way that looks like a device fault.
    """

    proxy_host: str
    proxy_port: int
    #: Canonical upper-case colon form, whatever spelling the environment used.
    device_mac: str
    noise_psk: str | None = None

    @property
    def address(self) -> int:
        """The MAC as the 48-bit integer every ESPHome Bluetooth message carries."""
        return int(self.device_mac.replace(":", ""), 16)


@dataclass(frozen=True)
class Config:
    ws_host: str = DEFAULT_WS_HOST
    ws_port: int = DEFAULT_WS_PORT
    #: None when no proxy is configured at all -- never a half-configured one.
    esphome: EsphomeConfig | None = None

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

    return Config(ws_host=host, ws_port=port, esphome=_esphome_from_env(env))


def _parse_port(raw: str, env_key: str) -> int:
    try:
        port = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{env_key} is set to {raw!r}, which is not an integer.") from exc
    if not 1 <= port <= 65535:
        raise ConfigError(f"{env_key} is set to {port}, which is outside 1-65535.")
    return port


def _normalise_mac(raw: str) -> str:
    """Canonicalise any of the usual spellings, or refuse.

    Accepts colon, hyphen and bare-hex forms because all three appear in the
    wild and in this repo's own examples. Rejects everything else rather than
    reaching the proxy with an address that cannot match any advertisement --
    which would present as "device not found", indistinguishable from a reader
    that is simply switched off.
    """
    hexdigits = raw.replace(":", "").replace("-", "").replace(".", "")
    if len(hexdigits) != 12:
        raise ConfigError(
            f"{DEVICE_MAC_ENV} is set to {raw!r}, which is not a 48-bit MAC address. "
            "Expected 12 hex digits, optionally separated by ':' or '-'."
        )
    try:
        value = int(hexdigits, 16)
    except ValueError as exc:
        raise ConfigError(
            f"{DEVICE_MAC_ENV} is set to {raw!r}, which is not a 48-bit MAC address. "
            "Expected 12 hex digits, optionally separated by ':' or '-'."
        ) from exc
    octets = f"{value:012X}"
    return ":".join(octets[i : i + 2] for i in range(0, 12, 2))


def _esphome_from_env(env: Mapping[str, str]) -> EsphomeConfig | None:
    """The proxy and the target, or None -- never a partially configured one.

    Half-configured is the dangerous state and it is why the two "you set one but
    not the other" cases raise. A proxy with no MAC would start, listen, accept
    clients and relay nothing; a MAC with no proxy would do the same. Both look
    exactly like a reader that is out of range, so the operator debugs the radio
    rather than the environment.
    """
    raw_host = _present(env, ESPHOME_HOST_ENV)
    raw_mac = _present(env, DEVICE_MAC_ENV)

    if raw_host is None and raw_mac is None:
        return None
    if raw_host is None:
        raise ConfigError(
            f"{DEVICE_MAC_ENV} is set but {ESPHOME_HOST_ENV} is not. Refusing to start "
            "without a proxy to reach it through, because the result would relay "
            "nothing while looking configured."
        )
    if raw_mac is None:
        raise ConfigError(
            f"{ESPHOME_HOST_ENV} is set but {DEVICE_MAC_ENV} is not. Refusing to start "
            "without a target device, because the result would relay nothing while "
            "looking configured."
        )

    host, _, inline_port = raw_host.partition(":")
    if not host:
        raise ConfigError(f"{ESPHOME_HOST_ENV} is set to {raw_host!r}, which has no host part.")

    from_inline = _parse_port(inline_port, ESPHOME_HOST_ENV) if inline_port else None
    raw_port = _present(env, ESPHOME_PORT_ENV)
    from_var = _parse_port(raw_port, ESPHOME_PORT_ENV) if raw_port is not None else None

    if from_inline is not None and from_var is not None and from_inline != from_var:
        # Rust silently preferred the inline one. Preferring either is a guess,
        # and the loser is a value the operator can see set and believe is live.
        raise ConfigError(
            f"{ESPHOME_HOST_ENV} specifies port {from_inline} but {ESPHOME_PORT_ENV} "
            f"is {from_var}. Refusing to guess which one you meant; set only one."
        )

    port = from_inline if from_inline is not None else from_var
    return EsphomeConfig(
        proxy_host=host,
        proxy_port=DEFAULT_ESPHOME_PORT if port is None else port,
        device_mac=_normalise_mac(raw_mac),
        noise_psk=_present(env, ESPHOME_PSK_ENV),
    )
