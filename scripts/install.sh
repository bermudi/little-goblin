#!/usr/bin/env bash
# Fresh setup only; existing installations use the separately approved deploy path.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
bun_bin="$(command -v bun || true)"
if [ -z "$bun_bin" ]; then
	printf '%s\n' 'install: bun not found in PATH — install it first' >&2
	exit 1
fi
exec "$bun_bin" --no-install "$repo_root/scripts/install.ts" "$bun_bin"
