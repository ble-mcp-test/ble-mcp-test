"""Every socket this suite binds has to fit in `sun_path`.

TRA-1257. On macOS `$TMPDIR` is `/private/var/folders/<2>/<28>/T/`, so pytest's
stock `tmp_path` reaches ~112 bytes before a filename — past the 104-byte
`sun_path` array — and every `bind()` in the suite fails with
`OSError: AF_UNIX path too long`. Measured on cheetah: 58 errors and 8 failures,
about a fifth of the suite. The identical construction on Linux `/tmp` is ~67
bytes against a 108-byte limit, so **the defect is unreachable from the host that
runs the gate**.

That asymmetry is what these tests are for -- but only ONE of them earns its
keep from Linux, and it is worth being precise about which.

The length assertions below pass on Linux **before and after** the fix, because
the stock `tmp_path` is already short there. They pin the invariant; they do not
discriminate. `test_a_macos_shaped_tmpdir_does_not_reach_the_fixture` is the one
that goes red against the old construction on any platform, by handing it the
`$TMPDIR` macOS actually has. Asking "which of these could have failed before the
fix?" is the only thing that separates the two.

⚠ Do not "fix" a future length failure by raising SUN_PATH_MAX. It is not a
policy this repo sets — it is `sizeof(struct sockaddr_un.sun_path)` in the
kernel, and the smaller of the two platforms is the one that binds.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import socket
import tempfile
from pathlib import Path

import pytest

from tests.conftest import (
    SHORT_TMP_ROOT,
    SUN_PATH_MAX,
    assert_bindable,
    make_short_tmp_dir,
)

#: What `$TMPDIR` looks like on macOS: `/private/var/folders/<2>/<28>/T/`.
MACOS_SHAPED_TMPDIR = "/private/var/folders/ab/" + "c" * 28 + "/T"


def test_the_limit_is_the_smaller_of_the_two_platforms():
    # 104 on macOS/BSD, 108 on Linux. Taking the larger would make this suite
    # pass on Linux and fail on macOS, which is the whole failure being fixed.
    assert SUN_PATH_MAX == 104


def test_tmp_path_leaves_room_for_a_socket_name(tmp_path):
    """The fixture's own output, checked rather than reasoned about."""
    assert_bindable(tmp_path / "some-reasonably-named.sock")


def test_tmp_path_is_not_under_the_deep_macos_tmpdir(tmp_path):
    # The specific thing that went wrong: gettempdir() is the problem on macOS,
    # so the fixture must not be built on it.
    assert str(tmp_path).startswith(SHORT_TMP_ROOT)


def test_tmp_path_is_already_canonical(tmp_path):
    """The fixture must hand out a path that survives being resolved.

    ⚠ Found by cheetah, not here, and **this test cannot fail on Linux** --
    `/tmp` is already a real directory, so the two strings are equal before and
    after the fix. It is the macOS guard, and it is written down because the
    first version of this file had nine checks that discriminated nothing and
    said so only after being asked.

    On macOS `/tmp` is a SYMLINK to `/private/tmp`. The fixture handed out
    `/tmp/ble-.../repo`, code under test canonicalised what it was given and
    returned `/private/tmp/ble-.../repo`, and the compare failed on a string the
    test never built -- same directory, different name.
    `test_startup.py::test_loads_env_local_from_a_parent_directory` was green on
    main and red on the fix that was supposed to help it.

    The conftest comment had ALREADY noticed the symlink and reasoned only about
    its length: "resolves to /private/tmp on macOS, which is still short." True,
    and the wrong question.
    """
    assert Path(os.path.realpath(tmp_path)) == tmp_path


def test_tmp_path_is_fresh_and_per_test(tmp_path):
    """Overriding a builtin fixture is only safe if it keeps the contract."""
    assert tmp_path.is_dir()
    assert list(tmp_path.iterdir()) == []


def test_a_second_test_gets_a_different_directory(tmp_path):
    marker = tmp_path / "marker"
    marker.write_text("x")
    # If two tests shared a directory this would already exist from above.
    assert marker.read_text() == "x"


