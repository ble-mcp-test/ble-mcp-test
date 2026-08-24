"""The BLE transport: a real device, reached through an ESPHome Bluetooth Proxy.

This is the only module in the bridge that is not commodity. Everything else is
a WebSocket relay, a queue and some JSON; this is the part that has to be right
about somebody else's protocol.

## Two states, never conflated

`rust-ble-test` connects once at startup (`main.rs:120`) and never re-verifies,
so it can hold a healthy TCP session to the proxy while the BLE link is down and
report itself connected on the strength of the socket. The proxy is a separate
computer: it stays reachable when the peripheral walks out of range, when its
battery dies, and when it drops the link mid-session.

So this transport tracks the two separately and `is_connected()` answers only the
second. `proxy_reachable` exists for diagnostics and is never a substitute --
that substitution is the entire bug.

## Where the tasks are

Nowhere. This module creates no `asyncio.Task`, deliberately, which is the
cheapest possible way to satisfy "every task is awaited or given an explicit
done-callback". Everything here is awaited by its caller, and the background work
-- the proxy's read loop, its keepalives, the reconnect logic -- belongs to
`aioesphomeapi`, which owns those tasks and tears them down with the connection.
Adding one here would mean re-answering a question the library already answers.

## The seam

`ProxySession` exists so the orchestration below can be executed in tests without
a radio, a proxy, or a reader. The ordering rules, the two-state discipline and
the cleanup guarantees are the parts that break under pressure at 3am, and they
are testable; the library wiring underneath is not, and is kept as thin and as
declarative as it can be so that reading it is a reasonable substitute.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from ble_bridge.config import EsphomeConfig
from ble_bridge.notify import NotifySink
from ble_bridge.transport import DataCallback, DeviceInfo

if TYPE_CHECKING:
    from ble_bridge.ws.params import ConnectionParams

logger = logging.getLogger(__name__)

#: How long to wait to hear the target advertising before giving up.
#:
#: The proxy's scanner must have seen the device before an active connection by
#: address will complete, so this wait is structural rather than defensive. It is
#: also the single most informative failure in the whole path: a peripheral held
#: in someone else's connection does not advertise, so a timeout here says
#: "in use or absent" where a connect timeout would say only "something failed".
ADVERTISEMENT_TIMEOUT_S = 30.0

#: How long to wait for the BLE link itself once the proxy has heard the device.
CONNECT_TIMEOUT_S = 20.0


class TransportError(RuntimeError):
    """The device link could not be established, or could not be used."""


@dataclass(frozen=True)
class GattTarget:
    """Which characteristics this client asked for.

    Per connection, not per process: these arrive as URL query parameters, and
    two consumers of one reader may legitimately want different ones.
    """

    service: str
    write: str
    notify: str

    @classmethod
    def from_params(cls, params: ConnectionParams) -> GattTarget:
        return cls(
            service=normalise_uuid(params.service, "service"),
            write=normalise_uuid(params.write, "write"),
            notify=normalise_uuid(params.notify, "notify"),
        )


def normalise_uuid(value: str, what: str) -> str:
    """Expand a 16- or 32-bit short form to the full 128-bit UUID.

    `ws/params.py` passes these through deliberately unnormalised so that exactly
    one normaliser exists in the tree; this is it. Two normalisers that disagree
    would produce a characteristic lookup that fails for one spelling of the
    same UUID, which reads as a device that does not have the characteristic.
    """
    from bleak.uuids import normalize_uuid_str

    try:
        return normalize_uuid_str(value)
    except (ValueError, AttributeError) as exc:
        raise TransportError(
            f"the {what} UUID {value!r} is not a UUID. Expected a 16-bit form like "
            "'9800', a 32-bit form, or a full 128-bit UUID."
        ) from exc


class ProxySession(Protocol):
    """The proxy-and-device wiring, behind a seam a fake can stand in for."""

    @property
    def proxy_reachable(self) -> bool: ...

    @property
    def device_connected(self) -> bool: ...

    async def open_proxy(self) -> None: ...

    async def await_advertisement(self, timeout: float) -> None: ...

    async def connect_device(self, timeout: float) -> DeviceInfo: ...

    async def start_notify(self, notify_uuid: str, sink: NotifySink) -> None: ...

    async def write(self, write_uuid: str, data: bytes) -> None: ...

    async def close(self) -> None: ...


class EsphomeTransport:
    """A `BleTransport` over an ESPHome Bluetooth Proxy.

    Built per WebSocket connection, never at import or process start. See
    `docs/design/2026-08-23-transport-lifecycle-decision.md`: a module-level
    connection would silently restore process lifetime as a claim on the radio.
    """

    def __init__(
        self,
        session: ProxySession,
        target: GattTarget,
        *,
        description: str = "esphome",
        advertisement_timeout: float = ADVERTISEMENT_TIMEOUT_S,
        connect_timeout: float = CONNECT_TIMEOUT_S,
    ) -> None:
        self._session = session
        self._target = target
        self._description = description
        self._advertisement_timeout = advertisement_timeout
        self._connect_timeout = connect_timeout
        self._sink: NotifySink | None = None
        self._callback: DataCallback | None = None
        self._device: DeviceInfo | None = None
        self._closed = False

    # --- BleTransport ---------------------------------------------------------

    def set_data_callback(self, callback: DataCallback) -> None:
        self._callback = callback

    async def connect(self) -> DeviceInfo:
        """Reach the proxy, hear the device, link to it, and subscribe.

        Ordered exactly as the proxy requires, and every failure releases what
        was already acquired. A half-open path is the worst outcome available
        here: it holds a TCP session and possibly a BLE link that nothing owns,
        and the next connection attempt then fails for a reason that has nothing
        to do with what is wrong.
        """
        if self._callback is None:
            # Subscribing before there is anywhere to put the data would drop
            # every notification that arrived in between, silently.
            raise TransportError(
                "connect() before set_data_callback(): notifications would have "
                "nowhere to go and would be discarded without a trace."
            )
        if self._closed:
            raise TransportError("connect() after cleanup(): build a new transport.")

        sink = NotifySink(self._callback, description=self._description)
        try:
            await self._session.open_proxy()
            logger.info("%s: proxy reachable; waiting to hear the device", self._description)

            await self._session.await_advertisement(self._advertisement_timeout)
            logger.info(
                "%s: heard the device advertising; requesting the BLE link",
                self._description,
            )

            device = await self._session.connect_device(self._connect_timeout)

            await self._session.start_notify(self._target.notify, sink)
        except TimeoutError as exc:
            await self._release_after_failure()
            raise TransportError(f"{self._description}: {exc}") from exc
        except Exception:
            await self._release_after_failure()
            raise

        self._sink = sink
        self._device = device
        logger.info("%s: connected to %s and subscribed", self._description, device.name)
        return device

    async def write(self, data: bytes) -> None:
        """Client -> device.

        Refuses on a dead BLE link even when the proxy is fine, which is the one
        case where the two states differ and the difference matters: a write
        accepted by a reachable proxy for an unlinked device is a command the
        caller believes was delivered.
        """
        if not self._session.device_connected:
            raise TransportError(
                f"{self._description}: refusing to write {len(data)} bytes -- the BLE link "
                f"to the device is down (the proxy is "
                f"{'reachable' if self._session.proxy_reachable else 'also unreachable'})."
            )
        await self._session.write(self._target.write, data)

    async def cleanup(self) -> None:
        """Release everything, once, and never raise.

        Called from the relay's `finally`, so raising here would mask whatever
        actually ended the session. Idempotent because an evicted connection can
        reach it by two paths at once.
        """
        if self._closed:
            return
        self._closed = True
        try:
            await self._session.close()
        except Exception:
            logger.exception("%s: releasing the device link raised", self._description)
        else:
            logger.info("%s: released the device link", self._description)
        self._report_losses()

    def is_connected(self) -> bool:
        """Whether the BLE link is up. NEVER whether the proxy is reachable."""
        return self._session.device_connected

    # --- diagnostics ----------------------------------------------------------

    @property
    def proxy_reachable(self) -> bool:
        """Whether the TCP session to the proxy is up. Not a connection state."""
        return self._session.proxy_reachable

    @property
    def notifications_delivered(self) -> int:
        return self._sink.delivered if self._sink else 0

    @property
    def notifications_lost(self) -> int:
        return self._sink.failed if self._sink else 0

    # --- internals ------------------------------------------------------------

    async def _release_after_failure(self) -> None:
        self._closed = True
        try:
            await self._session.close()
        except Exception:
            logger.exception(
                "%s: failed to release after a failed connect; the proxy may still "
                "hold the link until its TCP session drops",
                self._description,
            )

    def _report_losses(self) -> None:
        """Say it at the end too.

        The per-notification log is rate-limited, so a session that lost data
        early and ran for an hour has one line about it a long way up the log.
        """
        if self._sink is not None and not self._sink.healthy:
            logger.error(
                "%s: this session LOST %d of %d notifications at the relay boundary",
                self._description,
                self._sink.failed,
                self._sink.delivered + self._sink.failed,
            )


# --- the real wiring ----------------------------------------------------------


class BleakEsphomeSession:
    """`ProxySession` implemented on bleak-esphome + aioesphomeapi.

    Kept thin on purpose. Everything with a decision in it lives in
    `EsphomeTransport` above, where it can be executed in a test; what remains
    here is the sequence of library calls, which only hardware can validate.

    Why bleak-esphome rather than aioesphomeapi alone, given that the audit's
    four guarantees all live in aioesphomeapi: the CCCD write does not.
    `aioesphomeapi.bluetooth_gatt_start_notify` sends only
    `BluetoothGATTNotifyRequest`; on v3/`REMOTE_CACHING` connections the
    descriptor write that actually turns notifications on at the peripheral is
    `bleak_esphome/backend/client.py:908-941`, which also picks NOTIFY vs
    INDICATE bytes from the characteristic's properties and gates itself on the
    proxy's feature flags. `rust-ble-test` hand-rolls that write unconditionally.
    Reimplementing it here would mean owning a correctness detail that a
    maintained library already handles better.
    """

    def __init__(self, config: EsphomeConfig, target: GattTarget) -> None:
        self._config = config
        self._target = target
        self._client = None  # aioesphomeapi.APIClient
        self._client_data = None  # bleak_esphome ESPHomeClientData
        self._unregister_scanner = None
        self._unsetup_scanner = None
        self._ble_device = None  # bleak BLEDevice, once heard advertising
        self._ble = None  # bleak_esphome ESPHomeClient
        self._notify_char = None
        self._write_char = None

    @property
    def proxy_reachable(self) -> bool:
        # `is_connected`, not `connected` -- APIClient has no such attribute, and
        # reading a missing one would raise inside a property the relay calls to
        # decide whether to write.
        client = self._client
        return bool(client is not None and client.is_connected)

    @property
    def device_connected(self) -> bool:
        ble = self._ble
        return bool(ble is not None and ble.is_connected)

    async def open_proxy(self) -> None:
        from aioesphomeapi import APIClient

        self._client = APIClient(
            address=self._config.proxy_host,
            port=self._config.proxy_port,
            password="",
            noise_psk=self._config.noise_psk,
            client_info="ble-mcp-test",
        )
        await self._client.connect(login=True)

    async def await_advertisement(self, timeout: float) -> None:
        """Register a scanner and wait to hear the target.

        The wait is on the scanner's own view rather than on a connect attempt,
        because the two failures are worth telling apart: a device that never
        advertises is absent or already held by someone else, which is a
        different conversation from a device that advertises and refuses.
        """
        from bleak_esphome import connect_scanner

        from ble_bridge.habluetooth_runtime import ensure_manager

        manager = ensure_manager()
        device_info = await self._client.device_info()
        self._client_data = connect_scanner(self._client, device_info, available=True)
        scanner = self._client_data.scanner
        # NOT awaited: `async_setup` is named for the loop it belongs to, not for
        # being a coroutine. It returns the un-setup callback synchronously, so
        # awaiting it raises TypeError on the happy path.
        self._unsetup_scanner = scanner.async_setup()
        self._unregister_scanner = manager.async_register_scanner(scanner)

        wanted = self._config.device_mac.upper()
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            for device in scanner.discovered_devices:
                if device.address.upper() == wanted:
                    self._ble_device = device
                    return
            await asyncio.sleep(0.25)
        raise TimeoutError(
            f"device {wanted} was not heard advertising to proxy "
            f"{self._config.proxy_host}:{self._config.proxy_port} within {timeout:g}s. "
            "A peripheral already held in another connection does not advertise, so "
            "this most often means it is in use rather than absent."
        )

    async def connect_device(self, timeout: float) -> DeviceInfo:
        from bleak_esphome.backend.client import ESPHomeClient

        self._ble = ESPHomeClient(self._ble_device, client_data=self._client_data, timeout=timeout)
        await self._ble.connect(pair=False)
        services = getattr(self._ble, "services", None)
        if services is None:
            raise TransportError(
                "the BLE link came up but no GATT services were resolved. Nothing can "
                "be subscribed or written, so this is a failure rather than a partial "
                "success to carry on from."
            )
        self._notify_char = services.get_characteristic(self._target.notify)
        self._write_char = services.get_characteristic(self._target.write)
        if self._notify_char is None:
            raise TransportError(f"no characteristic {self._target.notify} on this device")
        if self._write_char is None:
            raise TransportError(f"no characteristic {self._target.write} on this device")
        return DeviceInfo(
            name=self._ble_device.name or self._config.device_mac,
            id=self._config.device_mac,
        )

    async def start_notify(self, notify_uuid: str, sink: NotifySink) -> None:
        """Subscribe, with a callback of the arity bleak-esphome actually calls.

        ONE argument, not two. `bleak_esphome/backend/client.py:903` is
        `lambda handle, data: callback(data)` -- it has already dropped the
        handle by the time our callback is reached, because correlation happened
        upstream at `client_base.py:172`.

        Getting this wrong was invisible to every test and to the whole connect
        path: the subscription succeeded, the session stayed healthy, and the
        TypeError was raised inside aioesphomeapi's handler, which routes it to
        its OWN logger. Found only by running against hardware and watching no
        data arrive. See test_the_notify_callback_takes_exactly_one_argument.
        """
        await self._ble.start_notify(self._notify_char, lambda data: sink(bytes(data)))

    async def write(self, write_uuid: str, data: bytes) -> None:
        await self._ble.write_gatt_char(self._write_char, data, response=False)

    async def close(self) -> None:
        """Release in the reverse of the order it was acquired.

        The BLE link goes first and explicitly. `ble_btleplug.rs:450-453` made
        `disconnect()` a no-op returning Ok and left the peripheral to a
        destructor, which reported success while doing nothing.
        """
        if self._ble is not None:
            try:
                await self._ble.disconnect()
            except Exception:
                logger.exception("disconnecting the BLE link raised")
            self._ble = None
        if self._unregister_scanner is not None:
            self._unregister_scanner()
            self._unregister_scanner = None
        if self._unsetup_scanner is not None:
            # Leaving this out leaks the scanner's watchdog across connections,
            # which a per-connection transport would accumulate one per client.
            self._unsetup_scanner()
            self._unsetup_scanner = None
        if self._client is not None:
            await self._client.disconnect()
            self._client = None
        self._ble_device = None
        self._client_data = None


def transport_factory(config: EsphomeConfig):
    """Builds one transport per WebSocket connection. Never connects here."""

    def build(params: ConnectionParams) -> EsphomeTransport:
        target = GattTarget.from_params(params)
        return EsphomeTransport(
            BleakEsphomeSession(config, target),
            target,
            description=f"esphome {config.device_mac}",
        )

    return build
