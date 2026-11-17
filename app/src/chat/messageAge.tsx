// "How old is this" for transcript messages: the age label format, a
// <time> renderer, and the reader for the served append stamp.
//
// Format (operator ask, issue #630): under a minute "just now"; under an
// hour "N minutes ago"; same-day-older "17:39"; past 24h adds the date
// (and the year once it isn't this year's). `now` comes from the caller
// through the ageLabel seam default, like the app's other age displays —
// labels refresh on the next render, they don't tick.

import type { UIMessage } from "ai";

const hhmm = (d: Date) =>
	`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export function ageLabel(at: string, now = Date.now()): string {
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

// <time> with the full instant on hover — the label compresses, the
// exact stamp stays one gesture away. `now` is optional: left out it
// falls to ageLabel's seam — the live clock at render.
export function Age({ at, now }: { at: string; now?: number | undefined }) {
	const ms = Date.parse(at);
	return (
		<time dateTime={at} title={Number.isNaN(ms) ? undefined : new Date(ms).toLocaleString()}>
			{ageLabel(at, now)}
		</time>
	);
}
