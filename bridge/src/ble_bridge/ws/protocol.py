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
implemented the two types that carry all real traffic plus the parameter
validation error; TRA-1159 adds `warning` and the ownership errors. The
`force_cleanup` pair is TRA-1162's, the cleanup and admin families are dropped as
dead on both ends, and the phantom types were never protocol at all.
"""

from __future__ import annotations

import json
from typing import Any, Final

MSG_CONNECTED: Final = "connected"
MSG_DATA: Final = "data"
MSG_ERROR: Final = "error"
MSG_WARNING: Final = "warning"

#: What this server may emit. Never extended by a caller.
SERVER_MESSAGE_TYPES: Final = (MSG_CONNECTED, MSG_DATA, MSG_ERROR, MSG_WARNING)
#: What this server accepts. `force_cleanup` joins this in TRA-1162, or does not.
CLIENT_MESSAGE_TYPES: Final = (MSG_DATA,)

#: The types that END the client's connect handshake, per ws-transport.ts:75-85.
#: `warning` is deliberately absent: ws-transport.ts:176-178 keeps waiting on one,
#: so treating it as terminal would break the handshake. This tuple is not
#: decoration -- test_handshake_terminal_types_match_the_typescript_waiter reads
#: the waiter out of the TypeScript and compares it against exactly this.
HANDSHAKE_TERMINAL_TYPES: Final = (MSG_CONNECTED, MSG_ERROR)

FIELD_TYPE: Final = "type"
FIELD_DEVICE: Final = "device"
FIELD_DATA: Final = "data"
FIELD_ERROR: Final = "error"
FIELD_WARNING: Final = "warning"

#: Verbatim from src/bridge-server.ts:84. A client may match on this string.
MISSING_PARAMS_ERROR: Final = "Missing required parameters: service, write, notify"

# --- Ownership, TRA-1159 ------------------------------------------------------
#
# These are the texts a client sees when the command path refuses it. Every one is
# a complete sentence naming what happened and what to do about it, because the
# whole point of the ticket is that the alternative -- a timeout, or a success
# against the wrong state -- reads as slowness or as correctness rather than as a
# refusal.

#: Prefix of the second-writer rejection; the holder's session is appended, because
#: "who has it" is the first question an operator asks. A client may match on this.
#: test_the_busy_error_is_not_one_the_mock_silently_retries is what keeps this text
#: from being quietly converted back into a retry loop by mock-bluetooth.ts.
BUSY_ERROR_PREFIX: Final = "Device is busy: the command path is owned by another connection"
BUSY_ERROR_ADVICE: Final = (
    "Connect with role=observer to read the notification stream without writing, "
    "or with force=true to take the command path over."
)
NOTHING_TO_OBSERVE_ERROR: Final = "Nothing to observe: no connection owns the command path"
NOT_READY_ERROR: Final = (
    "The command path is claimed but its device link is not up yet. This resolves "
    "in a moment; retry."
)
OBSERVER_MAY_NOT_WRITE_ERROR: Final = (
    "This connection attached with role=observer and may not write to the device. "
    "The frame was discarded and the stream is still open."
)
STREAM_ENDED_ERROR: Final = (
    "The connection that owned the command path has gone; this stream has ended"
)
#: Sent to the connection being displaced, then its socket is closed.
EVICTED_ERROR_PREFIX: Final = (
    "Evicted: another connection took the command path over with force=true"
)
#: Sent to the connection doing the displacing, BEFORE `connected`. Interstitial:
#: it announces a destructive act to the side that caused it, without ending the
#: handshake. See HANDSHAKE_TERMINAL_TYPES.
TAKEOVER_WARNING_PREFIX: Final = (
    "Took the command path over with force=true, evicting the connection that held it"
)
TAKEOVER_WARNING_ADVICE: Final = (
    "That connection's run is now invalid; say so wherever it is being watched."
)
#: The displaced connection would not let go, so the takeover was abandoned rather
#: than completed on top of a transport in an unknown state.
TAKEOVER_STALLED_ERROR: Final = (
    "Takeover abandoned: the connection holding the command path did not release "
    "its transport in time. The device link was left alone. Retry."
)


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


def encode_warning(message: str) -> str:
    """src/ws-handler.ts:148 -- non-fatal, and the client keeps waiting on one.

    Interstitial by contract: a warning may travel mid-handshake and must not
    settle it. See HANDSHAKE_TERMINAL_TYPES.
    """
    return json.dumps({FIELD_TYPE: MSG_WARNING, FIELD_WARNING: message})


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
        raise ProtocolError(f"{MSG_DATA} {FIELD_DATA!r} must be an array, got {type(raw).__name__}")
    try:
        return bytes(raw)
    except (ValueError, TypeError) as exc:
        raise ProtocolError(f"{MSG_DATA} {FIELD_DATA!r} is not a byte array: {exc}") from exc
