"""The unix socket the MCP process reads. One request per line, one reply per line.

## Why a socket rather than a port

The bridge outlives the MCP client: Claude Code sessions come and go while the BLE
connection must not. A single stdio process would cycle the hardware connection out
from under whoever holds it, so the two are separate processes -- and once they are
separate and co-located on one host, a unix socket does the entire job with no
port, no Express, no CORS, no bearer token, and none of the `origin: '*'` grant
`mcp-http-transport.ts:23` set on a server binding 0.0.0.0.

Mode 0600 is the whole authorization story. Nothing else on the box can open the
file, so there is nothing for a token to add.

## Direction

The MCP process is always the client. This server never calls out, and it does not
know whether an MCP process exists. Starting or killing one has no effect on the
BLE link, which is the property that makes a debugging tool safe to attach to a
running soak.

## The contract

    request   {"op": <name>, "args": {...}}        -- "args" may be omitted
    response  {"ok": true,  "result": {...}}
              {"ok": false, "reason": "<a sentence>"}

UTF-8, newline-delimited JSON, one reply per request, in order, on a connection the
client closes. No server-initiated messages and no streaming: every read is a
cursored poll, which is also the shape the 2026-07-28 MCP revision asks for --
mint a handle from a tool and have the caller pass it back, rather than holding a
session open.

Three refusals here are deliberate rather than lenient, and each one is a case
where being helpful would produce a wrong answer wearing a right one's clothes:

* an **unknown op** names the ops that do exist, so a caller reaching for the
  dropped `get_metrics` learns it was dropped rather than that the socket is broken;
* an **unknown argument** is refused instead of ignored, because a silently dropped
  filter returns the wrong rows and they look exactly like data;
* an **out-of-range limit** is refused instead of clamped, because a clamp leaves
  the caller's own value sitting in their request, apparently in force.

And a fourth thing this file will not do: return an empty list from a disabled ring
without saying so. `notice` carries that, on every read.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import stat
import time
from typing import Any, Final

from ble_bridge import __version__, identity, write_mode
from ble_bridge.config import LOG_BUFFER_SIZE_ENV, SOCKET_PATH_ENV, Config
from ble_bridge.log_buffer import LogBuffer, LogEntry
from ble_bridge.mock_version import MockVersionWatch
from ble_bridge.ws.ownership import CommandPath

logger = logging.getLogger(__name__)

#: The longest request line accepted. A client that never sends a newline must not
#: be able to grow a handler's buffer without bound, and must not be waited on
#: forever -- an unsatisfiable wait presents as slowness, not as an error.
MAX_LINE_BYTES: Final = 64 * 1024

#: How long one handler waits for a request line before hanging up. Generous: a
#: human-driven MCP client is idle most of the time, and the client re-connects per
#: call anyway.
READ_TIMEOUT_S: Final = 300.0

#: Bounds on `limit`. Refused outside them, never clamped.
MIN_LIMIT: Final = 1
MAX_LIMIT: Final = 1000
DEFAULT_LIMIT: Final = 200

DISABLED_NOTICE: Final = (
    f"the log buffer is DISABLED ({LOG_BUFFER_SIZE_ENV}=0), so this bridge is recording "
    "nothing. An empty result here says nothing about what the device did."
)


class ControlError(Exception):
    """A request was refused. The message is the sentence sent back verbatim."""


class ControlServer:
    """Serves the log buffer and the ownership state over a unix socket.

    Read-only by construction: it holds no device, accepts no writes, and every
    handler is a pure read of state the relay owns. That is what makes it safe for
    the MCP process to attach to a bridge that is mid-soak.
    """

    def __init__(
        self,
        config: Config,
        *,
        log_buffer: LogBuffer,
        command_path: CommandPath,
        mock_versions: MockVersionWatch,
        started_at: float,
    ) -> None:
        self._config = config
        self._buffer = log_buffer
        self._path = command_path
        # Required, not defaulted. A ControlServer that quietly built its own
        # watch would report `mock_version_mismatches: 0` for the life of the
        # process while the relay counted elsewhere -- a wrong answer wearing a
        # right one's clothes, which is the failure class this whole surface
        # exists to close.
        self._mock_versions = mock_versions
        self._started_at = started_at
        self._server: asyncio.Server | None = None
        self._handlers = {
            "read_stream": self._read_stream,
            "search_packets": self._search_packets,
            "get_logs": self._get_logs,
            "get_connection_state": self._get_connection_state,
            "status": self._status,
            "get_write_mode": self._get_write_mode,
            "set_write_mode": self._set_write_mode,
        }

    @property
    def path(self) -> str:
        return self._config.socket_path

    @property
    def ops(self) -> list[str]:
        """The ops actually served. Derived from the handler map rather than
        retyped, so this can never advertise an op that is not wired up."""
        return sorted(self._handlers)

    async def start(self) -> str:
        self._clear_the_path()
        parent = os.path.dirname(self.path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._server = await asyncio.start_unix_server(
            self._handle, path=self.path, limit=MAX_LINE_BYTES
        )
        os.chmod(self.path, 0o600)
        logger.info(
            "MCP control socket listening on %s (mode 0600, owner only); tools: %s",
            self.path,
            ", ".join(self.ops),
        )
        return self.path

    async def stop(self) -> None:
        if self._server is None:
            return
        self._server.close()
        await self._server.wait_closed()
        self._server = None
        with contextlib.suppress(FileNotFoundError):
            os.unlink(self.path)

    # --- binding --------------------------------------------------------------

    def _clear_the_path(self) -> None:
        """Remove a dead socket, refuse a live one, refuse anything else.

        A hard kill leaves the file behind, so refusing to start over a corpse
        would make every SIGKILL a manual cleanup. But a socket something is
        actually listening on means a second bridge, and two bridges on one radio
        is the hazard the whole ownership model exists to prevent -- so that case
        refuses, loudly, rather than stealing the name.
        """
        try:
            mode = os.stat(self.path).st_mode
        except FileNotFoundError:
            return
        if not stat.S_ISSOCK(mode):
            raise OSError(
                f"{self.path} exists and is not a socket. Refusing to unlink it: "
                f"set {SOCKET_PATH_ENV} to somewhere else, or remove the file "
                "yourself once you know what it is."
            )
        if _something_is_listening(self.path):
            raise OSError(
                f"{self.path} is already listening: another bridge has this socket. "
                "Refusing to take it over -- two bridges on one radio is the hazard "
                "the single-writer model exists to prevent."
            )
        logger.warning(
            "removing a stale socket at %s: the file was there but nothing was "
            "listening, which is what a hard-killed bridge leaves behind",
            self.path,
        )
        os.unlink(self.path)

    # --- the framing ----------------------------------------------------------

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while True:
                try:
                    line = await asyncio.wait_for(reader.readline(), READ_TIMEOUT_S)
                except TimeoutError:
                    logger.debug("control connection idle for %gs; closing", READ_TIMEOUT_S)
                    return
                except (ValueError, asyncio.LimitOverrunError):
                    # readline() raises rather than growing without bound once the
                    # stream's limit is passed. Answer, then hang up: the stream is
                    # out of sync and there is no safe place to resume.
                    await _reply(
                        writer,
                        {
                            "ok": False,
                            "reason": (
                                f"the request line is too long (over {MAX_LINE_BYTES} "
                                "bytes) and the connection is now out of sync. Reconnect."
                            ),
                        },
                    )
                    return
                if not line:
                    return
                await _reply(writer, self._answer(line))
        except (ConnectionResetError, BrokenPipeError):
            return
        finally:
            writer.close()
            with contextlib.suppress(ConnectionResetError, BrokenPipeError):
                await writer.wait_closed()

    def _answer(self, line: bytes) -> dict[str, Any]:
        try:
            message = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return {"ok": False, "reason": f"the request is not valid JSON: {exc}"}
        try:
            return {"ok": True, "result": self._dispatch(message)}
        except (ControlError, ValueError) as exc:
            return {"ok": False, "reason": str(exc)}
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("a control request raised")
            return {"ok": False, "reason": f"{type(exc).__name__}: {exc}"}

    def _dispatch(self, message: Any) -> dict[str, Any]:
        if not isinstance(message, dict):
            raise ControlError("a request must be a JSON object with an 'op' field")
        op = message.get("op")
        if not isinstance(op, str):
            raise ControlError("a request must carry an 'op' naming one of: " + ", ".join(self.ops))
        handler = self._handlers.get(op)
        if handler is None:
            raise ControlError(
                f"{op!r} is not an op this bridge serves. It serves: {', '.join(self.ops)}."
            )
        args = message.get("args", {})
        if args is None:
            args = {}
        if not isinstance(args, dict):
            raise ControlError(f"{op!r} was given 'args' that is not an object")

        allowed = handler.__code__.co_varnames[1 : handler.__code__.co_argcount]
        unknown = sorted(set(args) - set(allowed))
        if unknown:
            raise ControlError(
                f"{op!r} was given {', '.join(repr(u) for u in unknown)}, which it does "
                f"not take. It takes: {', '.join(allowed) or 'no arguments'}. Refusing "
                "rather than ignoring it -- a dropped filter returns the wrong rows and "
                "they look exactly like data."
            )
        try:
            return handler(**args)
        except TypeError as exc:
            raise ControlError(f"{op!r}: {exc}") from exc

    # --- the reads ------------------------------------------------------------

    def _read_stream(self, cursor: int | None = None, limit: int = DEFAULT_LIMIT) -> dict[str, Any]:
        entries = self._buffer.since(_cursor(cursor), _limit(limit))
        return self._streamed(entries, cursor)

    def _get_logs(self, cursor: int | None = None, limit: int = DEFAULT_LIMIT) -> dict[str, Any]:
        entries = self._buffer.system_since(_cursor(cursor), _limit(limit))
        return self._streamed(entries, cursor)

    def _search_packets(
        self, hex_pattern: str | None = None, limit: int = DEFAULT_LIMIT
    ) -> dict[str, Any]:
        if hex_pattern is None:
            raise ControlError("'search_packets' needs a 'hex_pattern' to search for")
        matches = self._buffer.search_packets(hex_pattern, _limit(limit))
        return {
            "entries": [_entry(e) for e in matches],
            "count": len(matches),
            "pattern": hex_pattern,
            **self._buffer_state(),
        }

    def _get_connection_state(self) -> dict[str, Any]:
        holder = self._path.holder
        device = holder.device if holder is not None else None
        return {
            "held": holder is not None,
            "session": holder.session if holder is not None else None,
            "ready": holder is not None and holder.is_ready,
            "device_name": device.name if device is not None else None,
            "device_id": device.id if device is not None else None,
            "observer_count": holder.observer_count if holder is not None else 0,
            # Lifetime totals for this process, not the ring's contents. See
            # LogBuffer.push_packet for why they are counted even when it is off.
            "packets_transmitted": self._buffer.packets_tx,
            "packets_received": self._buffer.packets_rx,
            # TRA-1211. Scoped to the holder, and three-valued: `null` is
            # "could not check", never "checked and they agree".
            **self._mock_versions.report(holder.mock_version if holder is not None else None),
        }

    def _status(self) -> dict[str, Any]:
        esphome = self._config.esphome
        return {
            "version": __version__,
            # Process identity and code currency, so a consumer stops deriving them
            # from systemd or /proc. See ble_bridge/identity.py for why neither is
            # a git sha, and for why instance_id does NOT replace the uptime
            # arithmetic below: a host suspend leaves instance_id unchanged while
            # wall clock runs on, so the two answer different questions.
            "instance_id": identity.INSTANCE_ID,
            "code_fingerprint": identity.CODE_FINGERPRINT,
            "code_source_root": identity.SOURCE_ROOT,
            "uptime_seconds": round(time.monotonic() - self._started_at, 3),
            # Monotonic for the life of the process, so a watchdog can compare
            # two polls rather than hoping one lands mid-connection. See
            # MockVersionWatch.mismatches.
            "mock_version_mismatches": self._mock_versions.mismatches,
            "ws_host": self._config.ws_host,
            "ws_port": self._config.ws_port,
            "ws_loopback": self._config.is_loopback,
            "log_level": logging.getLevelName(self._config.log_level),
            "log_timestamps": self._config.log_timestamps,
            "log_buffer_size": self._buffer.maxsize,
            "log_buffer_enabled": self._buffer.enabled,
            "idle_timeout": self._config.idle_timeout,
            "socket_path": self.path,
            "esphome_configured": esphome is not None,
            "esphome_proxy": (
                f"{esphome.proxy_host}:{esphome.proxy_port}" if esphome is not None else None
            ),
            "device_mac": esphome.device_mac if esphome is not None else None,
        }

    # --- the one write ---------------------------------------------------------

    def _get_write_mode(self) -> dict[str, Any]:
        return {"with_response": write_mode.get_mode(), "mode": write_mode.describe()}

    def _set_write_mode(self, with_response: Any) -> dict[str, Any]:
        """Flip the GATT write arm without restarting.

        TRA-1153 item 5 measures write-with-response against write-without-response
        under a dense field, and the arms have to interleave: run them in blocks and
        the arm is confounded with time, which is how platform manufactured a
        "confirmed regression" on TRA-1179 that a fifth run dissolved. Restarting per
        arm would trade that confound for bridge process age.

        Returns the previous mode as well as the new one, so a caller logs the
        transition it actually caused rather than the one it intended.
        """
        if not isinstance(with_response, bool):
            raise ControlError(
                f"set_write_mode wants 'with_response' as a boolean, got "
                f"{type(with_response).__name__}. Refusing to coerce -- a truthy "
                "string would silently pin the arm to with-response for a whole soak."
            )
        previous = write_mode.set_mode(with_response)
        return {
            "with_response": with_response,
            "mode": write_mode.describe(with_response),
            "previous_mode": write_mode.describe(previous),
            "changed": previous != with_response,
        }

    # --- shared shapes --------------------------------------------------------

    def _streamed(self, entries: list[LogEntry], cursor: Any) -> dict[str, Any]:
        return {
            "entries": [_entry(e) for e in entries],
            "next_cursor": self._next_cursor(entries, cursor),
            "dropped_before": self._dropped_before(cursor),
            **self._buffer_state(),
        }

    @staticmethod
    def _next_cursor(entries: list[LogEntry], cursor: Any) -> int | None:
        """What to pass back next time.

        The caller's own cursor when nothing new arrived, so a poll against a quiet
        stream holds its place instead of rewinding to the start of the ring.
        """
        if entries:
            return entries[-1].id
        return cursor if isinstance(cursor, int) else None

    def _dropped_before(self, cursor: Any) -> int | None:
        """The oldest id still held, when the caller fell behind the ring.

        `since()` returns an evicted entry as simply absent, which is honest and
        completely invisible. This is the number that makes the gap legible: entries
        between the caller's cursor and this id existed and are gone.
        """
        if not isinstance(cursor, int):
            return None
        oldest = self._buffer.oldest_id
        if oldest is None or oldest <= cursor + 1:
            return None
        return oldest

    def _buffer_state(self) -> dict[str, Any]:
        return {
            "buffer_enabled": self._buffer.enabled,
            "buffer_size": self._buffer.maxsize,
            "notice": None if self._buffer.enabled else DISABLED_NOTICE,
        }


# --- helpers ------------------------------------------------------------------


def _something_is_listening(path: str) -> bool:
    """Whether a live listener holds this socket, checked by connecting to it."""
    import socket

    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.settimeout(1.0)
        probe.connect(path)
        return True
    except OSError:
        return False
    finally:
        probe.close()


def _entry(entry: LogEntry) -> dict[str, Any]:
    return {
        "id": entry.id,
        "timestamp": entry.timestamp,
        "direction": entry.direction,
        "text": entry.text,
        "size": entry.size,
        "is_packet": entry.is_packet,
    }


def _cursor(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ControlError(f"'cursor' must be an integer id or null, not {value!r}")
    return value


def _limit(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ControlError(f"'limit' must be an integer, not {value!r}")
    if not MIN_LIMIT <= value <= MAX_LIMIT:
        raise ControlError(
            f"'limit' is {value}, which is outside {MIN_LIMIT}-{MAX_LIMIT}. Refusing to "
            "clamp: a clamp would leave your own value in the request, apparently in force."
        )
    return value


async def _reply(writer: asyncio.StreamWriter, payload: dict[str, Any]) -> None:
    writer.write(json.dumps(payload).encode() + b"\n")
    await writer.drain()
