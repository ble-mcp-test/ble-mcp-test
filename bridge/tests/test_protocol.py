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


def test_warning_shape_matches_ws_handler_ts():
    """src/ws-handler.ts:148 -- {type, warning}."""
    assert json.loads(p.encode_warning("careful")) == {"type": "warning", "warning": "careful"}


def test_warning_is_not_a_handshake_terminal_type():
    """Spec section 2: the client's handling is explicitly "Continue waiting for
    completion". A port that treated it as terminal would break the handshake."""
    assert p.MSG_WARNING not in p.HANDSHAKE_TERMINAL_TYPES


def test_handshake_terminal_types_match_the_typescript_waiter():
    """CLAUDE.md failure class 1, checked mechanically rather than by eye.

    The connect() promise in src/ws-transport.ts settles on a fixed set of message
    types. If this server emits a type expecting it to end a handshake, or stops
    emitting one the client waits for, the mismatch surfaces as a TIMEOUT -- which
    reads as slowness rather than as a defect, and eyeballing missed exactly that
    four separate times here. Reading the waiter out of the client source and
    comparing it against this module is what makes the mismatch impossible.
    """
    branches = _connect_branches()
    assert branches, "found no message-type comparison in connect(); the check would be vacuous"

    terminal = {t for t, settles in branches.items() if settles}
    assert terminal == set(p.HANDSHAKE_TERMINAL_TYPES)


def test_warning_is_branched_on_but_does_not_settle_the_handshake():
    """TRA-1162: the interstitial contract, checked on the client rather than asserted.

    `warning` travels mid-handshake -- server.py's _take_over sends it immediately
    before `connected` to tell a client it displaced somebody. Two ways to get this
    wrong, and this test fails on both: dropping the branch (the announcement is
    swallowed, which is what the client did until TRA-1162) or letting it settle
    the promise (the handshake ends on a non-terminal frame).

    Note it must NOT be added to HANDSHAKE_TERMINAL_TYPES to make the sibling test
    above pass. That is the tempting fix and it is the wrong one.
    """
    branches = _connect_branches()
    assert p.MSG_WARNING in branches, (
        "connect() no longer branches on `warning`; a mid-handshake takeover warning "
        "is being dropped silently again. See ws-transport.ts."
    )
    assert not branches[p.MSG_WARNING], "`warning` must not settle the handshake"


# Types this server emits AHEAD of any client consuming them, and the ticket that
# will consume each. An entry here is a deliberate, temporary hole in
# test_wire_types_have_a_typescript_consumer -- so that assertion is an EXACT match
# rather than a subtraction: the moment a consumer lands, the stale entry fails and
# has to be removed. A hole that cannot go stale silently is the only kind worth
# having, and this is the shape spec section 3b calls the dangerous one.
AWAITING_CONSUMER = {
    "write_ack": "TRA-1187 items 3 & 4 decide which writeValue() consumes it",
}


def test_wire_types_have_a_typescript_consumer():
    """Every type this server emits must be handled somewhere in the mock client.

    The inverse of the waiter check. A type with no consumer is the shape TRA-1162
    called the dangerous direction: a lone unconsumed emitter looks like unused
    code while actually being a silent failure path. After TRA-1155 there is no
    compiler spanning this seam -- Python emits, TypeScript consumes -- so a rename
    on either side surfaces as behaviour quietly going missing.

    Both consumer sites count, deliberately. `warning` is handled in connect() for
    the mid-handshake case and in mock-bluetooth.ts for the post-handshake case;
    checking only the first would go green while the second still dropped it.
    """
    consumed = set(_connect_branches()) | _mock_bluetooth_branches()
    missing = set(p.SERVER_MESSAGE_TYPES) - consumed
    assert missing == set(AWAITING_CONSUMER), (
        f"this server emits {sorted(missing)} and the TypeScript client branches on "
        "none of them, so the message is delivered and silently discarded. If that is "
        "deliberate and temporary, name it in AWAITING_CONSUMER with the ticket that "
        "will consume it."
    )


