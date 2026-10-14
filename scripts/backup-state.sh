#!/usr/bin/env bash
# Manual bounded snapshot of the live state database — docs/operations.md
# → Backups. sqlite3 .backup is the online-safe copy: it reads the live
# WAL consistently without checkpointing or mutating the source. Each run
# drops goblin-<UTC stamp>.sqlite plus the config beside it in
# state/backups/, quick_checks the copy, and prunes its own stamp-shaped
# backups to the newest KEEP (default 10). Hand-named backups are never
# pruned; there is no timer — this is an operator decision.
set -euo pipefail

home="${GOBLIN_HOME:-$HOME/goblin}"
db="$home/state/goblin.sqlite"
dir="$home/state/backups"
keep="${1:-10}"

[[ $keep =~ ^[0-9]+$ ]] && ((keep >= 1)) ||
	{ echo "usage: backup-state.sh [keep]" >&2; exit 2; }
[[ -f $db ]] || { echo "backup-state: no database at $db" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "backup-state: sqlite3 not on PATH" >&2; exit 1; }

mkdir -p "$dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$dir/goblin-$stamp.sqlite"
# Second-resolution stamps collide on a same-second rerun, and .backup
# truncates an existing target — a lost snapshot must be loud, not silent.
[[ -e $out ]] &&
	{ echo "backup-state: $out already exists — refusing to overwrite" >&2; exit 1; }
sqlite3 "$db" ".backup '$out'"
[[ $(sqlite3 "$out" "PRAGMA quick_check(1)") == ok ]] ||
	{ echo "backup-state: $out failed quick_check" >&2; exit 1; }
# The config is the snapshot's other half — a plain file, safe to copy.
[[ -f $home/goblin.json5 ]] && cp -p "$home/goblin.json5" "$dir/goblin-$stamp.json5"
echo "backup-state: wrote $out"

prune_file() {
	if command -v trash-put >/dev/null 2>&1; then
		trash-put "$1"
	else
		rm -f "$1"
	fi
}
mapfile -t snapshots < <(ls -1t "$dir"/goblin-????????T??????Z.sqlite 2>/dev/null || true)
for old in "${snapshots[@]:keep}"; do
	prune_file "$old"
	if [[ -f ${old%.sqlite}.json5 ]]; then prune_file "${old%.sqlite}.json5"; fi
	echo "backup-state: pruned $old" >&2
done
