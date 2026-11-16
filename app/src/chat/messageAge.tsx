// "How old is this" for transcript messages: the age label format, a
// <time> renderer, the shared tick that keeps relative labels fresh,
// and the reader for the served append stamp.
//
// Format (operator ask, issue #630): under a minute "just now"; under an
// hour "N minutes ago"; same-day-older "17:39"; past 24h adds the date
// (and the year once it isn't this year's).

import { useEffect, useState } from "react";
import type { UIMessage } from "ai";

const hhmm = (d: Date) =>
	`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export function ageLabel(at: string, now: number): string {
	const ms = Date.parse(at);
	if (Number.isNaN(ms)) return "";
	const diff = now - ms;
	// Clock skew reads as fresh — a negative diff is never "in N minutes".
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) {
		const min = Math.floor(diff / 60_000);
		return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
	}
	const d = new Date(ms);
	if (diff < 86_400_000) return hhmm(d);
	const day = d.toLocaleDateString(
		undefined,
		d.getFullYear() === new Date(now).getFullYear()
			? { month: "short", day: "numeric" }
			: { month: "short", day: "numeric", year: "numeric" },
	);
	return `${day}, ${hhmm(d)}`;
}

// The append stamp the server serves on every message (`created_at` of
// the event row, merged into metadata at read; the turn finish stamp
// writes the same key live). Narrowed, never trusted — pre-stamp rows
// and client-minted messages simply have none.
export function messageCreatedAt(m: UIMessage): string | null {
	const md = (m as { metadata?: unknown }).metadata;
	if (typeof md !== "object" || md === null) return null;
	const at = (md as Record<string, unknown>).createdAt;
	return typeof at === "string" ? at : null;
}

// One clock for the whole transcript — relative labels age on a 30s
// tick instead of going stale between renders.
export function useNow(stepMs = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), stepMs);
		return () => clearInterval(t);
	}, [stepMs]);
	return now;
}

// <time> with the full instant on hover — the label compresses, the
// exact stamp stays one gesture away.
export function Age({ at, now }: { at: string; now: number }) {
	const ms = Date.parse(at);
	return (
		<time dateTime={at} title={Number.isNaN(ms) ? undefined : new Date(ms).toLocaleString()}>
			{ageLabel(at, now)}
		</time>
	);
}
