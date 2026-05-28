#!/usr/bin/env bash
# Build distributable artifacts for Crucible and emit a SHA-256 manifest.
# Outputs land in dist/release/ alongside dist/release/release-manifest.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_DIR="${ROOT}/dist/release"
NODE_MODULES_DIR="${ROOT}/node_modules"

mkdir -p "${RELEASE_DIR}"
rm -f "${RELEASE_DIR}"/*.tar.gz "${RELEASE_DIR}"/*.exe "${RELEASE_DIR}"/release-manifest.json

# 1. TypeScript build
echo "[release] pnpm build" >&2
(cd "${ROOT}" && pnpm build >/dev/null)

# 2. Pack workspace packages so each ships its dist/ + package.json
node_pack() {
  local pkg="$1"
  local outdir="${RELEASE_DIR}"
  echo "[release] pack ${pkg}" >&2
  (cd "${ROOT}/packages/${pkg}" && pnpm pack --pack-destination "${outdir}" >/dev/null)
}
node_pack core
node_pack mcp-server
node_pack cli

# 3. Cross-compile the Go guest agent for Windows.
echo "[release] cross-compile guest agent (windows/amd64)" >&2
(cd "${ROOT}/guest-agent" \
  && GOOS=windows GOARCH=amd64 go build \
       -trimpath \
       -ldflags="-s -w -X main.version=${CRUCIBLE_VERSION:-dev}" \
       -o "${RELEASE_DIR}/crucible-guest-agent.exe" \
       ./cmd/crucible-guest-agent)

# 4. SHA-256 manifest
echo "[release] hash manifest" >&2
python3 - "${RELEASE_DIR}" <<'PY'
import hashlib, json, os, pathlib, sys
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
    "createdAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    "entries": entries,
}
(release_dir / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps(manifest, indent=2))
PY

echo "[release] artifacts written to ${RELEASE_DIR}" >&2
ls -lh "${RELEASE_DIR}"
