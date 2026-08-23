"""Every message name and shape that crosses the WebSocket, in one place.

This module is load-bearing, and the reason is a specific recurring defect rather
than tidiness. CLAUDE.md's first failure class is a waiter whose condition cannot
be satisfied by what is actually sent: it fails as a *timeout*, so it reads as
slowness rather than as a defect, and inspection missed it four separate times in
this codebase. `cleanup_complete` is the standing example -- the TypeScript client
waits on a message name the server never sends, and the path only resolves because
a second, differently-named message happens to arrive.

One module defining every name, imported by the server and by the tests alike,
makes that class structurally impossible. `test_no_message_type_literal_outside_
protocol` is what keeps it true as the tree grows: no message-type string literal
may appear anywhere else. The one deliberate exception is `test_protocol.py`,
which hardcodes the expected wire strings on purpose -- checking this module
against itself would be a tautology, so the assertions there are transcribed from
the TypeScript source and cite its line numbers.

Message *type* names and *field* names are kept as separate constants even where
they collide. `MSG_DATA` and `FIELD_DATA` are both "data" today; treating one as
the other would work by coincidence and break the moment either moves.

Membership follows docs/design/2026-08-23-ws-protocol-spec.md section 5. TRA-1157
implements the two types that carry all real traffic, plus the parameter
validation error. `error`/`warning` beyond validation and the `force_cleanup`
pair are TRA-1159; the cleanup and admin families are dropped as dead on both
ends, and the phantom types were never protocol at all.
"""

from __future__ import annotations

import json
from typing import Any, Final

MSG_CONNECTED: Final = "connected"
MSG_DATA: Final = "data"
MSG_ERROR: Final = "error"

#: What this server may emit. Extended by TRA-1159, never by a caller.
SERVER_MESSAGE_TYPES: Final = (MSG_CONNECTED, MSG_DATA, MSG_ERROR)
#: What this server accepts. `force_cleanup` joins this in TRA-1159.
CLIENT_MESSAGE_TYPES: Final = (MSG_DATA,)

FIELD_TYPE: Final = "type"
FIELD_DEVICE: Final = "device"
FIELD_DATA: Final = "data"
FIELD_ERROR: Final = "error"

#: Verbatim from src/bridge-server.ts:84. A client may match on this string.
MISSING_PARAMS_ERROR: Final = "Missing required parameters: service, write, notify"


class ProtocolError(ValueError):
    """A frame could not be understood as this protocol."""


def message_type(msg: dict[str, Any]) -> str | None:
    return msg.get(FIELD_TYPE)


def encode_connected(device: str) -> str:
    """src/bridge-server.ts:145 -- sent once the device link is established."""
    return json.dumps({FIELD_TYPE: MSG_CONNECTED, FIELD_DEVICE: device})


def encode_data(payload: bytes) -> str:
    """A notification travelling device -> client.

    The payload is a JSON array of ints, matching `Array.from(Uint8Array)` at
    src/ws-handler.ts:85-88. Not base64: the mock does `Uint8Array.from(msg.data)`
    on the far side, and changing the encoding would break every existing client.
    """
    return json.dumps({FIELD_TYPE: MSG_DATA, FIELD_DATA: list(payload)})


def encode_error(message: str) -> str:
    return json.dumps({FIELD_TYPE: MSG_ERROR, FIELD_ERROR: message})


def decode(raw: str | bytes) -> dict[str, Any]:
    try:
        msg = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise ProtocolError(f"frame is not JSON: {exc}") from exc
    if not isinstance(msg, dict):
        raise ProtocolError(f"frame is not a JSON object: {type(msg).__name__}")
    return msg


def data_payload(msg: dict[str, Any]) -> bytes:
    """Extract the bytes from a `data` frame travelling in either direction."""
    raw = msg.get(FIELD_DATA)
    if raw is None:
        raise ProtocolError(f"{MSG_DATA} frame has no {FIELD_DATA!r} field")
    if not isinstance(raw, list):
        raise ProtocolError(
            f"{MSG_DATA} {FIELD_DATA!r} must be an array, got {type(raw).__name__}"
        )
    try:
        return bytes(raw)
    except (ValueError, TypeError) as exc:
        raise ProtocolError(f"{MSG_DATA} {FIELD_DATA!r} is not a byte array: {exc}") from exc
