#!/usr/bin/env bash
# Publish the staged client build: app/dist.next promotes into a slot
# dir and the app/dist symlink flips to it with tmp-link + rename — an
# atomic swap, so the per-request server never reads a half-written
# tree. The previous slot stays, so a client-only rollback is a symlink
# flip.
#
# `bun run app:build` only stages dist.next — nothing else writes the
# served path.
#
# One-time migration: a legacy real-dir app/dist moves aside into slot
# dist.a and stays served until the flip (a sub-second gap between that
# move and the symlink landing, inside the deploy gate).
set -euo pipefail

fail() { echo "publish-app: $*" >&2; exit 1; }

cd "$(dirname "$0")/../app"

[ -d dist.next ] || fail "no staged build — run bun run app:build first"
[ -f dist.next/index.html ] || fail "staged build has no index.html — refusing to publish"

cur=""
if [ -L dist ]; then
	cur="$(readlink dist)"
	cur="${cur##*/}"
	[ "$cur" = "dist.a" ] || [ "$cur" = "dist.b" ] ||
		fail "app/dist points at an unexpected target: $cur"
elif [ -d dist ]; then
	rm -rf dist.a
	mv dist dist.a
	cur="dist.a"
elif [ -e dist ]; then
	fail "app/dist is not a directory or symlink — refusing to touch it"
fi

nxt="dist.a"
[ "$cur" = "dist.a" ] && nxt="dist.b"

rm -rf "$nxt" && mv dist.next "$nxt" || fail "cannot promote staged build into app/$nxt"
ln -s "$nxt" .dist.tmp || fail "cannot create swap link"
mv -Tf .dist.tmp dist || { rm -f .dist.tmp; fail "cannot swap app/dist"; }
sync .
echo "publish-app: dist -> $nxt (was ${cur:-none})"
