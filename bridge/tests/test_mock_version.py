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


def test_expected_version_agrees_with_the_python_package_version():
    """This assertion was inverted by TRA-1204, and the inversion is the point.

    It used to assert the two differ. That was never really a claim about the
    mock resolver -- it worked only because the Python package sat frozen at
    0.1.0 while the npm package moved, so "these two numbers differ" stood in for
    "these two constants come from different code paths". A test whose power comes
    from two values happening to differ stops testing anything the moment they
    agree, and it fails rather than degrading quietly, which is the one mercy.

    Since both are generated from package.json they must now AGREE, and that
    equality is load-bearing: a bump that forgets `pnpm run version:sync` leaves
    `__version__` behind while the mock moves on, and the bridge would then warn
    about a version mismatch on every healthy connection -- exactly the harm
    mock_version.py exists to prevent. So the guard survives, pointing the other
    way.
    """
    assert expected_mock_version() == __version__
