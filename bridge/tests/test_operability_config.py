"""The four operability variables the Python port dropped (TRA-1173).

Every one of these was declared in `.env.local.example` and read by nothing, which
is failure class two exactly: the operator sets `BLE_MCP_LOG_LEVEL=debug`, sees it
in the environment, and gets INFO. Nothing is slow and nothing reports an error.

So the parsing rule here is the same one the rest of `config.py` follows -- a value
that is present but unusable raises, and never falls back to the default.
"""

import logging

import pytest

from ble_bridge.config import (
    DEFAULT_IDLE_TIMEOUT_S,
    DEFAULT_LOG_BUFFER_SIZE,
    IDLE_TIMEOUT_ENV,
    LOG_BUFFER_SIZE_ENV,
    LOG_LEVEL_ENV,
    LOG_LEVELS,
    LOG_TIMESTAMPS_ENV,
    ConfigError,
    from_env,
)

# --- BLE_MCP_LOG_LEVEL --------------------------------------------------------


def test_log_level_defaults_to_info():
    assert from_env({}).log_level == logging.INFO


def test_log_level_is_read_and_is_case_insensitive():
    """The whole point of the ticket: this variable used to reach nothing at all."""
    assert from_env({LOG_LEVEL_ENV: "debug"}).log_level == logging.DEBUG
    assert from_env({LOG_LEVEL_ENV: "DEBUG"}).log_level == logging.DEBUG


@pytest.mark.parametrize("value", sorted(LOG_LEVELS))
def test_every_accepted_level_name_resolves_to_the_level_it_names(value):
    assert from_env({LOG_LEVEL_ENV: value}).log_level == LOG_LEVELS[value]


def test_the_accepted_names_are_the_ones_an_operator_would_reach_for():
    """Pinned as a set, so narrowing it is a visible change rather than a level
    that quietly stops being accepted.

    Derived from `logging` rather than retyped, for the same reason config.py
    derives it: a hand-written table can disagree with the levels it claims to
    name, and nothing would be slow when it did.
    """
    canonical = {
        logging.getLevelName(level).lower()
        for level in (
            logging.DEBUG,
            logging.INFO,
            logging.WARNING,
            logging.ERROR,
            logging.CRITICAL,
        )
    }
    assert set(LOG_LEVELS) == canonical | {"warn"}
    assert "notset" not in LOG_LEVELS


def test_an_unknown_log_level_fails_loudly():
    """Falling back to INFO here is how the variable became inert in the first place."""
    with pytest.raises(ConfigError, match=LOG_LEVEL_ENV):
        from_env({LOG_LEVEL_ENV: "verbose"})


def test_a_blank_log_level_is_absent_not_an_error():
    assert from_env({LOG_LEVEL_ENV: "  "}).log_level == logging.INFO


# --- BLE_MCP_LOG_TIMESTAMPS ---------------------------------------------------


def test_log_timestamps_default_on():
    assert from_env({}).log_timestamps is True


@pytest.mark.parametrize("value", ["false", "FALSE", "0", "no", "off"])
def test_log_timestamps_can_be_turned_off(value):
    assert from_env({LOG_TIMESTAMPS_ENV: value}).log_timestamps is False


@pytest.mark.parametrize("value", ["true", "TRUE", "1", "yes", "on"])
def test_log_timestamps_can_be_turned_on(value):
    assert from_env({LOG_TIMESTAMPS_ENV: value}).log_timestamps is True


def test_an_unparseable_log_timestamps_fails_loudly():
    """`logger.ts:11` was `!== 'false'`, so every typo silently meant true.

    That is a fallback wearing a comparison's clothes: `BLE_MCP_LOG_TIMESTAMPS=flase`
    reads as configured-off and behaves as on.
    """
    with pytest.raises(ConfigError, match=LOG_TIMESTAMPS_ENV):
        from_env({LOG_TIMESTAMPS_ENV: "flase"})


# --- BLE_MCP_LOG_BUFFER_SIZE --------------------------------------------------


def test_log_buffer_size_default():
    assert from_env({}).log_buffer_size == DEFAULT_LOG_BUFFER_SIZE


def test_log_buffer_size_override():
    assert from_env({LOG_BUFFER_SIZE_ENV: "250"}).log_buffer_size == 250


def test_zero_disables_the_buffer_explicitly():
    """Off is a legitimate choice; it just has to be asked for rather than fallen into."""
    assert from_env({LOG_BUFFER_SIZE_ENV: "0"}).log_buffer_size == 0


@pytest.mark.parametrize("value", ["17", "2000001", "-1"])
def test_an_out_of_range_buffer_size_fails_loudly(value):
    """`log-buffer.ts:29-30` clamped silently. A clamp is a fallback: the operator
    asks for 10 and gets 100, with the environment still saying 10."""
    with pytest.raises(ConfigError, match=LOG_BUFFER_SIZE_ENV):
        from_env({LOG_BUFFER_SIZE_ENV: value})


def test_an_unparseable_buffer_size_fails_loudly():
    with pytest.raises(ConfigError, match=LOG_BUFFER_SIZE_ENV):
        from_env({LOG_BUFFER_SIZE_ENV: "lots"})


# --- BLE_MCP_IDLE_TIMEOUT -----------------------------------------------------


def test_idle_timeout_defaults_to_ten_minutes():
    """Chosen against the longest legitimate silence, not against the soak.

    A soak run is ~29s end to end, so almost anything would pass it. A long LOCATE
    hold streams outbound for minutes while sending nothing in, and since outbound
    never renews the lease (see ws/idle.py) the floor has to clear that hold or the
    timer fires during real work.
    """
    assert from_env({}).idle_timeout == DEFAULT_IDLE_TIMEOUT_S == 600.0


def test_idle_timeout_override():
    assert from_env({IDLE_TIMEOUT_ENV: "45"}).idle_timeout == 45.0


def test_zero_disables_the_idle_timeout_explicitly():
    assert from_env({IDLE_TIMEOUT_ENV: "0"}).idle_timeout == 0.0


def test_a_negative_idle_timeout_fails_loudly():
    with pytest.raises(ConfigError, match=IDLE_TIMEOUT_ENV):
        from_env({IDLE_TIMEOUT_ENV: "-5"})


def test_an_unparseable_idle_timeout_fails_loudly():
    with pytest.raises(ConfigError, match=IDLE_TIMEOUT_ENV):
        from_env({IDLE_TIMEOUT_ENV: "ten minutes"})
