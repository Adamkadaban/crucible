#!/usr/bin/env bash
# Tear down project-owned processes, sockets, and ephemeral artifacts.
# Crucible never touches anything it didn't put on disk; --dry-run shows
# the exact set of files / pids that would be removed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ART="${ROOT}/artifacts"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [--dry-run]
Removes only project-owned crucible state:
  * Kills the QEMU pid recorded in ${ART}/run/*.pid (if any).
  * Removes ${ART}/qmp.sock, ${ART}/qga.sock, ${ART}/mon.sock.
  * Removes ${ART}/state/, ${ART}/logs/, ${ART}/run/.
  * Removes ephemeral capture files: ${ART}/dbg-*.{png,ppm},
    ${ART}/screen-*.{png,ppm}, ${ART}/poll*.log,
    ${ART}/provision*.log.
Leaves operator-owned bytes alone (disks/, boot/, secrets/, snapshots/).
Pass --dry-run to print what would happen without touching the filesystem.
EOF
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'DRY: %s\n' "$*"
  else
    "$@"
  fi
}

shopt -s nullglob

# Best-effort: stop any QEMU we started.
for pid_file in "${ART}/run"/*.pid; do
  pid="$(cat "${pid_file}" 2>/dev/null || true)"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
    case "$(ps -p "${pid}" -o comm= 2>/dev/null)" in
      qemu-system-*|qemu-system) run kill "${pid}" ;;
      *) printf 'skip pid %s (not qemu-system)\n' "${pid}" ;;
    esac
  fi
  run rm -f "${pid_file}"
done

# Sockets the project owns.
for sock in "${ART}/qmp.sock" "${ART}/qga.sock" "${ART}/mon.sock"; do
  if [[ -S "${sock}" ]]; then
    run rm -f "${sock}"
  fi
done

# Per-run logs / state / debug screenshots.
for path in "${ART}/state" "${ART}/logs" "${ART}/run"; do
  if [[ -d "${path}" ]]; then
    run rm -rf "${path}"
  fi
done

for f in "${ART}"/dbg-*.png "${ART}"/dbg-*.ppm "${ART}"/screen-*.png "${ART}"/screen-*.ppm "${ART}"/poll*.log "${ART}"/provision*.log; do
  run rm -f "${f}"
done

# We DO NOT remove:
#   - ${ART}/disks/*.qcow2 (operator-owned; may be expensive to recreate)
#   - ${ART}/boot/         (autounattend + drivers — operator-owned)
#   - ${ART}/secrets/      (per-VM credentials)
echo "[teardown] complete (dry_run=${DRY_RUN})"
