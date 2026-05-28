#!/usr/bin/env bash
# Periodically screenshot + report disk size + QGA ping.
set -u
INTERVAL="${1:-60}"
COUNT="${2:-60}"
ART=artifacts
for i in $(seq 1 "$COUNT"); do
  name=$(printf 'poll-%03d' "$i")
  scripts/uefi-debug.sh shot "$name" 2>/dev/null
  DISK_SZ=$(du -h "$ART/disks/crucible-win11.qcow2" 2>/dev/null | awk '{print $1}')
  QGA="no-sock"
  if [ -S "$ART/qga.sock" ]; then
    QGA=$(timeout 2 python3 -c '
import socket,json,sys
s=socket.socket(socket.AF_UNIX);s.settimeout(1.5)
try:
  s.connect("'"$ART"'/qga.sock")
  s.sendall(b"\xff"+json.dumps({"execute":"guest-sync","arguments":{"id":1234}}).encode()+b"\n")
  print(s.recv(4096).decode().strip()[:80])
except Exception as e:
  print(f"{type(e).__name__}: {e}")
' 2>&1)
  fi
  printf '[%s] iter=%02d disk=%s qga=%s -> %s\n' "$(date +%H:%M:%S)" "$i" "$DISK_SZ" "$QGA" "artifacts/dbg-$name.png"
  sleep "$INTERVAL"
done
