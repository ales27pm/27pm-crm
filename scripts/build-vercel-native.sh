#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/.." && pwd)"
next_bin="${project_root}/node_modules/.bin/next"

command -v timeout >/dev/null 2>&1 || {
  echo "build-vercel-native.sh requires GNU timeout." >&2
  exit 69
}

if [[ ! -x "${next_bin}" ]]; then
  echo "Next.js is unavailable. Install the locked dependencies before building." >&2
  exit 69
fi

echo "Running bounded native Next.js build for the Vercel target..."
cd "${project_root}"
NEXT_TELEMETRY_DISABLED=1 timeout \
  --signal=TERM \
  --kill-after="${VERCEL_BUILD_KILL_AFTER:-10s}" \
  "${VERCEL_BUILD_TIMEOUT:-5m}" \
  env CRM_DEPLOY_TARGET=vercel "${next_bin}" build "$@"
