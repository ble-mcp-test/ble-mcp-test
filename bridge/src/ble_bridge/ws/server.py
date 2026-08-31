"""The WebSocket relay: `connected`, `data`, `error`, `warning` and `write_ack`.

One connection owns the command path and writes to the device; any number of
others attach read-only to its notification stream. Which one a connection is
asking to be is stated in `role=`, never inferred -- see ble_bridge.ws.ownership
for why the model is shaped this way and why the claim is per connection.

Every refusal on this path is an `error` frame with a complete sentence in it,
followed by a close. That is the whole point of TRA-1159: the alternative, which
the 2026-08-23 incident actually produced, is a second writer that connects
successfully and corrupts somebody else's run without anything being slow or
anything reporting an error.

`force_cleanup` / `force_cleanup_complete` are not here and are not coming.
TRA-1162 settled it: the zombie they existed to clear was a Noble artifact, and
this server has never used Noble. See CLIENT_MESSAGE_TYPES in protocol.py for the
soak evidence.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from dataclasses import dataclass
from typing import Any

import websockets
from websockets.asyncio.server import Request, Response, Server, ServerConnection, serve
from websockets.datastructures import Headers

from ble_bridge import __version__, write_mode
from ble_bridge.config import Config
from ble_bridge.log_buffer import RX, TX, LogBuffer
from ble_bridge.mock_version import MockVersionWatch
from ble_bridge.transport import BleTransport, TransportError, TransportFactory
from ble_bridge.ws import protocol as p
from ble_bridge.ws import status as status_endpoint
from ble_bridge.ws.idle import IdleTimer
from ble_bridge.ws.ownership import (
    END_OF_STREAM,
    Claim,
    CommandPath,
    OwnershipError,
    Subscription,
)
from ble_bridge.ws.params import (
    ConnectionParams,
    InvalidParameterError,
    MissingParametersError,
    Role,
    parse_params,
)

logger = logging.getLogger(__name__)

#: How long a displacing connection waits for the displaced one to release its
#: transport. Generous: the alternative to waiting is two transports on one radio.
EVICTION_TEARDOWN_TIMEOUT_S = 5.0


class BridgeServer:
    """Relays between WebSocket clients and one BLE transport.

    The transport is constructed inside the connection handler, deliberately, and
    only for the connection that owns the command path. See ble_bridge.transport
    for why process lifetime must not be a claim on the radio.
    """

    def __init__(
        self,
        config: Config,
        transport_factory: TransportFactory,
        log_buffer: LogBuffer | None = None,
    ) -> None:
        self._config = config
        self._factory = transport_factory
        self._server: Server | None = None
        self._port: int | None = None
        self._path = CommandPath()
        # One watch per process, owned here and READ by ControlServer. Built
        # here rather than at each end because a second instance would count
        # perfectly and report zero, which is indistinguishable from a healthy
        # fleet -- the exact shape of the TRA-1200 failure this answers.
        self._mock_versions = MockVersionWatch()
        # `__main__` passes the buffer that `logging_setup.configure` already
        # attached its handler to, so log lines and relayed packets land in ONE
        # ordered record. Two rings cannot answer "what was on the wire when the
        # log went quiet", which is the question a wedge post-mortem asks.
        self._log_buffer = (
            log_buffer if log_buffer is not None else LogBuffer(config.log_buffer_size)
        )

    @property
    def port(self) -> int:
        if self._port is None:
            raise RuntimeError("server is not started")
        return self._port

    @property
    def log_buffer(self) -> LogBuffer:
        """What TRA-1161's `get_logs` and `search_packets` read."""
        return self._log_buffer

    @property
    def command_path(self) -> CommandPath:
        return self._path

    @property
    def mock_versions(self) -> MockVersionWatch:
        """What TRA-1211's `mock_version*` fields are read from. See
        ble_bridge.mock_version for why the bridge reports rather than rejects."""
        return self._mock_versions

    async def start(self) -> int:
        """Bind and begin serving. Returns the port actually bound.

        Returning the resolved port is what lets tests ask for an ephemeral one
        rather than colliding with a bridge someone else is running on 8080.
        """
        self._server = await serve(
            self._handle,
            self._config.ws_host,
            self._config.ws_port,
            process_request=self._process_request,
        )
        self._port = next(iter(self._server.sockets)).getsockname()[1]
        self._log_bind()
        return self._port

    def _process_request(self, _connection: ServerConnection, request: Request) -> Response | None:
        """Answer GET /status; let everything else proceed to the WS handshake.

        Returning None hands the request back to websockets, so a non-upgrade
        request to any other path still gets the 426 it has always got. That
        matters: a consumer probes this port over plain HTTP and treats any
        status as "listening".
        """
        if request.path.split("?", 1)[0] != status_endpoint.STATUS_PATH:
            return None
        code, headers, body = status_endpoint.encode(
            status_endpoint.status_payload(self._path, __version__),
            is_loopback=self._config.is_loopback,
        )
        return Response(code.value, code.phrase, Headers(headers), body)

    def _log_bind(self) -> None:
        """State the reachable address and the radio posture, not just the port.

        "The server is up" is identical evidence whether or not anything off-box
        can reach it, and whether or not it is holding a device. Both have
        misled an operator in this project already.
        """
        where = f"{self._config.ws_host}:{self._port}"
        if not self._config.is_loopback:
            # Not a security warning -- status.cors_headers() has already made
            # the unsafe combination unrepresentable by omitting CORS entirely
            # off loopback. This says what that costs, because a browser mock
            # pointed at a non-loopback bridge will find getAvailability()
            # blocked and the reason is not visible from the browser.
            logger.info(
                "%s is not loopback, so %s answers no cross-origin request: a "
                "browser mock pointed here cannot read availability",
                where,
                status_endpoint.STATUS_PATH,
            )
        if self._config.is_loopback:
            logger.info("bridge listening on %s (loopback: reachable only from this host)", where)
        else:
            logger.warning(
                "bridge listening on %s -- NOT loopback. Every host that can route here can "
                "drive the BLE device, and there is no authentication on this path.",
                where,
            )
        logger.info("no device is held until a client connects; disconnecting releases it")

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
            self._port = None

    async def _handle(self, ws: ServerConnection) -> None:
        try:
            params = parse_params(ws.request.path)
        except (MissingParametersError, InvalidParameterError) as exc:
            # bridge-server.ts:84 -- send the error, then close. No transport is
            # built and no claim is made, so a rejected connection never touches
            # the device.
            await _refuse(ws, str(exc), exc.code)
            return

        # Every connection, writer or observer, before the role branch: the
        # warning always covered both, and a counter that disagreed with the
        # warnings beside it would be read as a bug in one of them.
        self._mock_versions.observe(params.mock_version)

        if params.role is Role.OBSERVER:
            await self._observe(ws, params)
        else:
            await self._write(ws, params)

    # --- the writer -----------------------------------------------------------

    async def _write(self, ws: ServerConnection, params: ConnectionParams) -> None:
        try:
            claim = self._path.claim(
                params.session, force=params.force, mock_version=params.mock_version
            )
        except OwnershipError as exc:
            logger.warning("refused a writer for session %s: %s", params.session, exc)
            await _refuse(ws, str(exc), exc.code)
            return

        try:
            if claim.evicted is not None and not await self._take_over(ws, claim):
                return
            await self._relay(ws, params, claim)
        finally:
            claim.release()
            claim.torn_down.set()

    async def _take_over(self, ws: ServerConnection, claim: Claim) -> bool:
        """Displace the previous owner, then tell this client that it did.

        Returns False if the displaced connection did not let go, in which case
        this one has already been refused and must not go on to build a transport.

        The `warning` goes out BEFORE `connected`, and that ordering is the
        contract: a warning is interstitial, so the client logs it and keeps
        waiting on the handshake. Announcing a destructive act to the side that
        caused it is the structural half of the convention the 2026-08-23 incident
        produced -- the human half is announcing on both transitions.

        Until TRA-1162 the "logs it" half of that sentence was false. The client's
        handshake handler branched on `connected` and `error` and dropped anything
        else without a word, so this announcement reached the browser and vanished
        -- a guarantee asserted in a docstring and not implemented anywhere. Both
        client handlers now branch on it, and
        test_wire_types_have_a_typescript_consumer fails if either stops.
        """
        displaced = claim.evicted
        assert displaced is not None
        logger.warning(
            "session %s took the command path over from session %s with force=true",
            claim.session,
            displaced.session,
        )
        displaced.release()
        try:
            await asyncio.wait_for(displaced.torn_down.wait(), EVICTION_TEARDOWN_TIMEOUT_S)
        except TimeoutError:
            # Refuse rather than proceed. Building a second transport on top of one
            # that has not let go is how two links end up on one radio, and it would
            # look like success from here.
            logger.error(
                "session %s did not release its transport within %ss; refusing the takeover",
                displaced.session,
                EVICTION_TEARDOWN_TIMEOUT_S,
            )
            await _refuse(ws, p.TAKEOVER_STALLED_ERROR, p.ERR_TAKEOVER_STALLED)
            return False

        await ws.send(
            p.encode_warning(
                f"{p.TAKEOVER_WARNING_PREFIX} (session {displaced.session!r}). "
                f"{p.TAKEOVER_WARNING_ADVICE}"
            )
        )
        return True

    async def _relay(self, ws: ServerConnection, params: ConnectionParams, claim: Claim) -> None:
        transport = self._factory(params)
        loop = asyncio.get_running_loop()
        # None disables the timeout, which is the operator's explicit choice at
        # BLE_MCP_IDLE_TIMEOUT=0 -- never a timer configured to fire at once.
        idle = IdleTimer(self._config.idle_timeout) if self._config.idle_timeout else None

        def on_data(payload: bytes) -> None:
            # Synchronous, and called on the transport's loop: hand off and
            # return. Anything slower here blocks the notification source, which
            # in the ESPHome case also swallows exceptions into its own logger.
            #
            # Note what is NOT here: idle.stamp(). Outbound traffic must never
            # renew the lease -- see ble_bridge.ws.idle for why counting it makes
            # an abandoned session immortal.
            self._log_buffer.push_packet(RX, payload)
            loop.call_soon_threadsafe(claim.fan_out, payload)

        transport.set_data_callback(on_data)

        try:
            try:
                # Watch the socket ACROSS the acquisition.
                #
                # A close is authoritative everywhere else in this module -- four
                # `ConnectionClosed` handlers in the loops below -- and nothing
                # watched it here, at the one await that can run for the better
                # part of a minute. A client that gives up (its own bound firing,
                # the browser going away) left the bridge acquiring a device for a
                # caller that no longer existed, holding the writer slot until the
                # acquisition finished on its own.
                #
                # Measured 2026-08-29, rep 95 of platform's soak: the client
                # abandoned at 10003ms, the bridge completed the connection 12ms
                # later and took the claim FOR NOBODY, and the next three attempts
                # inside 370ms were all refused `Device is busy`. One slow connect
                # became a whole-file cascade.
                #
                # CANCELLED, not merely abandoned, and the difference is the whole
                # point: releasing the claim while the acquisition ran on in the
                # background would be a second claim on the radio wearing a
                # released label -- the same thing `_observe` exists to prevent.
                # The cancellation is awaited so the transport has finished
                # unwinding before the `finally` below calls `cleanup()` on it.
                acquiring = asyncio.create_task(transport.connect())
                hung_up = asyncio.create_task(ws.wait_closed())
                done, _ = await asyncio.wait(
                    {acquiring, hung_up}, return_when=asyncio.FIRST_COMPLETED
                )
                if acquiring not in done:
                    acquiring.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await acquiring
                    logger.info(
                        "session %s hung up during acquisition; cancelled it rather than "
                        "hold the command path for a client that is gone",
                        params.session,
                    )
                    return
                hung_up.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await hung_up
                device = acquiring.result()
            except TransportError as exc:
                # Say why. `_refuse` states the rule -- "never close silently" --
                # and letting this escape breaks it at the one moment it costs
                # most: the message the transport composed is the only thing that
                # tells a blocked operator to go and ask who has the reader
                # rather than go looking for a reader that is missing.
                #
                # Measured on hardware 2026-08-26 (TRA-1174): a second bridge on
                # the same ESP32 is refused after the 30s advertisement timeout
                # with exactly that diagnosis, and the client used to receive
                # `1011 internal error` instead. 1011 means "a condition with no
                # message"; there is a message.
                logger.warning("session %s could not connect: %s", params.session, exc)
                await _refuse(ws, str(exc), p.ERR_TRANSPORT_FAILED)
                return
            claim.ready(device)
            await ws.send(p.encode_connected(device.name, device.write_properties))
            logger.info("session %s owns the command path on %s", params.session, device.name)

            if idle is not None:
                # The transport is up: start counting from here, not from when the
                # handler was entered. Connecting can legitimately take most of
                # ADVERTISEMENT_TIMEOUT_S, and charging that to the client's idle
                # budget would shorten the timeout by an amount nobody configured.
                # `ble-session.ts:63` stamps on the same event, for the same reason.
                idle.stamp()
            loops: dict[str, asyncio.Task[Any]] = {
                "receiving": asyncio.create_task(
                    _receive_writer(ws, transport, idle=idle, log_buffer=self._log_buffer)
                ),
                "draining": asyncio.create_task(_drain(ws, claim.own_subscription)),
            }
            if idle is not None:
                loops["idle"] = asyncio.create_task(idle.wait_for_expiry())
            outcome = await _race(loops)
        finally:
            # TRA-1216. BEFORE cleanup(), not after: cleanup IS the 12-21ms window a
            # reconnecting client collides with, and a flag set on the far side of it
            # would only ever be true once there was nothing left to wait for -- a
            # condition nothing can satisfy, which is failure class 1 exactly.
            # `claim.release()` in _write's finally frees the slot after this returns;
            # the flag stays true across that too, so the whole window is covered.
            claim.closing = True
            await transport.cleanup()
            logger.info("session %s released the command path", params.session)

        if outcome.get("idle") is True:
            assert idle is not None
            logger.warning(
                "session %s released after %gs idle: no frame arrived from the client. "
                "Device notifications do not renew the lease, by design.",
                params.session,
                idle.timeout,
            )
            await _refuse(
                ws,
                f"{p.IDLE_TIMEOUT_ERROR_PREFIX} of {idle.timeout:g}s. "
                f"{p.IDLE_TIMEOUT_ERROR_ADVICE}",
                p.ERR_IDLE_TIMEOUT,
            )
        elif outcome.get("receiving") is not None:
            # The write failed. `_receive_writer` has already logged it; this is
            # the half that used to be missing entirely -- telling the client.
            await _refuse(ws, str(outcome["receiving"]), p.ERR_WRITE_FAILED)
        elif outcome.get("draining") is True and claim.evicted_by is not None:
            # Only an eviction ends the stream while the socket is still open.
            await _refuse(
                ws,
                f"{p.EVICTED_ERROR_PREFIX} (session {claim.evicted_by!r}).",
                p.ERR_EVICTED,
            )

    # --- the observer ---------------------------------------------------------

    async def _observe(self, ws: ServerConnection, params: ConnectionParams) -> None:
        """Attach read-only. No transport is built here, ever.

        Building one would be a second claim on the radio wearing an observer's
        label, which is the exact thing the role exists to prevent.
        """
        try:
            subscription = self._path.observe(params.session)
        except OwnershipError as exc:
            logger.warning("refused an observer for session %s: %s", params.session, exc)
            await _refuse(ws, str(exc), exc.code)
            return

        device = subscription.device
        assert device is not None  # observe() refuses a path that is not ready
        await ws.send(p.encode_connected(device.name, device.write_properties))
        logger.info("session %s is observing %s read-only", params.session, device.name)

        # No idle timer here, deliberately. An observer holds no device and no
        # command path, so there is nothing for a timeout to release -- and a
        # timer on this connection could not renew the writer's lease even if it
        # wanted to, because the two are separate connections.
        outcome = await _race(
            {
                "receiving": asyncio.create_task(_receive_observer(ws)),
                "draining": asyncio.create_task(_drain(ws, subscription)),
            }
        )
        if outcome.get("draining") is True:
            await _refuse(ws, p.STREAM_ENDED_ERROR, p.ERR_STREAM_ENDED)