def test_assert_bindable_rejects_an_over_long_path():
    # The guard must be able to go red, or it is asserting a coincidence.
    too_long = Path("/tmp") / ("x" * SUN_PATH_MAX)
    with pytest.raises(AssertionError, match="sun_path"):
        assert_bindable(too_long)


def test_assert_bindable_counts_bytes_rather_than_characters():
    # sun_path is a byte array. A path measured in characters would pass here and
    # fail at bind() on any non-ASCII directory name.
    name = "é" * 60  # 120 bytes in UTF-8, 60 characters
    with pytest.raises(AssertionError, match="sun_path"):
        assert_bindable(Path("/tmp") / name)


def test_the_limit_agrees_with_what_the_kernel_actually_does(tmp_path):
    """The arithmetic, checked against a real bind on this host.

    This is the positive control. Everything above compares numbers to numbers
    and would pass just as well if `SUN_PATH_MAX` were fiction; this one asks the
    kernel. It cannot fail on Linux for a path that fits macOS's smaller limit,
    which is exactly the point -- a passing run here means the budget is real.
    """
    path = assert_bindable(tmp_path / "probe.sock")
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.bind(str(path))
    finally:
        sock.close()
    assert path.exists()


async def test_asyncio_can_serve_on_a_path_from_this_fixture(tmp_path):
    """The shape the suite actually uses, end to end."""
    path = assert_bindable(tmp_path / "served.sock")
    server = await asyncio.start_unix_server(lambda r, w: None, path=str(path))
    try:
        assert path.exists()
    finally:
        server.close()
        await server.wait_closed()


def test_a_macos_shaped_tmpdir_does_not_reach_the_fixture(monkeypatch, tmp_path):
    """THE discriminating test. Everything else here passes before the fix too.

    pytest's stock `tmp_path` is built under `tempfile.gettempdir()`, which is
    `$TMPDIR`. Give it macOS's `$TMPDIR` and the result overflows `sun_path`;
    that is the whole bug, and it is reproducible on Linux the moment the
    environment is the variable rather than the host.

    `tempfile.tempdir` is a module-level cache populated on first use, so it has
    to be cleared or the monkeypatched `$TMPDIR` is simply ignored -- which would
    make this test pass for the wrong reason.
    """
    # The simulated $TMPDIR has to EXIST. `gettempdir()` validates each candidate
    # by writing to it and silently falls through to /tmp when it cannot -- so
    # pointing it at a macOS path that is absent on Linux makes this test pass
    # while exercising nothing at all. Caught by the control below, which is the
    # only reason it is not still doing that.
    # Deep enough that the stock construction overflows, which is the property
    # being reproduced. Not a character-for-character copy of macOS's $TMPDIR --
    # `MACOS_SHAPED_TMPDIR` above records that shape; what matters here is the
    # budget, and control 2 below is what actually holds it.
    deep = Path(SHORT_TMP_ROOT) / ("d" * 20) / ("e" * 20) / ("f" * 20) / "T"
    deep.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("TMPDIR", str(deep))
    monkeypatch.setattr(tempfile, "tempdir", None)

    # Control 1: the simulation actually took. Without this the rest is vacuous.
    assert tempfile.gettempdir() == str(deep)

    # Control 2: with that $TMPDIR in force, the construction pytest uses DOES
    # overflow. This is the assertion that would have gone red before the fix.
    stock = Path(tempfile.gettempdir()) / "pytest-of-user" / "pytest-999" / "test_a_name0"
    assert len(str(stock / "b.sock").encode()) >= SUN_PATH_MAX, (
        "the simulated $TMPDIR is not long enough to overflow sun_path; "
        "this test would then pass without exercising anything"
    )

    # Ours ignores it, so a socket still fits.
    made = make_short_tmp_dir("some-test-name")
    try:
        assert not str(made).startswith("/private/var/folders")
        assert_bindable(made / "b.sock")
    finally:
        shutil.rmtree(made, ignore_errors=True)
