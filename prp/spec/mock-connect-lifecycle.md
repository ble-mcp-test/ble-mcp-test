ble-mcp-test Bridge Connection Validation Requirements

  FEATURE:

  Fix phantom connections in ble-mcp-test bridge where WebSocket connects successfully but BLE hardware connection
  fails, causing tests to fail with missing characteristics.

  PROBLEM:

  Currently the bridge allows WebSocket connections to persist even when:
  1. CS108 hardware is not found ("No devices found with service variants")
  2. BLE connection to hardware fails
  3. Service/characteristics cannot be obtained

  This creates phantom connections where:
  - WebSocket is connected to bridge
  - Client UI shows "connected" (disconnect button appears)
  - __TRANSPORT_MANAGER__ exists
  - But notifyCharacteristic is null (no BLE connection)
  - Tests fail because simulateNotification cannot be added to null characteristic

  REQUIREMENTS:

  1. Atomic Connection Validation

  The bridge MUST validate the complete connection stack before accepting WebSocket:
  // Pseudocode for connection flow
  onWebSocketConnect() {
    // 1. Find BLE device
    const device = await findDevice(serviceUUID);
    if (!device) {
      ws.close(1002, "Hardware not found");
      return;
    }

    // 2. Connect to GATT server
    const server = await device.gatt.connect();
    if (!server) {
      ws.close(1002, "GATT connection failed");
      return;
    }

    // 3. Get service
    const service = await server.getPrimaryService(serviceUUID);
    if (!service) {
      ws.close(1002, "Service not found");
      return;
    }

    // 4. Get characteristics
    const writeChar = await service.getCharacteristic(writeUUID);
    const notifyChar = await service.getCharacteristic(notifyUUID);
    if (!writeChar || !notifyChar) {
      ws.close(1002, "Characteristics not found");
      server.disconnect();
      return;
    }

    // 5. ONLY NOW accept the WebSocket connection
    ws.accept();
    attachCharacteristics(writeChar, notifyChar);
  }

  2. WebSocket Must Reflect BLE State

  - If BLE connection fails → WebSocket MUST disconnect
  - If BLE disconnects → WebSocket MUST disconnect
  - No orphaned WebSocket connections without BLE

  3. Client Mock Must Propagate Failures

  When WebSocket disconnects due to hardware issues:
  - Mock must NOT show connection as successful
  - TransportManager must NOT be created with null characteristics
  - UI must show connection failure (not disconnect button)

  4. Add simulateNotification to Real Characteristics

  When connected to real hardware via bridge:
  - The bridge must add simulateNotification method to the real characteristic
  - This allows tests to inject packets while using real hardware
  // After successful BLE connection
  notifyChar.simulateNotification = (data) => {
    // Inject data as if received from hardware
    const event = new Event('characteristicvaluechanged');
    event.target = notifyChar;
    event.target.value = new DataView(data.buffer);
    notifyChar.dispatchEvent(event);
  };

  VALIDATION:

  After implementation, these conditions MUST hold:
  // 1. No phantom connections
  if (ws.connected && !bleDevice.connected) → ERROR

  // 2. Characteristics exist when connected
  if (disconnectButton.visible) {
    assert(tm.notifyCharacteristic !== null);
    assert(tm.notifyCharacteristic.simulateNotification !== undefined);
  }

  // 3. WebSocket closes on BLE failure
  onBLEError() → ws.close()

  TESTING:

  1. Start bridge with no CS108 hardware available
  2. Attempt connection from client
  3. Verify:
    - WebSocket disconnects with clear error
    - UI does not show "connected"
    - No TransportManager with null characteristics
    - Test fails cleanly with "Hardware not available" message

  EXAMPLES:

  Current broken flow:
  Client → WebSocket connects → Bridge can't find hardware → WebSocket stays open → UI shows connected → notifyChar
  is null → Test fails

  Required flow:
  Client → WebSocket attempts → Bridge can't find hardware → WebSocket closes → UI shows error → Test skips/fails
  cleanly

  OTHER CONSIDERATIONS:

  - The bridge serves real hardware connections for E2E testing
  - This is NOT a pure mock - hardware is required
  - Tests should skip/fail cleanly when hardware unavailable
  - No resource leaks from orphaned WebSocket connections

  Todos
  ☐ Fix mock connection race condition
  ☐ Clean up WebSocket connections on failure
  ☐ Add connection validation
