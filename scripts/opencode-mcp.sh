#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/home/adam/.nvm/versions/node/v22.21.1/bin:/home/adam/.local/share/pnpm:${PATH}"

cd "${ROOT}"
exec pnpm crucible mcp --stdio
