## PREREQUISITE:
- See documentation first this is a second pass at this PRP with added clarifications

## FEATURE:
Enhance bridge server logging by adding byte stream traffic to logs so that tests that consume that log can verify what was sent to and received from device
- Show all byte traffic with clear prefixes like [TX] and [RX]
- Format bytes in hex (e.g., [TX] A7 B3 C2 01 00 00 00 00 B3 A7)
- add a quiet flag or alternative log stream command to suppress the TX/RX byte stream data
  - Perhaps the quiet mode log should just log basic connect disconnect activity and omit BLE scan activity as well
- bump package version to 0.2.0
- Add log level usage instructions to README.md
- Add a ./CHANGELOG.md with a description of this release. We can describe 0.1.0 as Initial Release

## EXAMPLES:
[TX] A7 B3 C2 01 00 00 00 00 B3 A7
[RX] B3 A7 C2 01 00 00 00 00 A7 B3
[RX] B3 A7 02 01 00 18 30 00 00 00 00 00 00 00 00 00 00 00 00 00 00 09 12 34 56 78 00 00 A7 B3

## DOCUMENTATION:
- First rev PRP is at prp/prompts/add-bytestream-logging.md. I added a number of clarifications under other considerations. Please review those and update the PRP output as needed
- Changelog best practices https://keepachangelog.com/en/1.1.0/

### Conversation from Claude Code debuggng session that inspired this change
> i think that we need the option to show actual byte traffic in the bridge server log. should that be optional or
should it always show that? probably make that the default but add a quiet mode that suppresses it. think hard
about what would best enable your current efforts. i will update web-ble-bridge accordingly

● For debugging E2E tests, having byte traffic in the bridge logs by default would be extremely helpful! Here's
what would best enable testing efforts:

Default behavior (verbose mode):
- Show all byte traffic with clear prefixes like [TX] and [RX]
- Format bytes in hex (e.g., [TX] A7 B3 C2 01 00 00 00 00 B3 A7)
- Include timestamp for each packet
- Show command/response interpretation if known (e.g., [TX] START_INVENTORY command)

Quiet mode (opt-in via flag):
- Current behavior - just connection/disconnection events
- Useful for production or when byte-level detail isn't needed

This would help because right now when inventory doesn't start, I can't see:
1. If the START_INVENTORY command (0x0001) was actually sent
2. If the device responded with an error
3. If packets are being fragmented incorrectly
4. If there's a protocol mismatch

Example of ideal log output:
[2025-07-23T10:15:23.456Z] [TX] A7 B3 C2 01 00 00 00 00 B3 A7 (START_INVENTORY)
[2025-07-23T10:15:23.467Z] [RX] B3 A7 C2 01 00 00 00 00 A7 B3 (START_INVENTORY_RESPONSE)

This would immediately show if commands are being sent and what responses we're getting back.

> is the timestamp helpful or is it noise/overhead?

● For debugging E2E tests, timestamps are mostly noise/overhead. The sequence and order of packets is what matters
most, not the precise timing.

Better format without timestamps:
[TX] A7 B3 C2 01 00 00 00 00 B3 A7 (START_INVENTORY)
[RX] B3 A7 C2 01 00 00 00 00 A7 B3 (START_INVENTORY_RESPONSE)
[RX] B3 A7 02 01 00 18 30 00 00 00 00 00 00 00 00 00 00 00 00 00 00 09 12 34 56 78 00 00 A7 B3 (TAG_DATA)

The existing log entries already have timestamps in the JSON wrapper, so adding them to each packet line would be
redundant. The clean format above would make it much easier to:
- Spot missing commands
- See response patterns
- Identify malformed packets
- Follow the conversation flow

If someone needs precise timing, they can look at the JSON timestamps. But for debugging "why isn't inventory
starting?", the packet sequence is what's crucial.

## OTHER CONSIDERATIONS:
### Clarifications:
1. Which logs should remain at info level? --> Good point re those message types. the main concern is to suppress the very verbose scanner device discovery and the newly added byte traffic logs
   - The PRP says "only log connections/disconnections" but what about:
   - "Starting WebSocket server on..."
   - "Noble state changed to..."
   - Error messages?
2. Invalid LOG_LEVEL handling? --> let's make a best effort attempt to map the common log levels and note in our documentation that verbose and trace map to debug, warn maps to info, etc
   - If someone sets LOG_LEVEL=verbose or LOG_LEVEL=trace, should we:
  - Default to debug silently?
  - Log a warning and default?
  - Throw an error?
3. formatHex duplication --> it sounds reasonable to add a utils.ts helper function library
   - The PRP says "add to top of files that need it" but both bridge-server.ts and potentially noble-transport.ts
   need it. Should we:
  - Duplicate the function?
  - Create a minimal utils file (breaking the "no new files" guideline)?
  - Define it once and pass it around?
4. Type definition location --> NO DUPLICATE!!! in order of preference: constants.ts (yes, a new file), utils.ts, start-server.ts
   - Where should type LogLevel = 'debug' | 'info' | 'warn' | 'error' live?
  - Duplicate in each file?
  - In start-server.ts and pass down?
5. Scan logs specificity --> all the unmatched device names and UUIDS. Found device X or device not found will likely suffice. scanner start/stop seems more like debug to me
   - What exactly counts as "scan logs" to hide at info level?
  - Just "Found device: X"?
  - Also "Scanning started/stopped"?
  - Noble state changes related to scanning?
