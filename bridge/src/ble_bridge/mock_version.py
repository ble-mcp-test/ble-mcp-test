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
"""

from __future__ import annotations

import json
import logging
from functools import cache
from pathlib import Path

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
