"""The nine URL query parameters, parsed per src/bridge-server.ts:40-79.

Nine, not the five that circulated before the spec was written: `service`,
`write`, `notify`, `session`, `_mv`, `force`, `deviceId`, `deviceName`,
`timeout`.

Faithful to the TypeScript in every respect but one, flagged here and in the PR:
an unparseable `timeout` raises rather than becoming NaN. `parseInt('abc', 10)`
yields NaN in JavaScript and passes it down to the transport unremarked, which is
CLAUDE.md's second failure class -- a value that is present, wrong, and silently
ignored succeeds against the wrong input, so it looks like correctness and
nothing is even slow.

UUIDs are passed through unnormalised, matching bridge-server.ts:88-92 and its
comment saying the transport will handle the variants. TRA-1158 owns
normalisation; doing it here as well would put two normalisers in the tree that
could disagree.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit

from ble_bridge.ws.protocol import MISSING_PARAMS_ERROR

#: Sent by the mock as a version marker. Observation, never negotiation.
MOCK_VERSION_PARAM = "_mv"


class MissingParametersError(ValueError):
    """One of service / write / notify was absent or blank."""


class InvalidParameterError(ValueError):
    """A parameter was present but could not be used."""


def uuid4_str() -> str:
    return str(uuid.uuid4())


@dataclass(frozen=True)
class ConnectionParams:
    service: str
    write: str
    notify: str
    session: str
    #: Whether the client supplied `session`, or this one was generated for it.
    session_was_provided: bool
    mock_version: str | None
    force: bool
    device_id: str | None
    device_name: str | None
    timeout: int | None


def parse_params(
    path_or_query: str,
    *,
    session_factory: Callable[[], str] = uuid4_str,
) -> ConnectionParams:
    """Parse a request path or bare query string into connection parameters.

    Raises MissingParametersError if any of service / write / notify is absent
    or blank, and InvalidParameterError if a present value cannot be used.
    """
    split = urlsplit(path_or_query)
    query = split.query or (path_or_query if not split.path.startswith("/") else "")
    raw = parse_qs(query, keep_blank_values=True)

    def one(key: str) -> str | None:
        """First occurrence, matching URLSearchParams.get()."""
        values = raw.get(key)
        return values[0] if values else None

    # `url.searchParams.get(k) || ''` followed by a falsy check, so blank counts
    # as absent exactly as it does in the TypeScript.
    service = one("service") or ""
    write = one("write") or ""
    notify = one("notify") or ""
    if not service or not write or not notify:
        raise MissingParametersError(MISSING_PARAMS_ERROR)

    session = one("session")

    raw_timeout = one("timeout")
    if not raw_timeout:
        timeout = None
    else:
        try:
            timeout = int(raw_timeout)
        except ValueError as exc:
            raise InvalidParameterError(
                f"timeout is set to {raw_timeout!r}, which is not an integer. "
                "Refusing to pass an unusable timeout to the transport."
            ) from exc

    return ConnectionParams(
        service=service,
        write=write,
        notify=notify,
        session=session or session_factory(),
        session_was_provided=bool(session),
        mock_version=one(MOCK_VERSION_PARAM) or None,
        # bridge-server.ts:59 -- `=== 'true'`. Any other value is falsy.
        force=one("force") == "true",
        device_id=one("deviceId") or None,
        device_name=one("deviceName") or None,
        timeout=timeout,
    )
