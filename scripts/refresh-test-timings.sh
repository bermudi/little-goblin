#!/usr/bin/env bash
# Merge per-shard timings from a CI run into .github/test-timings.json,
# which `bun test --shard` reads to balance shards by time.
# Usage: scripts/refresh-test-timings.sh [run-id]   (default: latest ci run on main)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
run="${1:-$(gh run list --workflow ci --branch main --limit 1 --json databaseId -q '.[0].databaseId')}"
dir="$(mktemp -d)"
gh run download "$run" --pattern 'test-timings-*' --dir "$dir"
jq -s '{version: 1, files: (map(.files) | add | to_entries | sort_by(.key) | from_entries)}' \
  "$dir"/*/test-timings.json > .github/test-timings.json
echo "wrote .github/test-timings.json from run $run ($(jq '.files | length' .github/test-timings.json) files)" >&2
