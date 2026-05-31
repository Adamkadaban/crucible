#!/usr/bin/env bash
# Minimal QEMU launcher for boot-attachment debugging.
# Usage: scripts/launch-test.sh <variant>
#   port0  - ich9-ahci ide-cd on port 0 (instead of port 1)
#   sata-only - same as port0 but only Windows ISO (no other media)
#   usb    - qemu-xhci + usb-storage
#   scsi-cd - virtio-scsi-pci + scsi-cd
#   cdrom-flag - QEMU -cdrom shorthand
set -euo pipefail
VARIANT="${1:?variant required}"
ART=artifacts
WIN_ISO="${WIN_ISO:-${ART}/media/windows.iso}"
DISK="${ART}/disks/crucible-win11.qcow2"
OVMF_CODE="/usr/share/OVMF/OVMF_CODE_4M.fd"
OVMF_VARS_SRC="/usr/share/OVMF/OVMF_VARS_4M.fd"
OVMF_VARS="${ART}/boot/test.OVMF_VARS.fd"
mkdir -p "${ART}/boot" "${ART}/logs" "${ART}/disks"
# Fresh vars + disk every run so behavior is deterministic
cp "$OVMF_VARS_SRC" "$OVMF_VARS"
[ -f "$DISK" ] && rm -f "$DISK"
qemu-img create -f qcow2 "$DISK" 64G >/dev/null

COMMON=(
  -name crucible-test
  -machine q35,accel=kvm
  -cpu host -smp 2 -m 4096
  -drive if=pflash,format=raw,readonly=on,file="$OVMF_CODE"
  -drive if=pflash,format=raw,file="$OVMF_VARS"
  -device virtio-scsi-pci,id=scsi0
  -drive file="$DISK",if=none,format=qcow2,id=disk0,cache=none,discard=unmap
  -device scsi-hd,drive=disk0,bus=scsi0.0,bootindex=2
  -boot menu=on,splash-time=2000
  -qmp unix:"${ART}/qmp.sock",server=on,wait=off
  -monitor unix:"${ART}/mon.sock",server=on,wait=off
  -serial file:"${ART}/logs/serial.log"
  -debugcon file:"${ART}/logs/ovmf-debug.log" -global isa-debugcon.iobase=0x402
  -nodefaults -vga std
  -display none
)

case "$VARIANT" in
  port0)
    EXTRA=(
      -device ich9-ahci,id=sata0
      -drive file="$WIN_ISO",media=cdrom,if=none,readonly=on,id=cd0
      -device ide-cd,drive=cd0,bus=sata0.0,bootindex=1
    );;
  usb)
    EXTRA=(
      -device qemu-xhci,id=usb0
      -drive file="$WIN_ISO",media=cdrom,if=none,readonly=on,id=cd0
      -device usb-storage,drive=cd0,removable=true,bus=usb0.0,bootindex=1
    );;
  scsi-cd)
    EXTRA=(
      -drive file="$WIN_ISO",media=cdrom,if=none,readonly=on,id=cd0
      -device scsi-cd,drive=cd0,bus=scsi0.0,bootindex=1
    );;
  cdrom-flag)
    EXTRA=(
      -cdrom "$WIN_ISO"
    );;
  *) echo "unknown variant: $VARIANT" >&2; exit 2;;
esac

LOG="${ART}/logs/qemu-${VARIANT}.log"
echo "[launch] variant=${VARIANT}, log=${LOG}" >&2
set -x
qemu-system-x86_64 "${COMMON[@]}" "${EXTRA[@]}" >"$LOG" 2>&1 &
echo $! > "${ART}/qemu.pid"
set +x
echo "[launch] pid=$(cat ${ART}/qemu.pid)"