# --- per-connection loops -----------------------------------------------------


async def _receive_writer(
    ws: ServerConnection,
    transport: BleTransport,
    *,
    idle: IdleTimer | None,
    log_buffer: LogBuffer,
) -> str | None:
    """Client -> device.

    Returns None on an ordinary hangup, or the sentence to send the client when a
    write failed. Returning it rather than raising is what keeps the failure out of
    `_race`'s cancellation path: the caller has to run `transport.cleanup()` first,
    and only then is the socket safe to write a final frame on.
    """
    try:
        async for raw in ws:
            frame = _write_or_none(raw)
            if frame is None:
                # Dropped by the relay, so it never reached the device: it must
                # not be recorded as traffic, must not renew the lease, and must
                # not be acknowledged. An ack here would let a client attribute
                # an outcome to a write that was never attempted.
                continue
            # The one place the idle clock is stamped. See ble_bridge.ws.idle.
            if idle is not None:
                idle.stamp()
            log_buffer.push_packet(TX, frame.payload)
            # Read once, BEFORE the write: the mode is a runtime knob and the ack
            # has to report the mode this write actually used, not whatever it is
            # by the time the ack is composed.
            mode = write_mode.describe()
            try:
                await transport.write(frame.payload)
            except TransportError as exc:
                # This used to raise into `gather(..., return_exceptions=True)`
                # and be discarded -- no log line at any level, and the client saw
                # only a socket close. The message names whether the proxy was
                # still reachable, so it is forwarded verbatim.
                logger.error("the write to the device failed: %s", exc)
                await _ack(ws, frame, ok=False, mode=mode, error=str(exc))
                return str(exc)
            except Exception as exc:
                logger.exception("the write to the device raised an unexpected error")
                sentence = f"{p.WRITE_FAILED_PREFIX}: {type(exc).__name__}: {exc}"
                await _ack(ws, frame, ok=False, mode=mode, error=sentence)
                return sentence
            await _ack(ws, frame, ok=True, mode=mode)
    except websockets.exceptions.ConnectionClosed:
        pass
    return None


