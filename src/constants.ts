/**
 * Cross-seam string and code contracts.
 *
 * What lives here is anything a CONSUMER or the PYTHON BRIDGE can observe and
 * make a decision on. Keeping it in one file is what lets a guard exist at all:
 * a value that is inlined at its use site cannot be pinned, named in a contract,
 * or imported by the consumer that depends on it.
 */

/**
 * Connect refusals the mock may retry, matched on the wire `code`.
 *
 * ⚠ These are CODES, not message text. Until 0.12.0 this list held message
 * SUBSTRINGS -- and it had already decayed once in a way nothing could catch:
 * it named three strings the Python bridge has never sent, so the retry branch
 * was unreachable and `maxConnectRetries` could not fire. Its symptom was the
 * ABSENCE of a retry, and nothing fails when a retry that would have succeeded
 * never happens.
 *
 * A code cannot decay that way. It is a closed set on the bridge
 * (`ERROR_CODES` in ws/protocol.py, enforced by `encode_error`), and
 * `test_every_retryable_code_is_one_we_send` compares this list against it
 * mechanically across the language boundary.
 *
 * ## `DEVICE_BUSY` is deliberately NOT here, and `DEVICE_BUSY_SELF` is
 *
 * `DEVICE_BUSY` is a loud refusal -- a LIVE foreign connection owns the command
 * path, and no amount of waiting changes that. Retrying it converts a precise
 * refusal into a long pause followed by some other failure, which is the same
 * failure class again. `test_the_busy_refusal_is_not_one_the_mock_silently_retries`
 * enforces it from the Python side.
 *
 * `DEVICE_BUSY_SELF` (TRA-1216, 0.16.0) is the one busy case where waiting is
 * exactly what fixes it: the holder is our OWN previous connection and it is
 * already tearing down. Measured over platform's 200-rep arm, all 63 such
 * refusals released within 21ms -- the bridge's own close-processing cost, the
 * same number `postDisconnectDelay: 250` is built on. The existing connect retry
 * covers it with roughly 12x margin on the first step alone, so this adds a code
 * and no knob.
 *
 * ⚠ **The bridge does not decide this on the session id.** It gates on the holder
 * actually closing; the session match only narrows it. Both repos derive the
 * session id from the hostname on purpose, so two live processes on one host share
 * a name -- keying on the name alone would retry against a genuine foreign holder.
 *
 * ⚠ **A client that does not PIN a session id gets nothing from this.** An absent
 * `session` is filled with a fresh uuid4 per connection, so a reconnecting
 * anonymous client never matches its own prior id and always sees plain
 * `DEVICE_BUSY`. That is correct: the bridge has no identity to match on and must
 * not invent one.
 *
 * ## An error frame with no code is NOT retried
 *
 * Absent is not retryable. That is the safe direction and it is deliberate: a
 * missing code means the two sides disagree about the protocol, and guessing is
 * how a silent fallback gets built.
 */
export const RETRYABLE_CONNECT_CODES: readonly string[] = [
  // ownership.py CommandPathNotReady -> protocol.py ERR_NOT_READY. The path is
  // claimed but its device link is not up yet.
  'NOT_READY',
  // ownership.py CommandPathBusySelf -> protocol.py ERR_DEVICE_BUSY_SELF. Our own
  // previous connection still holds the path and is already releasing it.
  'DEVICE_BUSY_SELF'
];

/**
 * Why a CONNECT failed, on the error the mock rejects with.
 *
 * Two sources, deliberately one namespace:
 *
 * - a `code` the bridge put on its `error` frame (see ERROR_CODES in
 *   ws/protocol.py) -- a refusal the server chose to send
 * - a locally-detected failure, below -- the socket died or closed before the
 *   handshake finished, so there was no frame to carry a code
 *
 * A consumer reads `err.code` either way and never parses `err.message`.
 */
export const CONNECT_ERROR_CODES = {
  /** The socket errored. No frame, so the bridge said nothing. */
  SOCKET_ERROR: 'SOCKET_ERROR',
  /**
   * The socket closed before `connected` arrived.
   *
   * Before 0.12.0 this case had no rejection at all -- only close codes
   * 4000-4999 failed the handshake, and the bridge has never sent one, so the
   * caller waited out the full 10s connect timeout instead.
   */
  CLOSED_BEFORE_CONNECTED: 'CLOSED_BEFORE_CONNECTED',
  /** The handshake did not finish inside the connect timeout. */
  TIMEOUT: 'TIMEOUT'
} as const;

