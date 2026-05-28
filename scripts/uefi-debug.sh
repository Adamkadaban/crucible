#!/usr/bin/env bash
# Verbose UEFI shell driver over QMP. Pure bash + python3 for socket IO.
# Usage:
#   scripts/uefi-debug.sh shot <name>           # screenshot to artifacts/dbg-<name>.png
#   scripts/uefi-debug.sh type "<text>"         # send chars (no Enter)
#   scripts/uefi-debug.sh line "<text>"         # send chars then Enter
#   scripts/uefi-debug.sh key  <keyname> [hold] # raw sendkey, hold ms default 30
#   scripts/uefi-debug.sh keys k1 k2 ...        # raw sendkey sequence
#   scripts/uefi-debug.sh enter                 # just press Enter
#   scripts/uefi-debug.sh cls                   # type 'cls' + Enter
#   scripts/uefi-debug.sh raw '<json>'          # raw QMP command, prints reply
set -euo pipefail

SOCK="${CRUCIBLE_QMP_SOCK:-artifacts/qmp.sock}"
ART_DIR="artifacts"
LOG="${ART_DIR}/uefi-debug.log"
HOLD_DEFAULT="${HOLD_DEFAULT:-30}"
PACE_MS="${PACE_MS:-80}"

mkdir -p "${ART_DIR}"
ts() { date +'%H:%M:%S.%3N'; }
log() { printf '[%s] %s\n' "$(ts)" "$*" | tee -a "${LOG}" >&2; }

qmp() {
  # Send one JSON command, print reply line(s) until a return/event closes it.
  python3 - "$SOCK" "$1" <<'PY'
import json, socket, sys, time
sock_path, cmd = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX)
s.connect(sock_path)
s.settimeout(2)
buf = b''
def read_json():
    global buf
    while b'\n' not in buf:
        try:
            chunk = s.recv(65536)
        except socket.timeout:
            return ''
        if not chunk: break
        buf += chunk
    line, _, buf = buf.partition(b'\n')
    return line.decode(errors='replace')
greeting = read_json()
s.sendall(json.dumps({'execute':'qmp_capabilities'}).encode()+b'\r\n')
read_json()
s.sendall(cmd.encode()+b'\r\n')
# Drain one reply; bail on timeout fast.
line = read_json()
if line: print(line)
s.close()
PY
}

sendkey() {
  local keyname="$1" hold="${2:-$HOLD_DEFAULT}"
  log "sendkey ${keyname} hold=${hold}ms"
  qmp "$(printf '{"execute":"human-monitor-command","arguments":{"command-line":"sendkey %s %s"}}' "$keyname" "$hold")" >/dev/null
  python3 -c "import time;time.sleep(${PACE_MS}/1000.0)"
}

char_to_key() {
  local ch="$1"
  case "$ch" in
    ' ') echo spc;;
    '.') echo dot;;
    ',') echo comma;;
    '-') echo minus;;
    '/') echo slash;;
    '\') echo backslash;;
    ':') echo shift-semicolon;;
    ';') echo semicolon;;
    '_') echo shift-minus;;
    '=') echo equal;;
    '+') echo shift-equal;;
    '*') echo shift-8;;
    '(') echo shift-9;;
    ')') echo shift-0;;
    '"') echo shift-apostrophe;;
    "'") echo apostrophe;;
    '!') echo shift-1;;
    '@') echo shift-2;;
    '#') echo shift-3;;
    '$') echo shift-4;;
    '%') echo shift-5;;
    '^') echo shift-6;;
    '&') echo shift-7;;
    '?') echo shift-slash;;
    '<') echo shift-comma;;
    '>') echo shift-dot;;
    '|') echo shift-backslash;;
    [A-Z]) echo "shift-$(printf '%s' "$ch" | tr 'A-Z' 'a-z')";;
    [a-z0-9]) echo "$ch";;
    *) log "WARN no keymap for char '$ch'"; echo "";;
  esac
}

send_text() {
  local text="$1"
  log "TYPE >>> ${text}"
  local i=0 ch key
  while [ $i -lt ${#text} ]; do
    ch="${text:$i:1}"
    key="$(char_to_key "$ch")"
    [ -n "$key" ] && sendkey "$key"
    i=$((i+1))
  done
}

shot() {
  local name="$1"
  local ppm="${ART_DIR}/dbg-${name}.ppm"
  local png="${ART_DIR}/dbg-${name}.png"
  log "SCREENSHOT ${png}"
  qmp "$(printf '{"execute":"screendump","arguments":{"filename":"%s"}}' "$ppm")" >/dev/null
  # screendump returns before file is written; small wait then convert
  python3 -c 'import time;time.sleep(0.4)'
  convert "$ppm" "$png"
  ls -l "$png" | tee -a "$LOG" >&2
}

cmd="${1:-}"; shift || true
case "$cmd" in
  shot) shot "$1";;
  type) send_text "$1";;
  line) send_text "$1"; sendkey ret;;
  enter) sendkey ret;;
  cls) send_text "cls"; sendkey ret;;
  key) sendkey "$1" "${2:-$HOLD_DEFAULT}";;
  keys) for k in "$@"; do sendkey "$k"; done;;
  raw) qmp "$1";;
  *) echo "usage: $0 {shot|type|line|enter|cls|key|keys|raw} ..." >&2; exit 2;;
esac
