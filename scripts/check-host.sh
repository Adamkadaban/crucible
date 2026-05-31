#!/usr/bin/env bash
set -euo pipefail

missing=0

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    printf 'missing: %s\n' "$name"
    missing=1
  fi
}

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'unsupported host: crucible requires Linux for QEMU/KVM host control\n'
  missing=1
fi

require_command qemu-system-x86_64
require_command qemu-img
require_command xorriso
require_command swtpm
require_command socat

if [[ ! -e /dev/kvm ]]; then
  printf 'missing: /dev/kvm\n'
  missing=1
fi

if [[ ! -r /usr/share/OVMF/OVMF_CODE_4M.fd && ! -r /usr/share/edk2-ovmf/OVMF_CODE.fd && ! -r /usr/share/edk2/x64/OVMF_CODE.fd ]]; then
  printf 'missing: OVMF_CODE.fd\n'
  missing=1
fi

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

printf 'host prerequisites look available\n'
