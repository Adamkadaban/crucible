#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

NVM_SH="${NVM_DIR:-${HOME}/.nvm}/nvm.sh"
if [[ -r "${NVM_SH}" ]]; then
  # shellcheck disable=SC1090
  . "${NVM_SH}"
  nvm use --silent >/dev/null
fi

corepack enable pnpm >/dev/null 2>&1 || true
exec pnpm crucible mcp --stdio
