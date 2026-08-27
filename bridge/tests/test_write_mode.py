"""The GATT write arm: that it exists, that it moves, and that moving it moves the write.

TRA-1153 item 5 turns on a measurement, and a measurement is only as good as the
knob it varies. The failure this file exists to make impossible is CLAUDE.md's
first named class in its quietest form: a knob whose value never reaches the code
it names. That does not fail as an error. It fails as an A/B where both arms are
secretly the same arm, producing a confident null result -- a control that cannot
go red, run for eight hours.
"""

from __future__ import annotations

import inspect

import pytest

from ble_bridge import write_mode


@pytest.fixture(autouse=True)
def _restore_mode():
    """Never leak an arm into another test. RESTORE, never assume the default."""
    before = write_mode.get_mode()
    yield
    write_mode.set_mode(before)


def test_set_mode_returns_the_previous_mode():
    write_mode.set_mode(False)
    assert write_mode.set_mode(True) is False
    assert write_mode.set_mode(True) is True
    assert write_mode.get_mode() is True


def test_describe_names_both_arms_and_defaults_to_the_live_one():
    assert write_mode.describe(True) == "with-response"
    assert write_mode.describe(False) == "without-response"
    write_mode.set_mode(True)
    assert write_mode.describe() == "with-response"


async def test_the_arm_reaches_write_gatt_char():
    """The one with teeth: flip the knob, and the ATT operation changes.

    Asserted on the argument the library actually receives, not on the config
    value, because those are the two things this whole file is about not
    conflating.
    """
    from ble_bridge.esphome import BleakEsphomeSession

    calls: list[bool] = []

    class FakeBle:
        async def write_gatt_char(self, char, data, response):
            calls.append(response)

    session = object.__new__(BleakEsphomeSession)
    session._ble = FakeBle()
    session._write_char = object()

    write_mode.set_mode(False)
    await session.write("9900", b"\x01")
    write_mode.set_mode(True)
    await session.write("9900", b"\x01")

    assert calls == [False, True], (
        "the write arm did not reach write_gatt_char. Both soak arms would have "
        "issued the same ATT operation and the measurement would have compared "
        "a thing against itself."
    )


def test_bleak_still_takes_response_as_a_keyword():
    """Pinned against the emitter. A rename here silently pins one arm.

    `write_gatt_char(char, data, response=...)` is bleak's surface, not ours. If a
    version bump renames or drops it, our call raises -- loudly, which is fine. If
    it instead becomes ignored, nothing raises and the soak compares two identical
    arms, so this asserts the parameter is really there rather than trusting that
    passing it means something.
    """
    from bleak.backends.client import BaseBleakClient

    parameters = inspect.signature(BaseBleakClient.write_gatt_char).parameters
    assert "response" in parameters
