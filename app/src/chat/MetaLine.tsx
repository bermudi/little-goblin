// Per-message turn stats and actions: quota narrowing, finish metadata
// (MetaLine), fold marks, and the copy/read/rate/edit action bars.

import type { UIMessage } from "ai";
import { Markdown } from "../markdown.tsx";
import { SpeechPlayer, useSpeech } from "../speech.tsx";
import { useCopy } from "../useCopy.ts";
import type {
	AppCompactionMark,
	AppQuota,
	AppQuotaWindow,
	AppReplyRating,
	TurnMetadata,
	UnlandedTurnMetadata,
} from "../../../src/http/app-wire.ts";


// The quota blob is server-validated AppQuota when present, but history
// rows may predate the field — narrow, never trust.
export function quotaOf(v: unknown): AppQuota | undefined {
	if (typeof v !== "object" || v === null) return undefined;
	const o = v as Record<string, unknown>;
	const window = (w: unknown): AppQuotaWindow | null => {
		if (typeof w !== "object" || w === null) return null;
		const wo = w as Record<string, unknown>;
		if (typeof wo.usedPercent !== "number") return null;
		return {
			usedPercent: wo.usedPercent,
			windowMinutes: typeof wo.windowMinutes === "number" ? wo.windowMinutes : null,
			resetsAt: typeof wo.resetsAt === "number" ? wo.resetsAt : null,
		};
	};
	const primary = window(o.primary);
	const secondary = window(o.secondary);
	if (primary === null && secondary === null) return undefined;
	return {
		limitName: typeof o.limitName === "string" ? o.limitName : null,
		primary,
		secondary,
	};
}

// Window naming follows the backend's own shape: 300-minute = the 5h
// block, 10080-minute = the weekly block.
export function quotaWindowLabel(minutes: number | null): string {
	if (minutes === null) return "window";
	if (minutes === 300) return "5h";
	if (minutes === 10080) return "weekly";
	return `${minutes}m`;
}

// A receipt is a snapshot from the last metered turn. Once its window
// has reset, its percentage describes a window that no longer exists.
export function quotaUsage(w: AppQuotaWindow): string {
	if (w.resetsAt !== null && w.resetsAt * 1000 <= Date.now()) return "reset since last turn";
	return `${w.usedPercent}% used${quotaReset(w.resetsAt)}`;
}

