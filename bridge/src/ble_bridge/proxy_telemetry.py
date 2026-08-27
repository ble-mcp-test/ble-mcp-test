"""ESP32 proxy telemetry, logged from the API session the bridge already holds.

The proxy was reflashed on 2026-08-26 (PR #66) specifically to expose `loop_time`,
`heap_free` and `uptime`. Before that it published two buttons and no sensors, so
the CPU that TRA-1150 has spent weeks arguing about was never once measured -- only
inferred from run-duration variance on the host.

`loop_time` is the signal rather than a proxy for one: the main loop's period rises
directly as the ESP32 is starved, which is the resource Mike named as the real
constraint. That makes it the discriminator TRA-1153 item 5 needs, because a
throughput delta between the two write arms means something different if the ESP32
is saturated in one arm and idle in the other.

Subscribed over the EXISTING APIClient rather than from a second client. A separate
sampler would be its own API session competing for the proxy's connection slots,
and would perturb the very quantity it was measuring.

Nothing here can fail the bridge. Telemetry is instrumentation, and instrumentation
that can take down the thing it instruments is worse than no instrumentation.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

#: The sensors the reflash added, by ESPHome object_id. Anything else the device
#: publishes is ignored rather than logged -- a soak log is evidence, not a dump.
WANTED = ("loop_time", "heap_free", "uptime")


def log_device_stamp(device_info: Any) -> None:
    """Identify the firmware every result must be read against.

    Two variables, not one: a pure toolchain bump moves `esphome_version` and
    `compilation_time` while leaving the YAML's config hash unchanged, which is
    exactly what happened on the 2026-08-26 flash (an unintended 2026.8.0 ->
    2026.8.1). The config hash is NOT here because the device does not report it
    -- it comes from `esphome compile`, so it has to be recorded alongside by
    whoever built the image.
    """
    logger.info(
        "proxy firmware: name=%s model=%s esphome_version=%s compilation_time=%s "
        "(config_hash is not device-reported; record it from the build)",
        getattr(device_info, "name", "?"),
        getattr(device_info, "model", "?"),
        getattr(device_info, "esphome_version", "?"),
        getattr(device_info, "compilation_time", "?"),
    )


async def subscribe(client: Any) -> None:
    """Log the three sensors as they arrive. Never raises."""
    try:
        entities, _services = await client.list_entities_services()
    except Exception as exc:  # noqa: BLE001 - instrumentation must not take the bridge down
        logger.warning("proxy telemetry unavailable: listing entities failed: %s", exc)
        return

    wanted: dict[int, str] = {}
    for entity in entities:
        object_id = getattr(entity, "object_id", None)
        key = getattr(entity, "key", None)
        if object_id in WANTED and key is not None:
            wanted[key] = object_id

    missing = sorted(set(WANTED) - set(wanted.values()))
    if missing:
        # Loud, because the silent version of this is a soak that runs all night
        # and produces a telemetry column that is empty for a reason nobody sees.
        logger.warning(
            "proxy telemetry: %s not published by this firmware. Expected after the "
            "2026-08-26 reflash; an older image has no sensors at all.",
            ", ".join(missing),
        )
    if not wanted:
        return

    def on_state(state: Any) -> None:
        name = wanted.get(getattr(state, "key", None))
        if name is None:
            return
        logger.info("proxy telemetry: %s=%s", name, getattr(state, "state", None))

    client.subscribe_states(on_state)
    logger.info("proxy telemetry: subscribed to %s", ", ".join(sorted(wanted.values())))
