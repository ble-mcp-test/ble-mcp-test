"""Who this process is, and what code it is running.

Two questions consumers were answering by reaching past the contract into the
daemon's internals -- one into systemd (`NRestarts`, `MainPID`, the unit name),
one into `/proc/<pid>/cwd` plus `git log`. Co-location made those possible; it
never made them correct, and TRA-1202 already plans a second bridge on a
container where neither workaround holds.

## `INSTANCE_ID` -- am I still talking to the same process

Minted at import, so once per interpreter. Module level rather than a
`ControlServer` argument on purpose: two servers in one process are one process
and must report one id. A constructor default of `uuid4()` would let them
disagree, which is a lie about what the field means.

**It does not subsume `uptime_seconds`. The two are a pair, and a consumer that
deletes its elapsed-time check loses something.** `time.monotonic()` reads
`clock_gettime(CLOCK_MONOTONIC)` on this platform -- checked directly rather than
assumed, via `time.get_clock_info('monotonic')`. CLOCK_MONOTONIC is documented not
to advance while the host is suspended (CLOCK_BOOTTIME is the one that does); that
is a kernel property taken from its documentation, not something measured here.
The consequence is what matters: suspend the box for an hour and `INSTANCE_ID` is
unchanged while an hour of wall clock passed that the run did not experience.

    INSTANCE_ID       -- is this a DIFFERENT PROCESS
    uptime_seconds    -- has this process been running for the WHOLE INTERVAL
                         I have been measuring

A restart moves both. A suspend moves only the second. A run measuring evidence
continuity needs both, so neither field supersedes the other.

There is a weaker asymmetry worth keeping too: this id is a value the daemon
CHOOSES and could be wrong about, while uptime derives from a clock it does not
control. Two records, one unauthorable by the subject.

## `CODE_FINGERPRINT` -- is this process running current code

Computed at import, from the files on disk at that moment, so it names the code
this process LOADED rather than the code in the tree now. That is the whole point:
a consumer compares it against a fresh fingerprint of the same tree, and a
difference means the daemon predates the code and would have answered the run
without saying so.

`status.version` cannot answer this, even now that it moves rather than sitting
frozen at "0.1.0". A release number moves on release and code moves on merge, so
two daemons at the same released version can be serving different code -- which is
the 2026-08-28 incident exactly, where a daemon had to be killed before publishing
because it was serving pre-merge code and nothing in `status` could say so.

**Why a content hash rather than a git commit.** A commit sha does not move for an
uncommitted edit, so it reports a clean identity for dirty code -- a silent
fallback that looks like configuration, which is one of this repo's two named
failure classes. It also needs `git` at runtime and a checkout to be in, neither
of which a container image has. The hash needs nothing, and it cannot be clean
about dirty code.

**Why `SOURCE_ROOT` is published alongside it.** A consumer has to fingerprint the
same tree to compare. Judging a daemon against the CURRENT tree instead of its own
reports a perfectly current daemon as stale the moment a worktree commits to
`bridge/` -- the wrong denominator presenting as a stale daemon. Publishing the
root is how the contract stops a consumer picking the wrong one, and it is what
lets them stop reading `/proc/<pid>/cwd` to find it.
"""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
from typing import Final

#: Bytecode is written by the running process. Counting it would let a daemon's
#: own execution change the answer to "what code am I running".
_SKIP_DIRS: Final = frozenset({"__pycache__"})

#: Enough that a collision is irrelevant at this scale, short enough to read in a
#: log line next to a uuid.
_FINGERPRINT_CHARS: Final = 16


def source_fingerprint(root: str | Path) -> str:
    """A hash of every `.py` file under `root`, as it is on disk right now.

    The algorithm, stated in full so a consumer in another language can reproduce
    it exactly:

    1. walk `root` recursively, skipping any directory named `__pycache__`
    2. keep files whose name ends `.py`
    3. sort them by their POSIX-style path relative to `root`
    4. for each, feed the hash: the relative path as UTF-8, a NUL, the file's
       bytes, a NUL
    5. take the first 16 characters of the sha256 hex digest

    The relative path is hashed as well as the content, so a **rename** moves the
    fingerprint. Hashing content alone would call a renamed tree identical.

    It is written out rather than left to be read off the code because two
    implementations that disagree produce a permanent false STALE -- and the
    natural fix for persistent noise is to loosen the check, which is how the
    guard stops working. In Python, import this rather than reimplementing it.

    Raises `FileNotFoundError` when `root` is not a directory. "I could not look"
    must not be representable as a fingerprint: a sentinel would either compare
    unequal to everything and read as permanent staleness, or -- worse -- compare
    equal to another failure and read as agreement.
    """
    base = Path(root)
    if not base.is_dir():
        raise FileNotFoundError(f"cannot fingerprint {base}: not a directory")

    files = sorted(
        (p for p in base.rglob("*.py") if not _SKIP_DIRS & set(p.relative_to(base).parts)),
        key=lambda p: p.relative_to(base).as_posix(),
    )

    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(base).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:_FINGERPRINT_CHARS]


#: This interpreter, for as long as it lives. Different after any restart.
INSTANCE_ID: Final[str] = uuid.uuid4().hex

#: The directory that was fingerprinted -- the installed package. Under the
#: editable install this box uses that is `<checkout>/bridge/src/ble_bridge`,
#: which is literally what the interpreter imports.
SOURCE_ROOT: Final[str] = str(Path(__file__).resolve().parent)

#: Captured at import, so it names the code this process loaded rather than
#: whatever happens to be on disk by the time someone asks.
CODE_FINGERPRINT: Final[str] = source_fingerprint(SOURCE_ROOT)