/** Every connect rejection carries a `code`; `name` is `'ConnectError'`. */
export class ConnectError extends Error {
  readonly name = 'ConnectError';
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Build a connect rejection.
 *
 * `code` is optional ONLY because a bridge frame might arrive without one, and
 * that case must be visible rather than papered over: it becomes `UNTYPED`,
 * which is not in RETRYABLE_CONNECT_CODES and therefore never retried. Absent is
 * not retryable -- a missing code means the two sides disagree about the
 * protocol, and guessing is how a silent fallback gets built.
 */
export function connectError(message: string, code?: string): ConnectError {
  return new ConnectError(message, code ?? 'UNTYPED');
}

/**
 * Why a write failed, as a value a consumer can branch on.
 *
 * ## Why this exists at all
 *
 * Until 0.10.0 every write rejection was a bare `Error`, so the only thing a
 * consumer could discriminate on was the message text. Platform's transport did
 * exactly that -- `isRetryable()` matched `'GATT operation already in progress'`
 * and `'Device busy'` as substrings. That worked only because the ack-timeout
 * message happens not to contain either phrase.
 *
 * Which made an unreferenced string literal in `ws-transport.ts` load-bearing
 * across two repositories: rewording it to include the word "busy" -- an
 * entirely reasonable-looking edit here -- would have made the timeout retryable
 * on their side, and their retry loop would then have run past the command
 * timeout that owns it. **Nothing in this repository would have gone red.** The
 * only guard was a test in the consumer's repository, which is the one place a
 * change here cannot be seen.
 *
 * A code is a real interface. Prose is not, however carefully it is worded.
 *
 * ## Read `mayHaveReachedDevice`, not the code, to decide about retrying
 *
 * The code answers "what happened"; `mayHaveReachedDevice` answers the only
 * question a retry actually turns on. They are separate on purpose: a consumer
 * that enumerates codes it considers safe will silently misclassify the next
 * code added here, which is the same failure this whole change exists to end.
 * A consumer that reads the property cannot.
 */
export const WRITE_ERROR_CODES = {
  /** No `write_ack` arrived inside the cap. See `WriteError.mayHaveReachedDevice`. */
  ACK_TIMEOUT: 'ACK_TIMEOUT',
  /** The bridge acknowledged the write and said it failed (`write_ack{ok:false}`). */
  WRITE_REJECTED: 'WRITE_REJECTED',
  /** The link went away while the write was in flight. */
  LINK_LOST: 'LINK_LOST',
  /** There was no open socket to write to; the frame never left. */
  NOT_CONNECTED: 'NOT_CONNECTED'
} as const;

export type WriteErrorCode = typeof WRITE_ERROR_CODES[keyof typeof WRITE_ERROR_CODES];

/**
 * Which write failures may already have reached the device.
 *
 * ⚠ **A write that may have reached the device must not be retried blindly** --
 * the retry is a second write, and for a stateful device protocol a duplicate
 * command is not the same thing as a lost one.
 *
 * `ACK_TIMEOUT` is the whole reason this distinction is a value rather than a
 * comment: a timeout says only that no acknowledgement came back inside the cap.
 * The write may have been delivered and the ack lost, or delayed past the cap.
 * The bridge cannot tell the difference and neither can the client.
 *
 * The other three are definite non-delivery: `NOT_CONNECTED` never reached the
 * socket, `LINK_LOST` had the link fail underneath it, and `WRITE_REJECTED` is
 * the bridge itself reporting the write did not happen.
 *
 * ⚠ **`false` here is NECESSARY for a retry, not SUFFICIENT.** It answers only
 * "can a retry duplicate this write". Whether a retry is WORTH anything is a
 * question about the consumer's link, which this package cannot see: `LINK_LOST`
 * and `NOT_CONNECTED` are both non-duplicative and both pointless to retry, and
 * platform's TRA-1179 note records the harm -- if the link comes back, the retry
 * lands a STALE command on a FRESH connection. Do not read this as a
 * retry-worthiness flag.
 */
const MAY_HAVE_REACHED_DEVICE: Record<WriteErrorCode, boolean> = {
  [WRITE_ERROR_CODES.ACK_TIMEOUT]: true,
  [WRITE_ERROR_CODES.WRITE_REJECTED]: false,
  [WRITE_ERROR_CODES.LINK_LOST]: false,
  [WRITE_ERROR_CODES.NOT_CONNECTED]: false
};

/**
 * Every rejection from a write path carries one of these.
 *
 * `name` is `'WriteError'` and `code` is a `WriteErrorCode`, so a consumer can
 * discriminate without reading `message`. The message stays human prose and is
 * free to be reworded -- that freedom is the point.
 */
export class WriteError extends Error {
  readonly name = 'WriteError';
  readonly code: WriteErrorCode;
  /** Whether the write may already have been delivered. See the table above. */
  readonly mayHaveReachedDevice: boolean;