async def _ack(
    ws: ServerConnection,
    frame: _WriteFrame,
    *,
    ok: bool,
    mode: str,
    error: str | None = None,
) -> None:
    """Report one write's outcome. Spec section 8.

    Sent BEFORE any teardown the failure triggers, so a client learns *which*
    write failed and only then that the session is over. `ok: false` is terminal
    today -- the caller still returns, the transport is still cleaned up, and the
    session-ending `error` still follows.
    """
    await ws.send(p.encode_write_ack(ok, mode=mode, write_id=frame.write_id, error=error))


async def _receive_observer(ws: ServerConnection) -> None:
    """Client -> nowhere. Every write is answered and discarded.

    The connection stays open on a refused write. Read-only must not mean
    disconnect-on-mistake: a debugging session that dies of its own typo is a trap
    rather than a role, and the client would reconnect -- as a writer.

    No `write_ack` here, deliberately: nothing was attempted, so there is no
    outcome to report. The refusal is the answer.
    """
    try:
        async for raw in ws:
            if _write_or_none(raw) is not None:
                await ws.send(
                    p.encode_error(p.OBSERVER_MAY_NOT_WRITE_ERROR, p.ERR_OBSERVER_MAY_NOT_WRITE)
                )
    except websockets.exceptions.ConnectionClosed:
        pass


