import json
import pathlib

from ble_bridge import __version__
from ble_bridge.mock_version import expected_mock_version


def _repo_package_json() -> pathlib.Path:
    for parent in pathlib.Path(__file__).resolve().parents:
        candidate = parent / "package.json"
        if candidate.is_file():
            return candidate
    raise AssertionError("no package.json found above the bridge package")


def test_expected_version_comes_from_the_npm_package():
    """_mv carries the NPM package version, not this Python package's version."""
    declared = json.loads(_repo_package_json().read_text())["version"]
    assert expected_mock_version() == declared


def test_expected_version_is_not_the_python_package_version():
    """The guard on the bug this module exists to prevent.

    Comparing _mv against ble_bridge.__version__ would report every
    correctly-behaving mock as mismatched, and a warning that fires on every
    healthy connection trains the reader to ignore the line.
    """
    assert expected_mock_version() != __version__