  constructor(code: WriteErrorCode, message: string) {
    super(message);
    // Throw rather than carry `undefined`. Two ways to get here: a new code
    // added without a MAY_HAVE_REACHED_DEVICE entry, and `new WriteError(msg,
    // code)` with the arguments swapped -- which platform hit while probing the
    // surface and which silently produced `mayHaveReachedDevice: undefined`.
    // An error object that lies about the one property a retry turns on is
    // worse than a constructor that refuses to build it.
    if (!(code in MAY_HAVE_REACHED_DEVICE)) {
      throw new TypeError(
        `WriteError: unknown code ${JSON.stringify(code)}. Every code must declare ` +
        'whether the write may have reached the device. Check the argument order: ' +
        'the code comes first, the message second.'
      );
    }
    this.code = code;
    this.mayHaveReachedDevice = MAY_HAVE_REACHED_DEVICE[code];
  }
}

/**
 * How long `gatt.connect()` waits before giving up on a socket that has said
 * nothing at all.
 *
 * ## This is a BACKSTOP, not a policy, and it should never fire
 *
 * The bridge always answers: it bounds its own acquisition (occupancy check,
 * then the advertisement wait, then the BLE connect) and refuses with a typed
 * error when that budget runs out. So a caller waiting on a healthy bridge is
 * answered well inside this number, and the only thing it catches is a socket
 * that will never produce a frame OR a close -- a half-open TCP connection
 * where the bridge process is gone without a FIN. That is a genuine hang, not a
 * slow reader.
 *
 * Real `gatt.connect()` takes no timeout argument and can stay pending
 * indefinitely. This is as close to that as is possible while still bounding a
 * dead socket, which is why it sits far above the bridge's budget rather than
 * anywhere near the observed connect distribution.
 *
 * ## Why the old value was wrong, and why it survived
 *
 * It was `10000`, written 2025-07-20 in this repo's second commit against a
 * LOCAL NOBLE RADIO, where a connect either worked in about a second or did
 * not. The ESPHome transport arrived 2026-08-23 -- thirteen months later --
 * bringing a 30s advertisement wait that is structural rather than defensive.
 * Nobody ever decided 10 < 30; the constant simply outlived the architecture
 * that justified it, and nothing compared the two numbers because the
 * comparison lived between two repositories and belonged to neither.
 *
 * The cost, measured 2026-08-29 across 654 connects: the 10s bound sat INSIDE
 * the observed distribution rather than outside it (max 9038ms, 19% over 5s),
 * so it was not clipping an anomaly -- it was the expected consequence of a
 * deadline placed in the middle of a population. It also truncated the
 * bridge's most informative failure, "in use or absent", before it could ever
 * be delivered.
 *
 * ## Derived, not chosen
 *
 * `connect-timeout-nesting.test.ts` fails if this stops exceeding the bridge's
 * own budget, read out of `esphome.py`. Keep it that way: two independently
 * written numbers in two languages is precisely how 10-vs-30 happened.
 *
 * Derivation against the bridge's budget as it stands today:
 *
 *     ALLOCATION_REPORT_TIMEOUT_S     2s   occupancy check
 *     ADVERTISEMENT_TIMEOUT_S        30s   then -- sequential, not overlapping
 *     CONNECT_TIMEOUT_S              20s
 *                                   ----
 *     bridge worst case              52s   before it refuses with a typed error
 *     x1.2 margin                  62.4s   minimum for this to back the bridge
 *                                          up rather than race it
 *
 * 75s clears that. It stays correct if `ADVERTISEMENT_TIMEOUT_S` is later cut
 * to 15s (worst case 37s, margin 2x) -- a backstop only has to be far enough
 * above the budget that it never fires, so a shrinking budget can never
 * invalidate it. The first draft of this constant was 60_000, and the test
 * above rejected it: at a 52s budget that is 1.15x, close enough that the
 * bridge's refusal and the client's giving-up would arrive together and the
 * caller would get a bare `TIMEOUT` instead of the diagnosis the bridge
 * composed. Which is the failure this whole change exists to remove.
 */
export const CONNECT_BACKSTOP_MS = 75_000;
