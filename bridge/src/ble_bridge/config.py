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
import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass, field

#: Loopback, not a deployment setting. See test_default_bind_is_loopback.
DEFAULT_WS_HOST = "127.0.0.1"

#: The default listen port. 8080 was the previous one and it was owned by a
#: co-resident service (platform's backend), which presented as a dead reader
#: rather than as a port conflict and cost an evening to find.
#:
#: The rule that fell out of that is narrower than "no defaults": a default must
#: never be a port a co-resident service owns. Choosing one means checking its
#: REPUTATION as well as whether anything is bound -- those are different
#: properties. 15104 was rejected after it was already picked: nothing uses it,
#: but it is the mstream DDoS handler port and IDS/IPS products still ship
#: signatures for it, so a LAN service there can be flagged by a corporate
#: scanner. A search for what is LISTENING cannot find a reputation.
#:
#: 25153 is mnemonic (25 + ESPHome's 153), clear of the alternate-HTTP clusters
#: (8080/8443/9000/9090/10000/18080/28080) and of 30000-32767 where Kubernetes
#: NodePorts live.
DEFAULT_WS_PORT = 25153

#:
#: Accepted range, and the reason for each end:
#:   >= 1024   0-1023 are privileged and need root to bind.
#:   <= 32767  the ephemeral range starts at 32768 on this box, and a listen
#:             port inside it can be transiently stolen by an outbound socket's
#:             source port -- rare, non-deterministic, and miserable to diagnose.
MIN_WS_PORT = 1024
MAX_WS_PORT = 32767

HOST_ENV = "BLE_MCP_WS_HOST"
PORT_ENV = "BLE_MCP_WS_PORT"

# --- Operability, restored by TRA-1173 ----------------------------------------
#
# All four were declared in `.env.local.example` and read by nothing. The Noble
# implementation read them; the Rust bridge was a spike that skipped them; the
# Python port was written against the spike. One event, four inert variables.

LOG_LEVEL_ENV = "BLE_MCP_LOG_LEVEL"
LOG_TIMESTAMPS_ENV = "BLE_MCP_LOG_TIMESTAMPS"
LOG_BUFFER_SIZE_ENV = "BLE_MCP_LOG_BUFFER_SIZE"
IDLE_TIMEOUT_ENV = "BLE_MCP_IDLE_TIMEOUT"

#: Matches `.env.local.example` and `log-buffer.ts:24`.
DEFAULT_LOG_BUFFER_SIZE = 10_000
#: A ring smaller than this cannot span a single soak run; larger than this is a
#: process-lifetime memory leak in slow motion. Out of range raises rather than
#: clamping -- see test_an_out_of_range_buffer_size_fails_loudly.
MIN_LOG_BUFFER_SIZE = 100
MAX_LOG_BUFFER_SIZE = 1_000_000

#: Seconds. Ten minutes, matching `.env.local.example` and the v0.7.0 TS default.
DEFAULT_IDLE_TIMEOUT_S = 600.0

# --- The MCP control socket, added by TRA-1161 --------------------------------

SOCKET_PATH_ENV = "BLE_MCP_SOCKET_PATH"

#: The file name under XDG_RUNTIME_DIR, and the stem of the /tmp fallback.
SOCKET_BASENAME = "ble-bridge.sock"

#: Accepted spellings for BLE_MCP_LOG_LEVEL, named by `logging` itself rather than
#: retyped, so this cannot drift from the levels it resolves to. NOTSET is
#: deliberately not among them: it means "inherit", which as an operator's answer
#: to "what level?" is a fallback wearing a level's clothes.
LOG_LEVELS = {
    logging.getLevelName(level).lower(): level
    for level in (logging.DEBUG, logging.INFO, logging.WARNING, logging.ERROR, logging.CRITICAL)
}
#: The TS side accepted this spelling, so an operator's existing .env.local may
#: already say it.
LOG_LEVELS["warn"] = logging.WARNING

_TRUE = frozenset({"1", "true", "yes", "on"})
_FALSE = frozenset({"0", "false", "no", "off"})

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
    #: 0 means "let the OS assign one", which is what direct construction in
    #: tests wants. It is NOT a default port: from_env refuses to start without
    #: an explicit one, so nothing that actually serves reaches this value.
    ws_port: int = 0
    #: None when no proxy is configured at all -- never a half-configured one.
    esphome: EsphomeConfig | None = None
    #: A `logging` level constant, already resolved from its name.
    log_level: int = logging.INFO
    log_timestamps: bool = True
    #: Entries retained in the ring TRA-1161's get_logs / search_packets read.
    #: 0 means the operator turned it off.
    log_buffer_size: int = DEFAULT_LOG_BUFFER_SIZE
    #: Seconds of no INBOUND frame before a writer's device link is released.
    #: 0 means the operator turned it off. See ble_bridge.ws.idle for why only
    #: inbound traffic counts.
    idle_timeout: float = DEFAULT_IDLE_TIMEOUT_S
    #: Where ble_bridge.control listens and the MCP shim connects. Absolute, always.
    socket_path: str = field(default_factory=lambda: default_socket_path())

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


