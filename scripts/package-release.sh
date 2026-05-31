#!/usr/bin/env bash
# Build distributable artifacts for Crucible and emit a SHA-256 manifest.
# Outputs land in dist/release/ alongside dist/release/release-manifest.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_DIR="${ROOT}/dist/release"
VENDOR_DIR="${ROOT}/vendor"

mkdir -p "${RELEASE_DIR}"
mkdir -p "${VENDOR_DIR}"
rm -f "${RELEASE_DIR}"/*.tgz "${RELEASE_DIR}"/*.exe "${RELEASE_DIR}"/release-manifest.json

# 1. TypeScript build
echo "[release] pnpm build" >&2
(cd "${ROOT}" && pnpm build >/dev/null)

# 2. Build the single npm CLI bundle.
echo "[release] bundle npm CLI" >&2
(cd "${ROOT}" && pnpm build:bundle >/dev/null)

# 3. Cross-compile the Go guest agent for Windows.
echo "[release] cross-compile guest agent (windows/amd64)" >&2
(cd "${ROOT}/guest-agent" \
  && GOOS=windows GOARCH=amd64 go build \
        -trimpath \
        -ldflags="-s -w -X main.version=${CRUCIBLE_VERSION:-dev}" \
        -o "${RELEASE_DIR}/crucible-guest-agent.exe" \
        ./cmd/crucible-guest-agent)
cp "${RELEASE_DIR}/crucible-guest-agent.exe" "${VENDOR_DIR}/crucible-guest-agent.exe"

# 4. SHA-256 manifest
echo "[release] hash manifest" >&2
python3 - "${RELEASE_DIR}" <<'PY'
import hashlib, json, os, pathlib, sys
from datetime import datetime, timezone
release_dir = pathlib.Path(sys.argv[1])
entries = []
for path in sorted(release_dir.iterdir()):
    if path.name == "release-manifest.json": continue
    if not path.is_file(): continue
    sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
    entries.append({
        "name": path.name,
        "sizeBytes": path.stat().st_size,
        "sha256": sha256,
    })
manifest = {
    "version": os.environ.get("CRUCIBLE_VERSION", "dev"),
    "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "entries": entries,
}
(release_dir / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps(manifest, indent=2))
PY

echo "[release] artifacts written to ${RELEASE_DIR}" >&2
ls -lh "${RELEASE_DIR}"
