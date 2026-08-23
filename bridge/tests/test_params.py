import pytest

from ble_bridge.ws.params import (
    InvalidParameterError,
    MissingParametersError,
    parse_params,
)
from ble_bridge.ws.protocol import MISSING_PARAMS_ERROR

REQUIRED = "service=180a&write=2a01&notify=2a02"


def test_parses_all_nine_parameters():
    query = (
        "/?service=180a&write=2a01&notify=2a02&session=s1&_mv=0.7.3"
        "&force=true&deviceId=abc&deviceName=CS108&timeout=5000"
    )
    p = parse_params(query)
    assert p.service == "180a"
    assert p.write == "2a01"
    assert p.notify == "2a02"
    assert p.session == "s1"
    assert p.mock_version == "0.7.3"
    assert p.force is True
    assert p.device_id == "abc"
    assert p.device_name == "CS108"
    assert p.timeout == 5000


@pytest.mark.parametrize("missing", ["service", "write", "notify"])
def test_each_required_parameter_is_required(missing):
    parts = {"service": "180a", "write": "2a01", "notify": "2a02"}
    del parts[missing]
    with pytest.raises(MissingParametersError) as exc:
        parse_params("&".join(f"{k}={v}" for k, v in parts.items()))
    assert str(exc.value) == MISSING_PARAMS_ERROR


def test_empty_required_parameter_counts_as_missing():
    """bridge-server.ts uses `|| ''` then a falsy check, so blank == absent."""
    with pytest.raises(MissingParametersError):
        parse_params("service=&write=2a01&notify=2a02")


def test_session_is_generated_when_absent():
    p = parse_params(REQUIRED, session_factory=lambda: "generated-id")
    assert p.session == "generated-id"
    assert p.session_was_provided is False


def test_generated_sessions_are_unique():
    first = parse_params(REQUIRED).session
    second = parse_params(REQUIRED).session
    assert first != second


def test_provided_session_is_kept():
    p = parse_params(f"{REQUIRED}&session=mine")
    assert p.session == "mine"
    assert p.session_was_provided is True


@pytest.mark.parametrize(
    "raw,expected",
    [("true", True), ("false", False), ("1", False), ("TRUE", False), ("yes", False)],
)
def test_force_is_exactly_the_string_true(raw, expected):
    """bridge-server.ts:59 -- `=== 'true'`. Any other value is falsy."""
    assert parse_params(f"{REQUIRED}&force={raw}").force is expected


def test_force_defaults_false():
    assert parse_params(REQUIRED).force is False


def test_optional_parameters_default_to_none():
    p = parse_params(REQUIRED)
    assert p.device_id is None
    assert p.device_name is None
    assert p.timeout is None
    assert p.mock_version is None


def test_unparseable_timeout_fails_loudly():
    """Deliberate divergence from the TypeScript.

    `parseInt('abc', 10)` is NaN there and propagates silently into the transport.
    A value that is present, wrong, and quietly ignored is CLAUDE.md failure
    class 2 -- it succeeds against the wrong input, so nothing even looks slow.
    """
    with pytest.raises(InvalidParameterError, match="timeout"):
        parse_params(f"{REQUIRED}&timeout=abc")


def test_uuids_are_passed_through_unnormalised():
    """Normalisation belongs to the transport, as it does in noble-transport.ts.

    bridge-server.ts:88-92 passes the raw strings through with a comment saying
    so; TRA-1158 owns the normalising. Doing it here would put two normalisers
    in the tree that could disagree.
    """
    p = parse_params("service=0000180A-0000-1000-8000-00805F9B34FB&write=2a01&notify=2a02")
    assert p.service == "0000180A-0000-1000-8000-00805F9B34FB"


def test_a_bare_query_string_without_a_path_is_accepted():
    assert parse_params(REQUIRED).service == "180a"


def test_repeated_parameter_takes_the_first_like_searchparams_get():
    """URLSearchParams.get() returns the first occurrence."""
    p = parse_params("service=first&service=second&write=2a01&notify=2a02")
    assert p.service == "first"