def default_socket_path(env: Mapping[str, str] | None = None) -> str:
    """Where the bridge listens and the MCP shim connects, absent an override.

    `$XDG_RUNTIME_DIR/ble-bridge.sock`, or `/tmp/ble-bridge-$UID.sock` when
    XDG_RUNTIME_DIR is unset -- as specified in
    docs/design/2026-08-23-python-package-layout.md.

    Two processes have to agree on this without sharing code: the MCP shim is a
    single file so it can be uvx-run, and it cannot import this module. A rule
    duplicated by eye is exactly the wait condition that fails as a timeout and
    reads as "the bridge is down", so
    `bridge/tests/test_mcp_shim.py::test_both_processes_resolve_the_same_socket_path`
    checks the two implementations against each other across a matrix of
    environments. Change this function and that test goes red.
    """
    env = os.environ if env is None else env
    runtime_dir = env.get("XDG_RUNTIME_DIR")
    if runtime_dir is not None and runtime_dir.strip():
        return os.path.join(runtime_dir.strip(), SOCKET_BASENAME)
    return f"/tmp/ble-bridge-{os.getuid()}.sock"


def _present(env: Mapping[str, str], key: str) -> str | None:
    """A blank or whitespace-only value is absent, matching the Rust `!is_empty()`."""
    raw = env.get(key)
    if raw is None or not raw.strip():
        return None
    return raw.strip()


def _check_port_range(port: int) -> None:
    """Range-check an EXPLICIT port. The default is trusted by construction.

    A set-but-wrong value never falls back: falling back would bind a port the
    operator did not ask for while their evidence said otherwise.
    """
    if not MIN_WS_PORT <= port <= MAX_WS_PORT:
        raise ConfigError(
            f"{PORT_ENV} is set to {port}, which is outside "
            f"{MIN_WS_PORT}-{MAX_WS_PORT}. Below {MIN_WS_PORT} needs root; "
            f"above {MAX_WS_PORT} is the ephemeral range, where an outbound "
            "socket can transiently steal the port."
        )


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
        _check_port_range(port)

    return Config(
        ws_host=host,
        ws_port=port,
        esphome=_esphome_from_env(env),
        log_level=_log_level(env),
        log_timestamps=_flag(env, LOG_TIMESTAMPS_ENV, default=True),
        log_buffer_size=_log_buffer_size(env),
        idle_timeout=_idle_timeout(env),
        socket_path=_socket_path(env),
    )


def _socket_path(env: Mapping[str, str]) -> str:
    raw = _present(env, SOCKET_PATH_ENV)
    if raw is None:
        return default_socket_path(env)
    if not os.path.isabs(raw):
        raise ConfigError(
            f"{SOCKET_PATH_ENV} is set to {raw!r}, which is not an absolute path. The "
            "bridge and the MCP shim are separate processes with separate working "
            "directories, so a relative path names two different files -- and the "
            "symptom would be an MCP server reporting the bridge as down while the "
            "bridge is running fine."
        )
    return raw


def _log_level(env: Mapping[str, str]) -> int:
    raw = _present(env, LOG_LEVEL_ENV)
    if raw is None:
        return logging.INFO
    try:
        return LOG_LEVELS[raw.lower()]
    except KeyError:
        raise ConfigError(
            f"{LOG_LEVEL_ENV} is set to {raw!r}, which is not a log level. "
            f"Expected one of {', '.join(sorted(LOG_LEVELS))}. Refusing to fall back "
            "to info -- an ignored log level is exactly how this variable came to be "
            "inert in the first place."
        ) from None


def _flag(env: Mapping[str, str], key: str, *, default: bool) -> bool:
    """A boolean, or a refusal. Never `!= "false"`.

    `logger.ts:11` compared against the string "false", so every typo meant true:
    BLE_MCP_LOG_TIMESTAMPS=flase reads as configured-off and behaves as on.
    """
    raw = _present(env, key)
    if raw is None:
        return default
    lowered = raw.lower()
    if lowered in _TRUE:
        return True
    if lowered in _FALSE:
        return False
    raise ConfigError(
        f"{key} is set to {raw!r}, which is not a boolean. Expected one of "
        f"{', '.join(sorted(_TRUE | _FALSE))}."
    )


def _log_buffer_size(env: Mapping[str, str]) -> int:
    raw = _present(env, LOG_BUFFER_SIZE_ENV)
    if raw is None:
        return DEFAULT_LOG_BUFFER_SIZE
    try:
        size = int(raw)
    except ValueError as exc:
        raise ConfigError(
            f"{LOG_BUFFER_SIZE_ENV} is set to {raw!r}, which is not an integer."
        ) from exc
    if size == 0:
        return 0
    if not MIN_LOG_BUFFER_SIZE <= size <= MAX_LOG_BUFFER_SIZE:
        raise ConfigError(
            f"{LOG_BUFFER_SIZE_ENV} is set to {size}, which is outside "
            f"{MIN_LOG_BUFFER_SIZE}-{MAX_LOG_BUFFER_SIZE} (0 disables the buffer). "
            "Refusing to clamp: a clamp is a fallback, and the operator would keep "
            "reading their own value back out of the environment."
        )
    return size


def _idle_timeout(env: Mapping[str, str]) -> float:
    raw = _present(env, IDLE_TIMEOUT_ENV)
    if raw is None:
        return DEFAULT_IDLE_TIMEOUT_S
    try:
        seconds = float(raw)
    except ValueError as exc:
        raise ConfigError(
            f"{IDLE_TIMEOUT_ENV} is set to {raw!r}, which is not a number of seconds."
        ) from exc
    if seconds < 0:
        raise ConfigError(
            f"{IDLE_TIMEOUT_ENV} is set to {seconds}, which is negative. Use 0 to "
            "disable the timeout."
        )
    return seconds


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
