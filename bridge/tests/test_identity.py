"""What `identity` has to be true about, mechanically rather than by eye.

Two of these matter more than the rest. `test_instance_id_differs_across_processes`
starts a second interpreter, because the property the field exists for is invisible
from inside one process -- an in-process assertion would pass against a constant.
And `test_fingerprint_moves_when_a_file_changes` is the break half: a field that has
not been shown to change is not evidence, and a fingerprint that never moved would
look exactly like a daemon that is always current.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from ble_bridge import identity


def test_instance_id_is_stable_within_the_process():
    assert identity.INSTANCE_ID == identity.INSTANCE_ID
    assert len(identity.INSTANCE_ID) == 32
    int(identity.INSTANCE_ID, 16)  # raises if it is not hex


def test_instance_id_differs_across_processes():
    """The property the field exists for, and the only way to observe it is to
    actually start a second interpreter."""
    code = "from ble_bridge.identity import INSTANCE_ID; print(INSTANCE_ID)"
    first = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    second = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert first.stdout.strip()
    assert first.stdout.strip() != second.stdout.strip()


def test_fingerprint_is_stable_for_an_unchanged_tree(tmp_path: Path):
    (tmp_path / "a.py").write_text("x = 1\n")
    assert identity.source_fingerprint(tmp_path) == identity.source_fingerprint(tmp_path)


def test_fingerprint_moves_when_a_file_changes(tmp_path: Path):
    f = tmp_path / "a.py"
    f.write_text("x = 1\n")
    before = identity.source_fingerprint(tmp_path)
    f.write_text("x = 2\n")
    assert identity.source_fingerprint(tmp_path) != before


def test_fingerprint_returns_to_its_old_value_when_a_change_is_reverted(tmp_path: Path):
    """It tracks content, not "something was touched". A fingerprint that only ever
    moved forward would call a reverted tree stale for the rest of its life."""
    f = tmp_path / "a.py"
    f.write_text("x = 1\n")
    before = identity.source_fingerprint(tmp_path)
    f.write_text("x = 2\n")
    f.write_text("x = 1\n")
    assert identity.source_fingerprint(tmp_path) == before


def test_fingerprint_moves_when_a_file_is_renamed(tmp_path: Path):
    """Content-only hashing would call these two trees identical."""
    (tmp_path / "a.py").write_text("x = 1\n")
    before = identity.source_fingerprint(tmp_path)
    (tmp_path / "a.py").rename(tmp_path / "b.py")
    assert identity.source_fingerprint(tmp_path) != before


def test_fingerprint_sees_a_file_in_a_subdirectory(tmp_path: Path):
    """`ws/` and the rest are real source. A walk that stopped at the top level
    would be blind to most of the package while still returning a hash."""
    (tmp_path / "a.py").write_text("x = 1\n")
    before = identity.source_fingerprint(tmp_path)
    nested = tmp_path / "ws"
    nested.mkdir()
    (nested / "relay.py").write_text("y = 2\n")
    assert identity.source_fingerprint(tmp_path) != before


def test_fingerprint_ignores_bytecode(tmp_path: Path):
    """__pycache__ is written by the running process. Counting it would let a
    daemon's own execution change the answer to "what code am I running"."""
    (tmp_path / "a.py").write_text("x = 1\n")
    before = identity.source_fingerprint(tmp_path)
    cache = tmp_path / "__pycache__"
    cache.mkdir()
    (cache / "a.cpython-312.pyc").write_bytes(b"\x00garbage")
    assert identity.source_fingerprint(tmp_path) == before


def test_fingerprint_ignores_non_python_files(tmp_path: Path):
    (tmp_path / "a.py").write_text("x = 1\n")
    before = identity.source_fingerprint(tmp_path)
    (tmp_path / "notes.txt").write_text("hello")
    assert identity.source_fingerprint(tmp_path) == before


def test_missing_root_raises_rather_than_returning_a_hash():
    """"I could not look" must not be representable as a fingerprint. A sentinel
    would either compare unequal to everything and read as permanent staleness, or
    -- worse -- compare equal to another failure and read as agreement."""
    with pytest.raises(FileNotFoundError):
        identity.source_fingerprint(Path("/nonexistent/ble-bridge"))


def test_module_constants_describe_the_installed_package():
    assert Path(identity.SOURCE_ROOT).name == "ble_bridge"
    assert identity.CODE_FINGERPRINT == identity.source_fingerprint(identity.SOURCE_ROOT)
    assert len(identity.CODE_FINGERPRINT) == 16
