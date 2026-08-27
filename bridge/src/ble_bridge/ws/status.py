"""A read path for people who do not hold the command path.

Being refused is not enough. `CommandPathBusy` names the holder, but only to a
client that already tried to connect -- and trying to connect is exactly what a
careful person wants to avoid doing to a reader someone else is driving. This
answers "who has it, and since when" before anyone claims anything.

**Why HTTP on the WebSocket port.** `getAvailability()` runs in a browser,
pre-connect: it cannot reach the MCP unix socket, and asking over WebSocket would
mean opening a connection to discover whether opening a connection is possible.
The port already answers plain HTTP with 426, and a consumer already relies on
that, so a path is cheaper than a port and leaves the existing contract intact.

**Why there is no heartbeat and no TTL.** The port answering is itself the
liveness signal -- a dead bridge refuses the connection. TTLs exist to expire a
record that can outlive its writer; this record cannot, because it *is* the
writer. The stale-lock problem the ticket calls "the part that most needs
designing" is designed out rather than solved.

Scope: one bridge process. Two bridges on one host still cannot see each other --
that is the cross-container half of TRA-1174 and it is deliberately not here.
"""

from __future__ import annotations

import datetime as dt
import json
from http import HTTPStatus
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ble_bridge.ws.ownership import CommandPath

#: The one path that answers. Everything else falls through to the WebSocket
#: handshake, which means a non-upgrade request still gets 426 exactly as before.
STATUS_PATH = "/status"


def cors_headers(is_loopback: bool) -> list[tuple[str, str]]:
    """Permissive CORS on loopback, none at all when bound wider.

    Conditional rather than static, and that is the whole point. This repo has a
    scar here: mcp-http-transport.ts:23 set `origin: '*'` on a 0.0.0.0 bind, and
    TRA-1161 deleted it. The hazard there was never `*` on its own -- it was `*`
    CO-OCCURRING with a wide bind. Neither half is dangerous alone, which is why
    the combination survived review.

    A static `*` plus a loopback default would reproduce that shape exactly: two
    defensible halves, safe only because they happen not to overlap, with the
    safety resting on a default that someone will eventually change. Deriving
    the header from the bind makes the unsafe combination unrepresentable
    instead of merely warned about -- and a warning is the weakest guard
    available, being the one thing everybody reads past.

    On loopback the grant is inert: no origin can reach this port that is not
    already on the host, and everything it exposes is already readable from the
    MCP socket by any local process.
    """
    if not is_loopback:
        return []
    return [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET"),
    ]


def status_payload(path: CommandPath, version: str) -> dict:
    """What the command path looks like from outside, right now.

    `held_seconds` is derived from a monotonic clock rather than from
    `acquired_at`, so a wall-clock step cannot produce a negative duration.
    """
    holder = path.holder
    if holder is None:
        return {
            "held": False,
            "session": None,
            "acquired_at": None,
            "held_seconds": None,
            "ready": False,
            "device_name": None,
            "device_id": None,
            "observer_count": 0,
            "version": version,
        }

    device = holder.device
    return {
        "held": True,
        "session": holder.session,
        "acquired_at": dt.datetime.fromtimestamp(holder.acquired_at, dt.UTC)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "held_seconds": holder.held_seconds,
        # A claim exists from the instant it is taken, before connect() returns.
        # `ready` is what distinguishes "someone is mid-connect" from "someone is
        # driving the reader", and they are different things to walk in on.
        "ready": holder.is_ready,
        "device_name": device.name if device is not None else None,
        "device_id": device.id if device is not None else None,
        "observer_count": holder.observer_count,
        "version": version,
    }


def encode(payload: dict, *, is_loopback: bool) -> tuple[HTTPStatus, list[tuple[str, str]], bytes]:
    """Render a payload as the response triple `process_request` expects."""
    body = json.dumps(payload).encode() + b"\n"
    headers = [
        ("Content-Type", "application/json"),
        ("Content-Length", str(len(body))),
        *cors_headers(is_loopback),
    ]
    return HTTPStatus.OK, headers, body
