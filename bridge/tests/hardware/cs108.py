"""Just enough CS108 byte-stream protocol to drive a real reader in a test.

NOT a CS108 client, and deliberately not on its way to becoming one -- `trakrf/handheld`
owns that. This is the smallest thing that lets a hardware test say "start battery
auto-reporting" instead of pasting eleven hex bytes, because a test whose intent
lives in a hex literal cannot be reviewed.

Frame layout, from *CS108 and CS463 Bluetooth and USB Byte Stream API
Specifications* section 12 and its module tables:

    byte  0   0xA7   prefix
    byte  1   0xB3   transport: Bluetooth
    byte  2   len    event code (2) + payload
    byte  3   module 0xD9 notification / 0x5F bluetooth / 0xC2 rfid
    byte  4   0x82   reserved
    byte  5   0x37   direction: downlink (to device); 0x9E is uplink
    bytes 6-7 CRC    the spec permits 0x0000 on downlink, so commands carry zero
    bytes 8-9 event code, big-endian
    byte 10+  payload

Only the downlink direction is built here. Uplink frames are matched by event code
rather than parsed, since what a test needs to know is "did the reader send this
kind of thing", not what the value means.
"""

from __future__ import annotations

from typing import Final

PREFIX: Final = 0xA7
TRANSPORT_BLUETOOTH: Final = 0xB3
RESERVED: Final = 0x82
DOWNLINK: Final = 0x37
UPLINK: Final = 0x9E

MODULE_NOTIFICATION: Final = 0xD9
MODULE_BLUETOOTH: Final = 0x5F

#: "Start battery 5 seconds auto reporting (for BT connection only)". The interval
#: is part of the command, not a parameter -- there is no way to ask for a
#: different one. Observed cadence on CS108Reader2603A7 is ~4.2s, slightly faster
#: than the name promises.
START_BATTERY_REPORTING: Final = 0xA002
#: "Stop battery auto reporting". Always send this when a test is done with it, or
#: the reader keeps talking to whoever connects next.
STOP_BATTERY_REPORTING: Final = 0xA003
#: "Get current battery voltage" -- a plain request/response, used as a write that
#: is expected to fail once the link is down.
GET_BATTERY_VOLTAGE: Final = 0xA000
#: Uplink event code the battery reports arrive under.
BATTERY_VOLTAGE_REPORT: Final = 0xA000

#: "Force BT disconnection". The reader drops its BLE link while the ESPHome proxy
#: stays reachable, which is the only way to induce the two-state split on demand.
#: Routine and self-recovering: the reader re-advertises immediately, exactly as it
#: does when any client disconnects.
FORCE_BT_DISCONNECT: Final = 0xC005

HEADER_SIZE: Final = 8


def command(event_code: int, module: int, payload: bytes = b"") -> bytes:
    """One downlink frame. CRC is zero, which the spec permits for commands."""
    data_length = 2 + len(payload)
    if data_length > 0xFF:
        raise ValueError(f"payload of {len(payload)} bytes overflows the length byte")
    return bytes(
        [
            PREFIX,
            TRANSPORT_BLUETOOTH,
            data_length,
            module,
            RESERVED,
            DOWNLINK,
            0x00,  # CRC low
            0x00,  # CRC high
            (event_code >> 8) & 0xFF,
            event_code & 0xFF,
        ]
    ) + payload


def start_battery_reporting() -> bytes:
    return command(START_BATTERY_REPORTING, MODULE_NOTIFICATION, bytes([0x01]))


def stop_battery_reporting() -> bytes:
    return command(STOP_BATTERY_REPORTING, MODULE_NOTIFICATION)


def get_battery_voltage() -> bytes:
    return command(GET_BATTERY_VOLTAGE, MODULE_NOTIFICATION)


def force_bt_disconnect() -> bytes:
    return command(FORCE_BT_DISCONNECT, MODULE_BLUETOOTH)


def event_code_of(frame: bytes) -> int | None:
    """The event code of an uplink frame, or None if it is not one.

    Lenient on purpose: a test asserting "a battery report arrived" must not fail
    because the reader also sent something this module has never heard of.
    """
    if len(frame) < HEADER_SIZE + 2 or frame[0] != PREFIX:
        return None
    return (frame[HEADER_SIZE] << 8) | frame[HEADER_SIZE + 1]


def is_battery_report(frame: bytes) -> bool:
    return event_code_of(frame) == BATTERY_VOLTAGE_REPORT and frame[5] == UPLINK
