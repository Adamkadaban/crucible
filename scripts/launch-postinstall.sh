#!/usr/bin/env bash
# Boot the already-installed Windows image (no install media attached).
set -euo pipefail
ART=artifacts
DISK="${ART}/disks/crucible-win11.qcow2"
OVMF_CODE="/usr/share/OVMF/OVMF_CODE_4M.fd"
OVMF_VARS="${ART}/boot/crucible-win11.OVMF_VARS.fd"
rm -f "${ART}/qmp.sock" "${ART}/qga.sock"
LOG="${ART}/logs/qemu-postinstall.log"
mkdir -p "${ART}/logs"
echo "[launch] log=$LOG"
set -x
qemu-system-x86_64 \
  -name crucible-postinstall \
  -machine q35,accel=kvm -cpu host -smp 4 -m 8192 \
  -drive if=pflash,format=raw,readonly=on,file="$OVMF_CODE" \
  -drive if=pflash,format=raw,file="$OVMF_VARS" \
  -device virtio-scsi-pci,id=scsi0 \
  -drive file="$DISK",if=none,format=qcow2,id=disk0,cache=none,discard=unmap \
  -device scsi-hd,drive=disk0,bus=scsi0.0,bootindex=1 \
  -netdev user,id=net0,restrict=on,net=192.0.2.0/30,host=192.0.2.1,dhcpstart=192.0.2.2,hostfwd=tcp:127.0.0.1:8443-192.0.2.2:8443 \
  -device virtio-net-pci,netdev=net0 \
  -device virtio-serial-pci \
  -chardev socket,path="${ART}/qga.sock",server=on,wait=off,id=qga0 \
  -device virtserialport,chardev=qga0,name=org.qemu.guest_agent.0 \
  -qmp unix:"${ART}/qmp.sock",server=on,wait=off \
  -nodefaults -vga std -display none \
  >"$LOG" 2>&1 &
echo $! > "$ART/qemu.pid"
set +x
echo "[launch] pid=$(cat $ART/qemu.pid)"
