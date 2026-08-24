"""The clock itself. What stamps it is tested in test_relay_idle.py.

The unit under test is deliberately small, because the hazard is not in the timer
-- it is in which events are allowed to touch it.
"""

import asyncio

import pytest

from ble_bridge.ws.idle import IdleTimer


async def test_it_expires_after_the_timeout():
    timer = IdleTimer(0.05)
    assert await asyncio.wait_for(timer.wait_for_expiry(), 1.0) is True


async def test_a_stamp_pushes_the_deadline_out():
    timer = IdleTimer(0.08)
    waiting = asyncio.create_task(timer.wait_for_expiry())
    for _ in range(4):
        await asyncio.sleep(0.03)
        timer.stamp()
    assert not waiting.done()
    waiting.cancel()


async def test_it_still_expires_once_the_stamps_stop():
    timer = IdleTimer(0.05)
    waiting = asyncio.create_task(timer.wait_for_expiry())
    await asyncio.sleep(0.02)
    timer.stamp()
    assert await asyncio.wait_for(waiting, 1.0) is True


async def test_the_deadline_is_measured_from_the_last_stamp_not_the_first():
    """A timer that reset to `start + timeout` on every stamp would fire on
    schedule regardless of activity -- a wait condition that cannot be satisfied
    by what is actually sent, which presents as a device dropping mid-test."""
    timer = IdleTimer(0.06)
    loop = asyncio.get_running_loop()
    started = loop.time()
    await asyncio.sleep(0.04)
    timer.stamp()
    await asyncio.wait_for(timer.wait_for_expiry(), 1.0)
    assert loop.time() - started >= 0.09


def test_a_zero_timeout_is_refused():
    """Disabled is the absence of a timer, decided by the caller, never a timer
    configured to fire immediately."""
    with pytest.raises(ValueError):
        IdleTimer(0)


def test_a_negative_timeout_is_refused():
    with pytest.raises(ValueError):
        IdleTimer(-1)