def _connect_branches() -> dict[str, bool]:
    """Every `msg.type === 'x'` in connect(), mapped to whether that branch settles.

    A branch settles if it calls resolve() or reject(); anything else is
    interstitial. Splitting on the comparisons rather than eyeballing is the point
    -- "is branched on" and "ends the handshake" are different questions, and
    conflating them is what made this check reject a correct interstitial branch.
    """
    body = _ws_transport_connect_body()
    hits = list(re.finditer(r"""msg\.type === ['"]([a-z_]+)['"]""", body))
    branches: dict[str, bool] = {}
    for i, hit in enumerate(hits):
        end = hits[i + 1].start() if i + 1 < len(hits) else len(body)
        segment = body[hit.end() : end]
        branches[hit.group(1)] = "resolve()" in segment or "reject(" in segment
    return branches


def _mock_bluetooth_branches() -> set[str]:
    """Message types handled by the mock's steady-state transport handler."""
    root = pathlib.Path(__file__).resolve().parents[2]
    source = root / "src" / "mock-bluetooth.ts"
    assert source.is_file(), (
        f"{source} is missing. It is the post-handshake half of this protocol's "
        "client. If the mock has moved, point this check at its successor."
    )
    text = source.read_text()
    start = text.index("private setupTransportHandler()")
    body = text[start : text.index("\n  }", text.index("this.transport.onMessage", start))]
    return set(re.findall(r"""msg\.type === ['"]([a-z_]+)['"]""", body))


def _ws_transport_connect_body() -> str:
    """The body of WebSocketTransport.connect(), read from the TypeScript client.

    Deliberately a hard failure rather than a skip when the file is gone. The TS
    bridge is frozen and slated for retirement; when it is deleted this must make
    somebody decide what replaces the check, rather than passing silently.
    """
    root = pathlib.Path(__file__).resolve().parents[2]
    source = root / "src" / "ws-transport.ts"
    assert source.is_file(), (
        f"{source} is missing. It is the client-side waiter this server's handshake "
        "is checked against. If the TypeScript bridge has been retired, point this "
        "check at its successor -- do not delete it."
    )
    text = source.read_text()
    start = text.index("async connect(")
    return text[start : text.index("\n  send(", start)]


def test_error_shape():
    assert json.loads(p.encode_error("boom", p.ERR_NOT_READY)) == {
        "type": "error",
        "error": "boom",
        "code": "NOT_READY",
    }


def test_encode_error_refuses_a_code_outside_the_closed_set():
    """A typo must be a crash here, not an unrecognised code on the wire.

    An unknown code reaches the client as something not in
    RETRYABLE_CONNECT_CODES, so a refusal meant to be retryable silently stops
    being retried -- the absence-shaped failure this whole change removed.
    """
    with pytest.raises(ValueError, match="unknown error code"):
        p.encode_error("boom", "NOT_A_REAL_CODE")


def test_no_error_code_is_declared_without_being_reachable():
    """Every code in the closed set is one some call site can actually send.

    The mirror of the client-side check: a code nothing emits is a branch the
    client can never take, which is the same dead-condition class one layer over.
    """
    server = (pathlib.Path(__file__).resolve().parents[1]
              / "src" / "ble_bridge" / "ws" / "server.py").read_text()
    ownership = (pathlib.Path(__file__).resolve().parents[1]
                 / "src" / "ble_bridge" / "ws" / "ownership.py").read_text()
    params = (pathlib.Path(__file__).resolve().parents[1]
              / "src" / "ble_bridge" / "ws" / "params.py").read_text()
    reachable = server + ownership + params
    orphans = [
        code for code in p.ERROR_CODES
        # by constant name (p.ERR_FOO) or by literal (params.py uses the literal)
        if f"ERR_{code}" not in reachable and f'"{code}"' not in reachable
    ]
    assert orphans == [], (
        f"declared but never sent: {orphans}. A code no call site emits is a "
        "client branch that can never be taken."
    )


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


