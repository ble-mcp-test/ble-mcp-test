"""The service version used to be a literal in `__init__.py`, permanently "0.1.0"
-- the Python package version, never touched through the entire replatform. It
reported the same string for today's code and for six-month-old code: a field that
could not go red.

The mock and the service ship as one release, so they now take one version from one
place. This is the check that keeps the generated copy honest -- mechanically, per
CLAUDE.md, rather than by eye. A bump that forgets `pnpm run version:sync` fails
here rather than shipping a daemon that misreports its release.

**It is still not a code-currency signal**, and that is a property of what the field
means rather than of what it currently reads. A release number moves on release and
code moves on merge, so two daemons at the same released version can be serving
different code. `identity.CODE_FINGERPRINT` is the field for that question.
"""

from __future__ import annotations

import json
import tomllib
from pathlib import Path

import ble_bridge

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_version_matches_package_json():
    package_version = json.loads((REPO_ROOT / "package.json").read_text())["version"]
    assert ble_bridge.__version__ == package_version


def test_version_is_not_the_frozen_placeholder():
    """The specific value that made the field a lie for the whole replatform."""
    assert ble_bridge.__version__ != "0.1.0"


def test_pyproject_reads_the_same_generated_file():
    """Two version declarations that can drift is the thing being removed. A
    literal here would be a second source, and the two would disagree the first
    time only one of them was bumped."""
    pyproject = tomllib.loads((REPO_ROOT / "bridge" / "pyproject.toml").read_text())
    assert "version" not in pyproject["project"]
    assert pyproject["project"]["dynamic"] == ["version"]
    assert pyproject["tool"]["hatch"]["version"]["path"] == "src/ble_bridge/_version.py"
