#!/bin/sh

if [ "${GOBLIN_HC_RUN-}" != 1 ]; then
	exit 0
fi

state=${1-}
kind=${2-}
case "$state" in
	idle|working|done|blocked|error) ;;
	*) exit 0 ;;
esac

suffix=
if [ -n "$kind" ]; then
	suffix=":kind=$kind"
fi

if (printf '\033]7501;state=%s%s\033\\' "$state" "$suffix" > /dev/tty) 2>/dev/null; then
	exit 0
fi

pid=${PPID-}
while case "$pid" in ''|*[!0-9]*) false ;; *) [ "$pid" -gt 1 ] ;; esac; do
	stat=$(cat "/proc/$pid/stat" 2>/dev/null) || break
	rest=${stat##*) }
	set -f
	set -- $rest
	set +f
	[ "$#" -ge 2 ] || break
	shift
	parent=$1

	for fd in 0 1 2; do
		target=$(readlink "/proc/$pid/fd/$fd" 2>/dev/null) || continue
		case "$target" in
			/dev/pts/*)
				tty=${target#/dev/pts/}
				case "$tty" in ''|*[!0-9]*) continue ;; esac
				if (printf '\033]7501;state=%s%s\033\\' "$state" "$suffix" > "$target") 2>/dev/null; then
					exit 0
				fi
				;;
		esac
	done
	pid=$parent
done

if [ "${GOBLIN_HC_DEBUG-}" = 1 ]; then
	printf '%s\n' "goblin hc hook: no terminal found for state=$state" >&2
fi
exit 0