@dataclass(frozen=True)
class _WriteFrame:
    """A `data` frame the relay accepted for writing, and the client's token for it.

    The token travels with the payload rather than being recovered later because
    the ack has to name the write it belongs to, and the frame is the only place
    that association exists.
    """

    payload: bytes
    write_id: Any | None


def _write_or_none(raw: str | bytes) -> _WriteFrame | None:
    """The write a `data` frame asks for, or None for anything this relay ignores.

    Undecodable and malformed frames are dropped rather than fatal: one bad frame
    must not tear down a session mid-soak. A dropped frame is also never
    acknowledged -- nothing was attempted, so there is no outcome to report.
    """
    try:
        msg = p.decode(raw)
    except p.ProtocolError as exc:
        logger.warning("dropped an undecodable frame: %s", exc)
        return None
    if p.message_type(msg) != p.MSG_DATA:
        return None
    try:
        return _WriteFrame(p.data_payload(msg), p.write_id(msg))
    except p.ProtocolError as exc:
        logger.warning("dropped a malformed data frame: %s", exc)
        return None


async def _drain(ws: ServerConnection, subscription: Subscription) -> bool:
    """Device -> client. Returns True if the stream ended, False if the socket did.

    One sender task per connection, so notifications keep their order. Awaiting
    ws.send inside the transport callback would block the notification source;
    spawning a task per notification would let them race and arrive out of order,
    which the firehose's sequence-gap accounting would report as loss.
    """
    while True:
        payload = await subscription.queue.get()
        if isinstance(payload, type(END_OF_STREAM)):
            return True
        try:
            await ws.send(p.encode_data(payload))
        except websockets.exceptions.ConnectionClosed:
            return False


