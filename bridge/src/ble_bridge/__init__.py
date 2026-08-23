"""The Python WebSocket relay for ble-mcp-test.

Test tooling only. This bridge is never part of a production path: the product
reaches a BLE device through `navigator.bluetooth` directly, and this package
exists so tests can drive real hardware from Node and headless browsers.
"""

__version__ = "0.1.0"