function quotaReset(resetsAt: number | null): string {
	if (resetsAt === null) return "";
	const d = new Date(resetsAt * 1000);
	const sameDay = new Date().toDateString() === d.toDateString();
	return ` · resets ${d.toLocaleString(undefined, sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

// ---------- per-message actions + turn stats ----------

// The runtime stamps finish metadata on the assistant message (model,
// duration, token counts) — it rides the live stream and persists into
// history. Narrow the unknown blob rather than trusting the shape.
export function turnMeta(m: UIMessage): TurnMetadata | null {
	const md = (m as { metadata?: unknown }).metadata;
	if (typeof md !== "object" || md === null) return null;
	const o = md as Record<string, unknown>;
	if (typeof o.model !== "string" || typeof o.durationMs !== "number") return null;
	// Wire data that persists into history — a malformed blob (a
	// primitive usage field) must render as unavailable, never throw
	// the transcript render.
	const usage =
		typeof o.usage === "object" && o.usage !== null ? (o.usage as Record<string, unknown>) : {};
	const num = (v: unknown) => (typeof v === "number" ? v : null);
	const ttftMs = num(o.ttftMs);
	// Fall back as a pair only for legacy metadata; explicit null or
	// a missing companion final-step field means unavailable.
	const hasFinalUsage = "lastInput" in usage || "lastCacheRead" in usage;
	return {
		model: o.model,
		finishReason: typeof o.finishReason === "string" ? o.finishReason : "",
		durationMs: o.durationMs,
		...(ttftMs !== null ? { ttftMs } : {}),
		forcedCompletion:
			o.forcedCompletion === "repeat" ||
			o.forcedCompletion === "watchdog" ||
			o.forcedCompletion === "context"
				? o.forcedCompletion
				: null,
		usage: {
			input: num(usage.input),
			output: num(usage.output),
			cacheRead: num(usage.cacheRead),
			cacheWrite: num(usage.cacheWrite),
			lastInput: num(hasFinalUsage ? usage.lastInput : usage.input),
			lastCacheRead: num(hasFinalUsage ? usage.lastCacheRead : usage.cacheRead),
		},
		...((): { quota: AppQuota } | Record<string, never> => {
			const q = quotaOf(o.quota);
			return q !== undefined ? { quota: q } : {};
		})(),
		...((): { fallbackFrom: Array<{ ref: string; reason: string }> } | Record<string, never> => {
			const from = fallbackOf(o.fallback);
			return from.length > 0 ? { fallbackFrom: from } : {};
		})(),
	};
}

// The runtime's `fallback.from` stamp — narrowed entry by entry; a
// malformed entry is dropped, not trusted.
function fallbackOf(v: unknown): Array<{ ref: string; reason: string }> {
	if (typeof v !== "object" || v === null) return [];
	const from = (v as Record<string, unknown>).from;
	if (!Array.isArray(from)) return [];
	return from.flatMap((e: unknown) => {
		if (typeof e !== "object" || e === null) return [];
		const { ref, reason } = e as Record<string, unknown>;
		return typeof ref === "string" && typeof reason === "string" ? [{ ref, reason }] : [];
	});
}

// The runtime stamps unlanded metadata on the system record of a turn
// that ended without a reply (stopped, failed, interrupted) — the
// streamed reply rides along for display. Narrow the unknown blob
// rather than trusting the shape.
type Unlanded = UnlandedTurnMetadata["unlanded"];
export function unlandedMeta(m: UIMessage): {
	kind: Unlanded["kind"];
	runId: string;
	reply: NonNullable<Unlanded["reply"]> | null;
} | null {
	const md = (m as { metadata?: unknown }).metadata;
	if (typeof md !== "object" || md === null) return null;
	const o = md as Record<string, unknown>;
	const unlanded = o.unlanded;
	if (typeof unlanded !== "object" || unlanded === null) return null;
	const u = unlanded as Record<string, unknown>;
	if (u.kind !== "failed" && u.kind !== "aborted" && u.kind !== "interrupted") return null;
	if (typeof u.runId !== "string") return null;
	// The reply is parts as streamed; anything but an array of part-ish
	// objects renders as absent.
	const reply = u.reply;
	const hasReply =
		Array.isArray(reply) && reply.every((p) => typeof p === "object" && p !== null && "type" in p);
	return {
		kind: u.kind,
		runId: u.runId,
		reply: hasReply ? (reply as NonNullable<Unlanded["reply"]>) : null,
	};
}

export function messageText(m: UIMessage): string {
	return m.parts
		.map((p) => (p.type === "text" ? p.text : ""))
		.join("\n")
		.trim();
}

// The expanded fold pill names where the model's context now starts —
// the first message the fold left verbatim, as a short single-line
// excerpt. Null when the index is out of range or the message carries
// no text.
export function foldStartExcerpt(mark: AppCompactionMark, messages: UIMessage[]): string | null {
	const part = messages[mark.firstKeptIndex]?.parts.find((p) => p.type === "text");
	const text = part?.type === "text" ? part.text : null;
	if (text === null) return null;
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed === "") return null;
	return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed;
}

// Compact stat formatting — "1.2k", "340", "4.2s".
const kfmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

export function MetaLine({ meta }: { meta: TurnMetadata }) {
	const bits: string[] = [meta.model];
	// A fallback served: name who didn't and why, so the operator can fix
	// the primary (search's served_by line, applied to models).
	if (meta.fallbackFrom !== undefined) {
		bits.push(`fallback — ${meta.fallbackFrom.map((m) => `${m.ref}: ${m.reason}`).join("; ")}`);
	}
	if (meta.finishReason !== "" && meta.finishReason !== "stop") bits.push(meta.finishReason);
	// A forced answer is degraded goods — stamped, never passed off as
	// natural. repeat: the deterministic detector; watchdog: system1
	// judged the loop stuck twice; context: the window filled mid-turn.
	if (meta.forcedCompletion === "repeat") bits.push("loop detector — answer forced");
	if (meta.forcedCompletion === "watchdog") bits.push("loop watchdog — answer forced");
	if (meta.forcedCompletion === "context") bits.push("context nearly full — answer forced");
	bits.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
	// The window number is the final step's prompt — not the billed sum
	// across the tool loop's re-sent prompts; the gauge and this line agree.
	const input = meta.usage.lastInput;
	const cacheRead = meta.usage.lastCacheRead;
	const { output } = meta.usage;
	if (input !== null || output !== null) {
		let tok = `${input === null ? "?" : kfmt(input)}→${output === null ? "?" : kfmt(output)} tok`;
		if (cacheRead !== null && cacheRead > 0) tok += ` (${kfmt(cacheRead)} cached)`;
		bits.push(tok);
	}
	// tok/s is effective throughput over the duration this line shows —
	// the tool loop's time rides in it, not just decode time.
	if (output !== null && output > 0 && meta.durationMs > 0) {
		const tps = output / (meta.durationMs / 1000);
		bits.push(`${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`);
	}
	if (meta.ttftMs !== undefined) bits.push(`TTFT ${(meta.ttftMs / 1000).toFixed(1)}s`);
	return <div className="msg-meta">{bits.join(" · ")}</div>;
}

// A fold pointer rendered into the transcript: the pill sits where the
// fold ran — after the last message that existed then, not at the cut —
// the durable record of the same line the popover's compact outcome
// reports — and expands to the summary the model actually kept.
// `keptStart` is an excerpt of the first message the fold left
// verbatim; `live` marks the newest pointer, the boundary the model's
// context currently starts from.
export function FoldMark({
	mark,
	live,
	keptStart = null,
}: {
	mark: AppCompactionMark;
	live: boolean;
	keptStart?: string | null;
}) {
	const line =
		`folded ${mark.eventsCompacted} messages (~${Math.round(mark.tokensBefore / 1000)}k tok)` +
		(mark.tailEvents === null ? "" : ` — kept the last ${mark.tailEvents}`);
	const when = new Date(mark.createdAt).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
	return (
		<div className="fold-mark">
			<details className={live ? "fold-pill live" : "fold-pill"}>
				<summary title={`context fold — expand for the summary the model kept`}>{line}</summary>
				<div className="fold-summary">
					{keptStart !== null && keptStart !== "" && (
						<p className="fold-start">context now starts at: “{keptStart}”</p>
					)}
					<Markdown text={mark.summary} />
					<p className="fold-meta">
						folded by {mark.model} · {when}
					</p>
				</div>
			</details>
		</div>
	);
}

export function ActionBar({
	message,
	isLastAssistant,
	busy,
	onRetry,
	token,
	rateable,
	rating,
	ratingPending,
	ratingError,
	onRate,
	onBranch = null,
	branchPending = false,
	branchError = null,
}: {
	message: UIMessage;
	isLastAssistant: boolean;
	busy: boolean;
	onRetry: () => void;
	token: string | null;
	rateable: boolean;
	rating: AppReplyRating | null;
	ratingPending: boolean;
	ratingError: string | null;
	onRate: (rating: AppReplyRating) => void;
	// A branch copies this conversation through the reply and opens the
	// new chat. Null = the surface has nowhere to navigate (tests, a
	// read-only view), so the affordance is absent rather than inert.
	onBranch?: (() => void) | null;
	branchPending?: boolean;
	branchError?: string | null;
}) {
	const text = messageText(message);
	const { copied, failed, copy } = useCopy();
	const speech = useSpeech(token);
	const open = speech.phase !== "closed";
	return (
		<>
			<div className="msg-actions">
				<button
					type="button"
					onClick={() => copy(text)}
					aria-label={failed ? "Copy failed" : copied ? "Copied" : "Copy"}
					aria-live="polite"
				>
					{copied ? "✓ copied" : failed ? "✗ copy failed" : "copy"}
				</button>
				{text !== "" && (
					<button
						type="button"
						onClick={() => (open ? speech.stop() : void speech.start(text))}
						aria-label={speech.phase === "open" ? "Stop reading aloud" : "Read aloud"}
						disabled={speech.phase === "loading"}
					>
						{speech.phase === "open" ? "■ stop" : speech.phase === "loading" ? "…" : "▶ read"}
					</button>
				)}
				{rateable && (
					<>
						<button
							type="button"
							className={rating === "up" ? "on" : undefined}
							onClick={() => onRate("up")}
							aria-label="Rate reply helpful"
							aria-pressed={rating === "up"}
							disabled={ratingPending}
						>
							helpful
						</button>
						<button
							type="button"
							className={rating === "down" ? "on" : undefined}
							onClick={() => onRate("down")}
							aria-label="Rate reply bad"
							aria-pressed={rating === "down"}
							disabled={ratingPending}
						>
							bad
						</button>
					</>
				)}
				{speech.err !== null && <span className="msg-err">{speech.err}</span>}
				{ratingError !== null && <span className="msg-err">{ratingError}</span>}
				{isLastAssistant && !busy && (
					<button type="button" onClick={onRetry} aria-label="Retry">
						↻ retry
					</button>
				)}
				{onBranch !== null && (
					<button
						type="button"
						onClick={onBranch}
						aria-label="Branch conversation"
						disabled={busy || branchPending}
					>
						{branchPending ? "branching…" : "⑂ branch"}
					</button>
				)}
				{branchError !== null && <span className="msg-err">{branchError}</span>}
			</div>
			{speech.phase === "open" && (
				<SpeechPlayer
					playing={speech.playing}
					rate={speech.rate}
					position={speech.position}
					duration={speech.duration}
					onToggle={speech.toggle}
					onSeekBy={speech.seekBy}
					onSeekTo={speech.seekTo}
					onRate={speech.cycleRate}
					onStop={speech.stop}
				/>
			)}
		</>
	);
}

// The operator's own messages carry the two actions that make sense on a
// prompt: copy it, or rewrite it. A rewrite is a rewind — the view warns
// when a tail will be dropped, and branch is the non-destructive path.
export function UserActions({
	message,
	disabled,
	onEdit,
}: {
	message: UIMessage;
	disabled: boolean;
	onEdit: () => void;
}) {
	const text = messageText(message);
	const { copied, failed, copy } = useCopy();
	return (
		<div className="msg-actions user-actions">
			<button
				type="button"
				onClick={() => copy(text)}
				aria-label={failed ? "Copy failed" : copied ? "Copied" : "Copy message"}
				aria-live="polite"
				disabled={text === ""}
			>
				{copied ? "✓ copied" : failed ? "✗ copy failed" : "copy"}
			</button>
			<button type="button" onClick={onEdit} aria-label="Edit message" disabled={disabled}>
				edit
			</button>
		</div>
	);
}

// Rewriting a prompt keeps everything that is not text (attachments,
// note and skill chips): the first text part carries the new words and
// any additional text parts collapse into it.
export function editedParts(message: UIMessage, text: string): UIMessage["parts"] {
	const parts: UIMessage["parts"] = [];
	let placed = false;
	for (const part of message.parts) {
		if (part.type !== "text") {
			parts.push(part);
			continue;
		}
		if (placed) continue;
		parts.push({ type: "text", text });
		placed = true;
	}
	if (!placed) parts.unshift({ type: "text", text });
	return parts;
}