async def _race(loops: dict[str, asyncio.Task[Any]]) -> dict[str, Any]:
    """Run every loop until one stops, cancel the rest, and report what each returned.

    A cancelled loop reports None, so the caller can tell "this is why the session
    ended" from "this was still running when it did". That distinction is what lets
    an evicted client be told why instead of just dropped, and now also separates
    an idle release from a hangup.

    **Exceptions are logged, never discarded.** The previous version ended with
    `await asyncio.gather(..., return_exceptions=True)` and then looked only at the
    drain task, so anything the receive loop raised was collected into a list that
    nobody read. That is where a failed device write went to die: not swallowed by
    a bare `except`, which review would have caught, but by a `gather` whose whole
    job is to collect exceptions and hand them to someone.
    """
    tasks = list(loops.values())
    await asyncio.wait(set(tasks), return_when=asyncio.FIRST_COMPLETED)
    for task in tasks:
        if not task.done():
            task.cancel()
    results = await asyncio.gather(*tasks, return_exceptions=True)

    outcome: dict[str, Any] = {}
    for name, result in zip(loops, results, strict=True):
        if isinstance(result, asyncio.CancelledError):
            outcome[name] = None
        elif isinstance(result, BaseException):
            logger.exception("the %s loop raised", name, exc_info=result)
            outcome[name] = None
        else:
            outcome[name] = result
    return outcome


async def _refuse(ws: ServerConnection, message: str, code: str) -> None:
    """Say why, then close. Never close silently.

    `code` is required at every call site. It is what the client discriminates
    on; the message is prose for a human reading a log.
    """
    try:
        await ws.send(p.encode_error(message, code))
    except websockets.exceptions.ConnectionClosed:
        return
    await ws.close()

