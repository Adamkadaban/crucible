#!/usr/bin/env bash
# Full unattended boot: Windows ISO + autounattend ISO + virtio ISO on ich9-ahci ports 0/1/2
set -euo pipefail
ART=artifacts
WIN_ISO="${WIN_ISO:-${ART}/media/windows.iso}"
AUTO_ISO="${ART}/boot/autounattend.iso"
VIRTIO_ISO="${VIRTIO_ISO:-${ART}/media/virtio.iso}"
DISK="${ART}/disks/crucible-win11.qcow2"
OVMF_CODE="/usr/share/OVMF/OVMF_CODE_4M.fd"
OVMF_VARS_SRC="/usr/share/OVMF/OVMF_VARS_4M.fd"
OVMF_VARS="${ART}/boot/test.OVMF_VARS.fd"
mkdir -p "${ART}/boot" "${ART}/logs" "${ART}/disks"
cp "$OVMF_VARS_SRC" "$OVMF_VARS"
rm -f "$DISK"; qemu-img create -f qcow2 "$DISK" 64G >/dev/null
rm -f "$ART/qmp.sock" "$ART/qga.sock"
LOG="${ART}/logs/qemu-fullflow.log"
echo "[launch] log=$LOG"
set -x
qemu-system-x86_64 \
  -name crucible-fullflow \
  -machine q35,accel=kvm -cpu host -smp 4 -m 8192 \
  -drive if=pflash,format=raw,readonly=on,file="$OVMF_CODE" \
  -drive if=pflash,format=raw,file="$OVMF_VARS" \
  -device virtio-scsi-pci,id=scsi0 \
  -drive file="$DISK",if=none,format=qcow2,id=disk0,cache=none,discard=unmap \
  -device scsi-hd,drive=disk0,bus=scsi0.0,bootindex=10 \
  -device ich9-ahci,id=sata0 \
  -drive file="$WIN_ISO",media=cdrom,if=none,readonly=on,id=cd-win \
  -device ide-cd,drive=cd-win,bus=sata0.0,bootindex=1 \
  -drive file="$AUTO_ISO",media=cdrom,if=none,readonly=on,id=cd-auto \
  -device ide-cd,drive=cd-auto,bus=sata0.1 \
  -drive file="$VIRTIO_ISO",media=cdrom,if=none,readonly=on,id=cd-virtio \
  -device ide-cd,drive=cd-virtio,bus=sata0.2 \
  -netdev user,id=net0,restrict=on \
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
