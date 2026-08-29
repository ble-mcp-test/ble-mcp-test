"""Resolving the mock version that `_mv` is compared against.

`_mv` carries the version of the **npm** package the browser mock ships in --
`ws-transport.ts:50-61` sets it from the package version, and `bridge-server.ts`
compares it against `getPackageMetadata().version`. So the number to compare
against is the one in package.json, and this module reads it from there.

**The reason is the source, not the value.** This used to say the npm version is
"a different number" from `ble_bridge.__version__`, which was true while the
Python package sat frozen at 0.1.0 and is false since TRA-1204 generated both
from package.json. A justification that rests on what a value currently reads
expires when the value changes, and it expires in the worst way: the next reader
checks the stated reason, finds it no longer holds, and discards a conclusion
that is still correct. What survives is that `_mv` is a claim about the npm
package, so it is answered from the npm package's own metadata.

A warning that fires on every healthy connection is worse than no warning: it
trains the reader to ignore the line, and the one real mismatch then goes by
unremarked. So when the npm version cannot be resolved, the comparison is
skipped and said to be skipped, rather than guessed at.

## Why the log line was not enough (TRA-1211)

TRA-1200's 150-rep hardware measurement ran browser mock 0.12.0 against bridge
0.13.0. The warning below fired 150 times, nothing consumed it, and the run was
analysed before anyone knew. `MockVersionWatch` exists so the same observation
is also readable over MCP -- the bridge reports the fact, and the consumer
decides what is fatal. It deliberately does not reject: the bridge can see THAT
the versions differ, but whether the difference matters is semantic, and on the
evidence of those 150 reps 0.12 against 0.13 was fully functional. A hard reject
would make every routine bump on either side an outage for a tool whose primary
job is availability.
"""

from __future__ import annotations

import json
import logging
from functools import cache
from pathlib import Path
from typing import Any

from ble_bridge.ws.params import MOCK_VERSION_PARAM

logger = logging.getLogger(__name__)


@cache
def expected_mock_version() -> str | None:
    """The npm package version, or None if it cannot be read.

    Read from the repository's package.json. This is package metadata, not
    configuration -- the environment-only rule in the layout doc is about
    settings an operator chooses, and this is neither chosen nor settable.
    """
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "package.json"
        if candidate.is_file():
            try:
                version = json.loads(candidate.read_text()).get("version")
            except (OSError, ValueError) as exc:
                logger.debug("could not read %s: %s", candidate, exc)
                return None
            if isinstance(version, str) and version:
                return version
            return None
    return None


def compare(observed: str | None, expected: str | None) -> bool | None:
    """Did the two versions agree? `None` means the question could not be asked.

    The three-valued return is the whole point of the ticket, and it is defined
    once here because two callers depend on the same predicate: the counter
    increments exactly where this says `False`, and `report` publishes exactly
    what this says. Two hand-written copies of "both known and differing" would
    be free to drift, and the drift would present as a counter that disagrees
    with the snapshot beside it -- with nothing to say which one was lying.

    `False` means "checked, and they differ". It must never mean "could not
    check": a consumer that cannot tell those apart is back where TRA-1200
    started, reading a field that said nothing and believing it said no.
    """
    if observed is None or expected is None:
        return None
    return observed == expected


class MockVersionWatch:
    """Every connection's `_mv`, as a log line, a snapshot, and a counter.

    One instance per bridge process, built by `BridgeServer` and handed to
    `ControlServer` -- never constructed separately at each end. A second
    instance would count perfectly and report zero, which is indistinguishable
    from a healthy fleet.
    """

    def __init__(self) -> None:
        self._mismatches = 0

    @property
    def mismatches(self) -> int:
        """Connections seen with a version that differs from ours, for the life
        of this process. Monotonic, and reset by nothing short of a restart.

        This is the field a soak watchdog keys on, and the reason is poll
        timing. Between test repetitions the command path reads `held: false`,
        so with ~27s reps against a 300s poll most samples land in a gap where
        the snapshot is legitimately null: it is only unmissable if you happen
        to sample mid-rep. A counter cannot be missed -- baseline at the start,
        compare each poll, abort if it moved. The same idiom as
        `systemctl show -p NRestarts` for the daemon itself.
        """
        return self._mismatches

    def observe(self, mock_version: str | None) -> None:
        """Record one connection. Telemetry only.

        The spec is explicit that every outcome here is server-side: no message
        is sent to the client, nothing is rejected, no behaviour changes. `_mv`
        is version *observation*, not negotiation, and porting it as negotiation
        would invent a mechanism that has never existed. If real negotiation is
        wanted it should be designed rather than inherited -- and it would have
        to key on a protocol version, not on the npm package version, or every
        routine bump becomes an outage.

        Counted once per connection rather than once per packet: a per-packet
        counter would be an activity measure wearing a version check's name.
        """
        if mock_version is None:
            logger.warning(
                "WebSocket connection with no %s: this client is bypassing the Web Bluetooth "
                "mock and connecting directly. It should be using injectWebBluetoothMock(). "
                "See README.md.",
                MOCK_VERSION_PARAM,
            )
            return

        expected = expected_mock_version()
        matched = compare(mock_version, expected)
        if matched is None:
            logger.debug(
                "cannot compare %s=%s: the npm package version could not be resolved",
                MOCK_VERSION_PARAM,
                mock_version,
            )
        elif not matched:
            self._mismatches += 1
            logger.warning(
                "mock version mismatch: expected %s, got %s",
                expected,
                mock_version,
            )

    def report(self, observed: str | None) -> dict[str, Any]:
        """The three fields `get_connection_state` publishes, for one version.

        `observed` is the command-path holder's `_mv`, or None when nothing
        holds it. Scoped to the holder deliberately: an observer's stale mock
        must not be attributed to the writer that is actually driving the
        device.
        """
        expected = expected_mock_version()
        return {
            "mock_version": observed,
            "mock_version_expected": expected,
            "mock_version_match": compare(observed, expected),
        }
