"""Every variable `.env.local.example` advertises must have a reader.

Fifteen core `BLE_MCP_*` variables were declared in that file and read by nothing
in `bridge/src/`. Four of them were real capabilities the port dropped -- the log
level, the log buffer, the log timestamps, the idle timeout -- and the rest were
Noble-era leftovers. Either way the file was making a promise the process did not
keep, which is the expensive shape: an operator sets a value, reads it back out of
the environment, and never learns it reached nothing.

So this is the same move `verify-markers.sh` made for the soak's reset detector.
Each section of the file declares who reads it with a `# @owner <token>` marker,
and this test goes and looks. A variable that loses its reader fails here rather
than becoming folklore.

There is deliberately no token meaning "nothing reads this". An escape hatch with
no subjects is a guard that cannot go red, and the whole point of the exercise is
that a variable with no reader gets deleted rather than annotated. If a future
component genuinely needs a variable declared before it is wired up, point the
marker at where it IS read today -- the way `mcp-server` points at `src/` while
TRA-1161 is still pending -- or add the token back along with the check that
makes it mean something.
"""

from __future__ import annotations

import pathlib
import re

import pytest

REPO = pathlib.Path(__file__).resolve().parents[2]
EXAMPLE = REPO / ".env.local.example"

#: Owner token -> the directories that owner's code lives in. Every token must
#: name somewhere real: there is no "nothing reads this" option, by design.
OWNERS: dict[str, tuple[str, ...]] = {
    "python-bridge": ("bridge/src",),
    # TRA-1161 moves this surface into the Python bridge; until then the reader is
    # the TypeScript observability server.
    "mcp-server": ("src",),
    "rust-bridge": ("rust-ble-test/src",),
    # Ships to consumers inside the npm package, not a test-only knob.
    "mock-client": ("src",),
    "e2e-harness": ("tests",),
}

_MARKER = re.compile(r"^#\s*@owner\s+(\S+)\s*$")
#: An assignment, commented out or not. A commented-out example line still
#: declares the variable and still carries the file's claim about who reads it.
_ASSIGNMENT = re.compile(r"^#?\s*([A-Z][A-Z0-9_]*)=")

_SKIP_DIRS = {".venv", "node_modules", "__pycache__", "target", "dist", ".git"}


def _declarations() -> list[tuple[str, str | None, int]]:
    """Every variable in the example file, with the owner in force and its line."""
    found: list[tuple[str, str | None, int]] = []
    owner: str | None = None
    for lineno, line in enumerate(EXAMPLE.read_text().splitlines(), 1):
        marker = _MARKER.match(line.strip())
        if marker:
            owner = marker.group(1)
            continue
        assignment = _ASSIGNMENT.match(line)
        if assignment:
            found.append((assignment.group(1), owner, lineno))
    return found


def _referenced_in(name: str, roots: tuple[str, ...]) -> list[str]:
    hits = []
    for root in roots:
        base = REPO / root
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or any(part in _SKIP_DIRS for part in path.parts):
                continue
            try:
                if name in path.read_text():
                    hits.append(path.relative_to(REPO).as_posix())
            except (UnicodeDecodeError, OSError):
                continue
    return hits


DECLARATIONS = _declarations()


def test_the_example_file_declares_something():
    """A parser that silently matched nothing would make every test below vacuous."""
    assert len(DECLARATIONS) > 10


@pytest.mark.parametrize(
    ("name", "owner"),
    [(name, owner) for name, owner, _ in DECLARATIONS],
    ids=[f"{name}@{owner}" for name, owner, _ in DECLARATIONS],
)
def test_every_variable_names_a_known_owner(name, owner):
    assert owner is not None, (
        f"{name} in .env.local.example sits above every '# @owner' marker, so the "
        "file advertises it without saying who reads it."
    )
    assert owner in OWNERS, (
        f"{name} claims '# @owner {owner}', which is not one of {sorted(OWNERS)}."
    )


@pytest.mark.parametrize(
    ("name", "owner"),
    [(n, o) for n, o, _ in DECLARATIONS if o in OWNERS],
    ids=[f"{n}@{o}" for n, o, _ in DECLARATIONS if o in OWNERS],
)
def test_every_owned_variable_is_actually_read_by_its_owner(name, owner):
    """The acceptance criterion, executed rather than eyeballed.

    A variable whose reader has gone is not a documentation problem. It behaves
    exactly like a variable that works, right up until someone depends on it.
    """
    roots = OWNERS[owner]
    assert _referenced_in(name, roots), (
        f"{name} claims '# @owner {owner}' but no file under {list(roots)} mentions it. "
        "Either its reader was removed -- in which case delete the variable, this is "
        "how BLE_MCP_IDLE_TIMEOUT came to be inert -- or the marker is on the wrong "
        "section."
    )


def test_the_variables_the_bridge_reads_are_all_declared():
    """The reverse of the guard above: a variable the bridge reads but the example
    file never mentions is undiscoverable, which is how ESPHOME_NOISE_PSK support
    could exist and go unused."""
    declared = {name for name, _, _ in DECLARATIONS}
    from ble_bridge import config

    read_by_bridge = {
        value
        for key, value in vars(config).items()
        if key.endswith("_ENV") and isinstance(value, str)
    }
    assert read_by_bridge <= declared, sorted(read_by_bridge - declared)
