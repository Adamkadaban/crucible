#!/usr/bin/env bash
set -euo pipefail

mode="${1:---dry-run}"

case "$mode" in
  --dry-run)
    printf 'dry-run: would stop crucible-owned QEMU processes, sockets, pid files, and firewall chains\n'
    ;;
  --apply)
    printf 'apply mode is not implemented in bootstrap skeleton\n' >&2
    exit 2
    ;;
  *)
    printf 'usage: scripts/teardown.sh [--dry-run|--apply]\n' >&2
    exit 2
    ;;
esac
