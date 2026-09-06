"""Shared fixtures for the bridge suite.

Currently one job: keep temporary paths short enough to bind an AF_UNIX socket.

## Why `tmp_path` is overridden rather than a socket-specific fixture added

`sun_path` is a **fixed-size char array**, not a pointer: 104 bytes on
macOS/BSD, 108 on Linux, NUL included. pytest's own `tmp_path` is built under
`tempfile.gettempdir()`, and on macOS that is `$TMPDIR` —
`/private/var/folders/<2>/<28>/T/` — so a per-test directory reaches ~112 bytes
before a filename is added. Every `bind()` in this suite then fails with
`OSError: AF_UNIX path too long`, and on cheetah that was 58 errors and 8
failures, roughly a fifth of the suite (TRA-1257).

The same construction on Linux `/tmp` lands around 67 bytes, comfortably inside
108. **So the defect is invisible on the host that runs the gate**, which is this
ticket's recurring shape: a check whose outcome depends on which box ran it.

Overriding `tmp_path` is the blunt option and it is chosen deliberately over
adding a `sock_dir` fixture and editing the ~30 call sites that build a socket
path. Those edits would fix today's tests and leave the next
`tmp_path / "new.sock"` free to re-break it, on a host nobody here runs. Making
the short path the DEFAULT means a new socket test cannot get this wrong — a
mechanism rather than a comment.

What is given up: `--basetemp` and pytest's keep-the-last-three-runs retention,
neither of which anything in this repo uses.

## The guard

`assert_bindable` is exported so a test can hold the invariant mechanically
rather than by trusting the arithmetic above.

⚠ A length assertion alone does NOT catch this from Linux: the stock `tmp_path`
is already short there, so it passes before and after the fix. The test that
discriminates is the one that hands a macOS-shaped `$TMPDIR` to
`make_short_tmp_dir` and requires the result to stay short --
`test_socket_paths.py::test_a_macos_shaped_tmpdir_does_not_reach_the_fixture`.
That is why the construction is exported as a function rather than living inside
the fixture where nothing could call it with a chosen environment.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest

#: The tightest `sun_path` limit across the platforms this repo runs on:
#: 104 on macOS/BSD, 108 on Linux. Take the smaller, and count the NUL.
SUN_PATH_MAX = 104

#: Where short temporary directories are made. `/tmp` rather than
#: `tempfile.gettempdir()` precisely BECAUSE gettempdir() is the problem on
#: macOS -- it returns the deep `$TMPDIR`. `/tmp` exists on every platform this
#: suite supports and resolves to `/private/tmp` on macOS, which is still short.
#:
#: It is resolved rather than used literally, because on macOS `/tmp` is a
#: SYMLINK to `/private/tmp`. Any code under test that canonicalises a path it
#: was handed then gets a string the test never built, and compares unequal --
#: `test_startup.py::test_loads_env_local_from_a_parent_directory` failed on
#: exactly that. Resolving here costs 8 bytes of the length budget and nothing
#: on Linux, where `/tmp` is already real.
SHORT_TMP_ROOT = os.path.realpath("/tmp")


def assert_bindable(path: str | Path) -> Path:
    """Fail with a legible message rather than an `OSError` from deep in asyncio.

    `AF_UNIX path too long` surfaces at `bind()`, inside whatever coroutine
    happened to open the socket, and names neither the limit nor the offending
    path. Checking here turns it into a sentence.
    """
    path = Path(path)
    length = len(str(path).encode())
    if length >= SUN_PATH_MAX:
        raise AssertionError(
            f"socket path is {length} bytes, and sun_path holds {SUN_PATH_MAX} "
            f"including the NUL: {path}\n"
            "This fails on macOS and passes on Linux, so it will look like a "
            "host quirk. It is not: shorten the path."
        )
    return path


def make_short_tmp_dir(hint: str) -> Path:
    """A fresh temporary directory under `SHORT_TMP_ROOT`, whatever `$TMPDIR` says.

    Ignoring `$TMPDIR` is the entire behaviour, not an oversight: `$TMPDIR` is
    what `tempfile` consults, and on macOS it is the deep path that overflows
    `sun_path`. Exported separately from the fixture so the discriminating test
    can call it with a macOS-shaped `$TMPDIR` on any platform.
    """
    # The hint is only for legibility when a test is inspected mid-run; it is
    # truncated hard, because the whole point here is the length budget.
    safe = "".join(c if c.isalnum() else "-" for c in hint)[:16]
    return Path(tempfile.mkdtemp(dir=SHORT_TMP_ROOT, prefix=f"ble-{safe}-"))


@pytest.fixture
def tmp_path(request) -> Path:
    """pytest's `tmp_path`, moved somewhere a socket can actually be bound.

    Same contract as the builtin -- a fresh, empty, per-test directory -- with a
    name short enough that `<dir>/<something>.sock` fits in `sun_path` on every
    supported platform.
    """
    path = make_short_tmp_dir(request.node.name)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)