# --- write_ack, TRA-1153 item 5b ----------------------------------------------


def test_write_ack_shape():
    """The tenth wire message. Spec section 8."""
    assert json.loads(p.encode_write_ack(True, mode="with-response")) == {
        "type": "write_ack",
        "ok": True,
        "mode": "with-response",
    }


def test_write_ack_echoes_the_clients_write_id():
    decoded = json.loads(p.encode_write_ack(True, mode="with-response", write_id="w-7"))
    assert decoded["write_id"] == "w-7"


def test_write_ack_omits_write_id_when_the_client_sent_none():
    """Absent, not null: a client cannot tell an echoed null from a missing echo."""
    assert "write_id" not in json.loads(p.encode_write_ack(True, mode="with-response"))


def test_a_failed_write_ack_carries_the_reason():
    decoded = json.loads(
        p.encode_write_ack(False, mode="with-response", error="the proxy went away")
    )
    assert decoded["ok"] is False
    assert decoded["error"] == "the proxy went away"


def test_write_ack_omits_error_when_the_write_succeeded():
    assert "error" not in json.loads(p.encode_write_ack(True, mode="with-response"))


def test_write_ack_never_uses_the_field_name_id():
    """The field is `write_id`, never `id`.

    ORIGINALLY this test read the hazard back out of `src/node/NodeBleClient.ts`, which
    dispatched on `msg.id` BEFORE it looked at `msg.type` and deleted the handler it
    dispatched to: an ack carrying `id` that collided with a pending request id would
    resolve the wrong request AND drop the real response -- a hang that mentions nothing
    about writes. That client was deleted by TRA-1187 item 4 (0.9.0), so the specific
    hazard is gone and the read-back is no longer possible.

    The old failure message said the constraint could then be revisited "deliberately,
    not by deleting this check." REVISITED 2026-08-28, and the answer is KEEP:

    - `write_id` is on the wire and implemented in the bridge. Renaming it would be a
      protocol break that buys nothing.
    - A correlation token distinct from a transport-level message id is the right shape
      independent of which client reads it. The Node client's dispatch order made the
      collision catastrophic; it was never what made a shared name wrong.

    So this is now a plain invariant on the encoder rather than a two-sided guard. It
    still goes red if the bridge starts emitting `id`.
    """
    for frame in (
        p.encode_write_ack(True, mode="with-response"),
        p.encode_write_ack(False, mode="without-response", write_id="w-1", error="boom"),
    ):
        assert "id" not in json.loads(frame)


def test_write_id_reads_back_out_of_a_data_frame():
    assert p.write_id({"type": p.MSG_DATA, "data": [1], "write_id": "w-3"}) == "w-3"
    assert p.write_id({"type": p.MSG_DATA, "data": [1]}) is None


def test_write_ack_is_a_server_message_type():
    assert p.MSG_WRITE_ACK in p.SERVER_MESSAGE_TYPES
    assert p.MSG_WRITE_ACK not in p.CLIENT_MESSAGE_TYPES


def test_awaiting_consumer_entries_are_still_unconsumed():
    """The self-clearing half of the exemption. Red when a consumer lands and the
    entry stays behind -- at which point the hole is one nobody sees."""
    consumed = set(_connect_branches()) | _mock_bluetooth_branches()
    stale = sorted(set(AWAITING_CONSUMER) & consumed)
    assert stale == [], (
        f"{stale} now HAS a TypeScript consumer, so its exemption from "
        "test_wire_types_have_a_typescript_consumer is a hole nobody sees. Remove it "
        "from AWAITING_CONSUMER."
    )


def test_awaiting_consumer_names_only_types_this_server_emits():
    unknown = sorted(set(AWAITING_CONSUMER) - set(p.SERVER_MESSAGE_TYPES))
    assert unknown == [], f"AWAITING_CONSUMER names types this server never sends: {unknown}"
