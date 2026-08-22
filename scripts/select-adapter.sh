#!/bin/bash
# Select which Bluetooth radio the bridge can see, by binding/unbinding btusb.
#
# The bridge picks its adapter with `adapters.nth(0)` and has no selection logic,
# and BlueZ's AutoEnable=true re-powers anything it can see — so `hciconfig down`
# does not stick. Making the unwanted radio disappear from the USB driver is the
# only reliable way to pin the choice.
#
#   ./scripts/select-adapter.sh asus     # ASUS dongle only  (Realtek, BT 5.4)
#   ./scripts/select-adapter.sh intel    # NUC built-in only (Intel, BT 4.2)
#   ./scripts/select-adapter.sh both     # restore both
#   ./scripts/select-adapter.sh status   # show current state

set -u

ASUS_USB="1-1:1.0"       # 0b05:1bf6 ASUSTek / Realtek
INTEL_USB="1-5.1:1.0"    # 8087:0a2a Intel Corp.
DRV=/sys/bus/usb/drivers/btusb

bind()   { [ -e "$DRV/$1" ] || sudo -n sh -c "echo $1 > $DRV/bind"   2>/dev/null; }
unbind() { [ -e "$DRV/$1" ] && sudo -n sh -c "echo $1 > $DRV/unbind" 2>/dev/null; }

status() {
  echo "  bound to btusb: $(ls "$DRV" 2>/dev/null | grep -E '^[0-9]' | tr '\n' ' ')"
  for h in /sys/class/bluetooth/hci*; do
    [ -e "$h" ] || continue
    n=$(basename "$h")
    case "$n" in *:*) continue;; esac   # skip per-connection objects (hci0:12)
    p=$(readlink -f "$h/device")
    printf "  %s -> %s %s\n" "$n" \
      "$(cat "$p/../idVendor" 2>/dev/null):$(cat "$p/../idProduct" 2>/dev/null)" \
      "$(cat "$p/../manufacturer" 2>/dev/null)"
  done
  [ -e /sys/class/bluetooth/hci0 ] || echo "  (no adapters present)"
}

case "${1:-status}" in
  asus)  unbind "$INTEL_USB"; bind "$ASUS_USB";  echo "→ ASUS dongle only";;
  intel) unbind "$ASUS_USB";  bind "$INTEL_USB"; echo "→ Intel built-in only";;
  both)  bind "$ASUS_USB";    bind "$INTEL_USB"; echo "→ both adapters";;
  status) ;;
  *) echo "usage: $0 {asus|intel|both|status}"; exit 1;;
esac

sleep 3
status
