import json
import pathlib
import re

import pytest

from ble_bridge.ws import protocol as p


def test_connected_shape_matches_bridge_server_ts():
    """src/bridge-server.ts:145 -- {type, device}."""
    assert json.loads(p.encode_connected("CS108Reader")) == {
        "type": "connected",
        "device": "CS108Reader",
    }


def test_data_is_a_json_int_array_not_base64():
    """src/ws-handler.ts:85-88 sends Array.from(Uint8Array).

    This settles Open item 1 of the protocol spec, which marked the encoding
    [inferred] and asked for it to be confirmed before the port froze the format.
    """
    assert json.loads(p.encode_data(bytes([0xA7, 0x00, 0xFF]))) == {
        "type": "data",
        "data": [167, 0, 255],
    }


def test_error_shape():
    assert json.loads(p.encode_error("boom")) == {"type": "error", "error": "boom"}


def test_missing_params_text_is_verbatim():
    """src/bridge-server.ts:84. A client may match on this string."""
    assert p.MISSING_PARAMS_ERROR == "Missing required parameters: service, write, notify"


def test_data_payload_round_trips():
    raw = p.encode_data(bytes(range(20)))
    assert p.data_payload(p.decode(raw)) == bytes(range(20))


def test_decode_rejects_non_json():
    with pytest.raises(p.ProtocolError):
        p.decode("not json")


def test_decode_rejects_a_non_object():
    with pytest.raises(p.ProtocolError):
        p.decode("[1, 2, 3]")


def test_data_payload_rejects_out_of_range_bytes():
    with pytest.raises(p.ProtocolError):
        p.data_payload({"type": p.MSG_DATA, "data": [256]})


def test_data_payload_rejects_a_missing_field():
    with pytest.raises(p.ProtocolError):
        p.data_payload({"type": p.MSG_DATA})


def test_dropped_types_are_absent():
    """Spec section 5: dead on both ends, no sender, phantom, or not protocol at all."""
    dropped = {
        "cleanup_session",
        "session_cleanup_complete",
        "admin_cleanup",
        "admin_cleanup_complete",
        "cleanup_complete",
        "ack",
        "disconnected",
        "characteristicvaluechanged",
        "eviction_warning",
        "keepalive_ack",
        "scan_result",
        "notification",
    }
    implemented = set(p.SERVER_MESSAGE_TYPES) | set(p.CLIENT_MESSAGE_TYPES)
    assert dropped & implemented == set()


# Files permitted to contain message-type string literals, and why. Every entry
# is a file whose JOB is to pin the wire format against an external source, so
# importing the constant would make the assertion circular. Adding to this list
# is a deliberate act and shows up as a diff in review -- which is the point.
LITERAL_ALLOWLIST = {
    # Defines the names. Everything else imports from here.
    "src/ble_bridge/ws/protocol.py",
    # Transcribes the expected wire strings from the TypeScript source, citing
    # its line numbers. Checking protocol.py against itself would be a tautology.
    "tests/test_protocol.py",
    # Asserts the full frame a real client receives off the socket. This is the
    # end-to-end wire check; using the constants would only prove self-consistency.
    "tests/test_relay.py",
}


def test_no_message_type_literal_outside_protocol():
    """CLAUDE.md failure class 1, enforced mechanically rather than by eye.

    A waiter whose condition cannot be satisfied by what is actually sent fails as
    a TIMEOUT, so it reads as slowness rather than as a defect. Eyeballing missed
    that class four separate times in this codebase. One module owning every
    message name is what makes it structurally impossible; this test is what keeps
    that true as the tree grows.
    """
    root = pathlib.Path(__file__).resolve().parents[1]
    names = sorted(set(p.SERVER_MESSAGE_TYPES) | set(p.CLIENT_MESSAGE_TYPES))
    pattern = re.compile("|".join(rf"""["']{re.escape(n)}["']""" for n in names))

    offenders = []
    for path in sorted(root.rglob("*.py")):
        if any(part in {".venv", "__pycache__"} for part in path.parts):
            continue
        if path.relative_to(root).as_posix() in LITERAL_ALLOWLIST:
            continue
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            if pattern.search(line):
                offenders.append(f"{path.relative_to(root)}:{lineno}: {line.strip()}")

    assert offenders == [], (
        "Message-type string literals must appear only in protocol.py. Import the "
        "constant instead of retyping the name, or -- if this file's job is to pin "
        "the wire format against an external source -- add it to LITERAL_ALLOWLIST "
        "with a reason:\n" + "\n".join(offenders)
    )


def test_the_literal_allowlist_has_no_stale_entries():
    """An allowlist entry for a file that no longer exists is a hole nobody sees."""
    root = pathlib.Path(__file__).resolve().parents[1]
    missing = [entry for entry in sorted(LITERAL_ALLOWLIST) if not (root / entry).is_file()]
    assert missing == [], f"LITERAL_ALLOWLIST names files that do not exist: {missing}"
