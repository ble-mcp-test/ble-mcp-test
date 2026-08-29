import json
import pathlib

from ble_bridge import __version__, mock_version
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


# --- MockVersionWatch: TRA-1211 -----------------------------------------------


def _watch(monkeypatch, expected):
    """A watch whose expected version is pinned, so all five states are reachable.

    `expected_mock_version()` reads the repo's package.json and is cached, so the
    "npm version unresolvable" row of the table cannot be produced any other way.
    """
    monkeypatch.setattr(mock_version, "expected_mock_version", lambda: expected)
    return mock_version.MockVersionWatch()


def test_nothing_connected_reports_unknown_not_mismatch(monkeypatch):
    assert _watch(monkeypatch, "0.13.0").report(None) == {
        "mock_version": None,
        "mock_version_expected": "0.13.0",
        "mock_version_match": None,
    }


def test_a_client_that_sent_no_version_reports_unknown_not_mismatch(monkeypatch):
    """The distinction the whole ticket turns on: null is "could not check".

    A consumer that cannot tell `false` from `null` is back where TRA-1200
    started -- reading a field that said nothing and believing it said no.
    """
    assert _watch(monkeypatch, "0.13.0").report(None)["mock_version_match"] is None


def test_an_unresolvable_npm_version_reports_unknown_not_mismatch(monkeypatch):
    assert _watch(monkeypatch, None).report("0.12.0") == {
        "mock_version": "0.12.0",
        "mock_version_expected": None,
        "mock_version_match": None,
    }


def test_two_versions_that_agree_report_a_match(monkeypatch):
    assert _watch(monkeypatch, "0.13.0").report("0.13.0") == {
        "mock_version": "0.13.0",
        "mock_version_expected": "0.13.0",
        "mock_version_match": True,
    }


def test_two_versions_that_differ_report_a_mismatch(monkeypatch):
    assert _watch(monkeypatch, "0.13.0").report("0.12.0") == {
        "mock_version": "0.12.0",
        "mock_version_expected": "0.13.0",
        "mock_version_match": False,
    }


def test_the_counter_starts_at_zero(monkeypatch):
    assert _watch(monkeypatch, "0.13.0").mismatches == 0


def test_each_mismatching_connection_increments_the_counter(monkeypatch):
    """Once per connection, and it never goes back down.

    This is the field a soak watchdog keys on: baseline at start, compare each
    poll, abort if it moved. A counter that reset would be missable in exactly
    the way the point-in-time fields already are.
    """
    watch = _watch(monkeypatch, "0.13.0")
    watch.observe("0.12.0")
    assert watch.mismatches == 1
    watch.observe("0.12.0")
    watch.observe("0.11.0")
    assert watch.mismatches == 3


def test_a_matching_connection_does_not_increment_the_counter(monkeypatch):
    watch = _watch(monkeypatch, "0.13.0")
    watch.observe("0.13.0")
    assert watch.mismatches == 0


def test_a_connection_that_sent_no_version_does_not_increment_the_counter(monkeypatch):
    """Unknown is not a mismatch. Counting it would make the counter useless as an
    abort criterion the moment anything connects without the mock injected."""
    watch = _watch(monkeypatch, "0.13.0")
    watch.observe(None)
    assert watch.mismatches == 0


def test_an_unresolvable_npm_version_does_not_increment_the_counter(monkeypatch):
    watch = _watch(monkeypatch, None)
    watch.observe("0.12.0")
    assert watch.mismatches == 0


def test_observing_a_mismatch_still_warns(monkeypatch, caplog):
    """The log line is the human-readable half, retained deliberately."""
    watch = _watch(monkeypatch, "0.13.0")
    with caplog.at_level("WARNING"):
        watch.observe("0.12.0")
    assert any("mismatch" in r.message.lower() for r in caplog.records)


def test_observing_no_version_still_warns_about_the_missing_parameter(monkeypatch, caplog):
    watch = _watch(monkeypatch, "0.13.0")
    with caplog.at_level("WARNING"):
        watch.observe(None)
    assert any("_mv" in r.message for r in caplog.records)


def test_a_matching_connection_is_silent(monkeypatch, caplog):
    watch = _watch(monkeypatch, "0.13.0")
    with caplog.at_level("WARNING"):
        watch.observe("0.13.0")
    assert caplog.records == []
