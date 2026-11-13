import { useEffect, useRef, useState } from "react";
import { compactConversation, getContext } from "../api.ts";
import { quotaUsage, quotaWindowLabel } from "./MetaLine.tsx";
import type {
	AppContextView,
	AppLiveContext,
} from "../../../src/http/app-wire.ts";


// Compact token counts — "340", "1.5k", "104.3k", "1M". One decimal
// only past the thousand mark and only when it carries information —
// whole thousands read as "200k", not "200.0k".
export function contextCount(n: number): string {
	const fmt = (v: number) => {
		const r = Math.round(v * 10) / 10;
		return Number.isInteger(r) ? `${r}` : r.toFixed(1);
	};
	if (n >= 999_950) return `${fmt(n / 1_000_000)}M`;
	if (n >= 1000) return `${fmt(n / 1000)}k`;
	return `${n}`;
}

const contextRate = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);

// Itemization row labels — keys are the server's itemize.ts segments.
const SEGMENT_LABELS: Record<string, string> = {
	identity: "Identity (SOUL.md)",
	environment: "Environment",
	project: "Project",
	agentsMd: "AGENTS.md",
	userMd: "USER.md",
	skills: "Skills",
	toolDefs: "Tool definitions",
	history: "History",
	toolResults: "tool calls & results",
};

// The gauge's one-line label for a context view. Null input reads as
// "no turns yet" on a fresh conversation, "ctx ?" when turns exist but
// the provider reported no usable counts.
export function contextLabel(ctx: AppContextView | null): string {
	if (ctx === null) return "…";
	if (ctx.input === null) return ctx.turns === 0 ? "no turns yet" : "ctx ?";
	if (ctx.limit === null) return `${contextCount(ctx.input)} tok`;
	return `${contextCount(ctx.input)}/${contextCount(ctx.limit)} · ${ctx.pct === null ? "?" : `${ctx.pct}%`}`;
}

// The composer's context gauge — the last turn's window utilization
// against the conversation model's catalog limit, with cache-hit rates
// in the popover. Reads stay cheap: one GET on mount and one per
// settled turn (busy → idle), never mid-stream.
export function ContextGauge({
	token,
	conversationId,
	busy,
	live,
	model,
	onCompacted,
}: {
	token: string | null;
	conversationId: string | undefined;
	busy: boolean;
	// The in-flight turn's window occupancy, streamed over the chat
	// wire — the gauge's numbers while a turn runs. The settled view
	// is one turn behind then.
	live?: AppLiveContext | null | undefined;
	// The conversation's configured model — what the next turn runs.
	// A read carries the model it was made for; when this one differs,
	// the read's limit says nothing about the live window and only the
	// bare token count shows until the re-read lands.
	model?: string | undefined;
	// A landed fold has a transcript mark — the host re-reads history
	// so the pill appears. Only fires for the conversation the POST
	// was issued under (the identity guard below).
	onCompacted?: (() => void) | undefined;
}) {
	const [ctx, setCtx] = useState<AppContextView | null>(null);
	const [failed, setFailed] = useState(false);
	// Why the last read failed — the tooltip's debugging hook; empty on
	// success. Never rendered as UI text.
	const [lastError, setLastError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [compacting, setCompacting] = useState(false);
	// The manual lever's own readout — the gauge numbers are the last
	// turn's usage, so a fold doesn't move them until the next turn;
	// the outcome line is the feedback that it happened.
	const [compactNote, setCompactNote] = useState<string | null>(null);
	const seq = useRef(0);
	// seq also ticks per read — identity moves only on a credential or
	// conversation switch, which is what actually orphans a pending
	// compact POST.
	const identity = useRef(0);
	const gaugeRef = useRef<HTMLSpanElement | null>(null);
	const btnRef = useRef<HTMLButtonElement | null>(null);
	// A read belongs to the conversation that produced it — an id (or
	// credential) switch makes it stale, and a still-in-flight read for
	// the old identity must never land: bump seq here, since the fetch
	// effect's early returns skip the bump. Identity bumps here too,
	// orphaning any compact POST the switch leaves pending. Kept out of
	// that effect so its post-turn re-runs hold the last read until the
	// new one lands.
	// The popover belongs to the conversation too — a switch closes it,
	// so the next conversation's read can't pop open over the composer.
	useEffect(() => {
		seq.current++;
		identity.current++;
		setCtx(null);
		setFailed(false);
		setLastError(null);
		setOpen(false);
		setCompacting(false);
		setCompactNote(null);
	}, [token, conversationId]);
	const read = () => {
		if (conversationId === undefined || busy) return;
		const n = ++seq.current;
		setFailed(false);
		setLastError(null);
		void getContext(token, conversationId).then(
			(c) => {
				if (n === seq.current) setCtx(c);
			},
			(err: unknown) => {
				if (n === seq.current) {
					setFailed(true);
					setLastError(err instanceof Error ? err.message : "request failed");
				}
			},
		);
	};
	useEffect(() => {
		read();
		// The model knob rides along: a model change between turns must
		// re-read, or the gauge would keep utilizing against the previous
		// model's limit. cfg resolving after mount re-fires this once —
		// a duplicate GET the seq retires.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [token, conversationId, busy, model]);
	// Dismiss on any outside press or Escape — the gauge button's own
	// toggle stays the open path. Escape hands focus back to the control
	// that opened it.
	useEffect(() => {
		if (!open) return;
		const onPointer = (e: Event) => {
			if (gaugeRef.current?.contains(e.target as Node | null) === true) return;
			setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setOpen(false);
			btnRef.current?.focus();
		};
		document.addEventListener("pointerdown", onPointer, true);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onPointer, true);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [open]);
	if (conversationId === undefined) return null;
	// The limit the gauge's arithmetic may use — the read's figure only
	// when the read belongs to the conversation's live model. A model
	// change between turns outdates it (the token count survives, the
	// window doesn't), and until the fresh read lands only the count is
	// known. Without the live model the caller can't know better, so
	// the read stands.
	const limit =
		ctx !== null &&
		ctx.limit !== null &&
		ctx.limit > 0 &&
		(model === undefined || ctx.model === model)
			? ctx.limit
			: null;
	// The figures every face shows — the streaming turn's metered step
	// while it reports one, the settled read's until it does. Label,
	// ring, and popover all derive from these, so they cannot disagree.
	// A stale number beats a placeholder (ruling 2026-10-24): while a
	// turn runs without a metered step — before the first report, or a
	// step the provider didn't meter — the last settled read stands in.
	const viewInput = (busy ? live?.input : null) ?? ctx?.input ?? null;
	// Rate-limit receipts — present only on providers that issue them;
	// the last turn's receipt stands in when no live step has reported.
	const quota = live?.quota ?? ctx?.quota ?? null;
	const viewPct =
		viewInput !== null && limit !== null ? Math.round((viewInput / limit) * 1000) / 10 : null;
	const barPct = viewPct === null ? 0 : Math.min(100, Math.max(0, viewPct));
	// The read wearing the figures above — the settled label and the
	// popover render this, so a streamed step moves them with the ring.
	const shown: AppContextView | null =
		ctx === null
			? null
			: {
					...ctx,
					limit,
					input: viewInput,
					pct: viewPct,
				};
	// While a turn streams: a metered step's figures when they land,
	// the settled read standing in until then, and only when no read
	// exists at all — a fresh conversation, a mid-turn switch — the
	// turn itself by name. Never "no turns yet" over a live stream.
	const busyLabel =
		live?.input != null
			? limit !== null
				? `${contextCount(live.input)}/${contextCount(limit)} · ${viewPct}%`
				: `${contextCount(live.input)} tok`
			: shown !== null && shown.input !== null
				? contextLabel(shown)
				: "turn in flight";
	// The wire's cacheRead/input pair is the same numerator and
	// denominator the server reports for a settled turn — while one
	// runs, the freshest metered step's rate wins; a step whose split
	// the provider didn't report falls back to the settled figure.
	const liveHitRate =
		live != null && live.input !== null && live.input > 0 && live.cacheRead !== null
			? live.cacheRead / live.input
			: null;
	const hitRate = busy && liveHitRate !== null ? liveHitRate : (ctx?.cacheHitRate ?? null);
	// 85% is the ring's red line — the button and the popover's bar wear
	// the same state so every face of the gauge agrees.
	const hot = viewPct !== null && viewPct >= 85;
	// A failed read has no numbers to show and the popover won't open —
	// the label carries it on wide screens, the reddened ring on narrow.
	// The click becomes the retry, with the reason on the tooltip.
	const failedRead = failed && ctx === null;
	// The window itemization — a stacked strip plus receipt rows. The
	// tool-share row is a subset of history, so it stays out of the
	// strip's widths.
	const segs = ctx?.segments ?? null;
	const segBars = segs?.filter((s) => s.key !== "toolResults") ?? [];
	const segTotal = segBars.reduce((n, s) => n + s.tokens, 0);
	return (
		<span className="ctx-gauge" ref={gaugeRef}>
			<button
				type="button"
				ref={btnRef}
				className={failedRead ? "ctx-btn failed" : hot ? "ctx-btn hot" : "ctx-btn"}
				aria-label={
					failedRead
						? "Context window usage — read failed, activate to retry"
						: busy
							? `Context window: ${busyLabel}`
							: ctx === null
								? "Context window usage"
								: `Context window: ${contextLabel(shown)} — ${ctx.model}`
				}
				aria-expanded={open && ctx !== null}
				title={
					failedRead
						? `Context window usage — read failed: ${lastError ?? "unknown error"}`
						: busy
							? `Context window: ${busyLabel} — turn in flight`
							: ctx === null
								? "Context window usage"
								: `Context window: ${contextLabel(shown)} — ${ctx.model}`
				}
				onClick={() => {
					if (failedRead) {
						read();
						return;
					}
					setOpen((v) => !v);
				}}
			>
				<svg className="ctx-ring" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
					<circle className="ctx-ring-track" cx="8" cy="8" r="6.5" />
					{viewPct !== null && viewPct > 0 && (
						<circle
							className={hot ? "ctx-ring-fill hot" : "ctx-ring-fill"}
							cx="8"
							cy="8"
							r="6.5"
							strokeDasharray={`${(barPct / 100) * 40.84} 40.84`}
							transform="rotate(-90 8 8)"
						/>
					)}
				</svg>
				<span className="ctx-label">
					{failedRead ? "ctx failed" : busy ? busyLabel : contextLabel(shown)}
				</span>
			</button>
			{open && shown !== null && (
				<div className="note-pick composer-pick ctx-pop">
					<div className="ctx-head">
						<span>Context window</span>
						<span className="mono">
							{shown.input === null || shown.limit === null
								? "—"
								: `${contextCount(shown.input)}/${contextCount(shown.limit)}`}
						</span>
					</div>
					<div className="ctx-hero">
						{shown.limit === null
							? shown.input === null
								? "—"
								: `${contextCount(shown.input)} tok`
							: shown.pct === null
								? "?"
								: `${shown.pct}%`}
					</div>
					<div
						className={shown.pct === null ? "ctx-bar bare" : hot ? "ctx-bar hot" : "ctx-bar"}
						aria-hidden="true"
					>
						<span style={{ width: `${barPct}%` }} />
					</div>
					{segs !== null && segBars.length > 0 && (
						<div className="ctx-segs">
							<div className="ctx-segbar" aria-hidden="true">
								{segBars.map((s) => (
									<span
										key={s.key}
										className={`seg-${s.key}`}
										style={{
											width: `${segTotal > 0 ? (s.tokens / segTotal) * 100 : 0}%`,
										}}
									/>
								))}
							</div>
							<dl className="ctx-rows ctx-seg-rows" title="Estimated from serialized characters">
								{segs.map((s) => (
									<div key={s.key} className={s.key === "toolResults" ? "sub" : undefined}>
										<dt>{SEGMENT_LABELS[s.key] ?? s.key}</dt>
										<dd className="mono">
											~{contextCount(s.tokens)} tok
											{s.key !== "toolResults" && segTotal > 0
												? ` · ${Math.round((s.tokens / segTotal) * 100)}%`
												: ""}
										</dd>
									</div>
								))}
							</dl>
						</div>
					)}
					<dl className="ctx-rows">
						<div>
							<dt>Input</dt>
							<dd className="mono">
								{shown.input === null ? "—" : `${contextCount(shown.input)} tok`}
							</dd>
						</div>
						<div>
							<dt>Cache hit</dt>
							<dd className="mono">{contextRate(hitRate)}</dd>
						</div>
						<div>
							<dt>Avg cache hit</dt>
							<dd className="mono">{contextRate(shown.avgCacheHitRate)}</dd>
						</div>
						{quota?.primary !== null && quota?.primary !== undefined && (
							<div>
								<dt>{quotaWindowLabel(quota.primary.windowMinutes)}</dt>
								<dd className="mono">{quotaUsage(quota.primary)}</dd>
							</div>
						)}
						{quota?.secondary !== null && quota?.secondary !== undefined && (
							<div>
								<dt>{quotaWindowLabel(quota.secondary.windowMinutes)}</dt>
								<dd className="mono">{quotaUsage(quota.secondary)}</dd>
							</div>
						)}
					</dl>
					<p className="empty">
						{shown.model} · {shown.turns} {shown.turns === 1 ? "turn" : "turns"}
						{busy ? " · turn in flight" : ""}
						{shown.limit === null ? " · limit unknown" : ""}
					</p>
					<button
						type="button"
						className="ctx-act"
						disabled={compacting}
						onClick={() => {
							if (conversationId === undefined) return;
							const id = conversationId;
							const n = identity.current;
							setCompacting(true);
							setCompactNote(null);
							void compactConversation(token, id)
								.then((outcome) => {
									if (n !== identity.current) return;
									setCompactNote(
										outcome.compacted
											? `folded ${outcome.eventsCompacted} messages (~${Math.round(outcome.tokensBefore / 1000)}k tok) — kept the last ${outcome.tailEvents}`
											: `nothing to compact — ${outcome.reason}`,
									);
									// The pointer is durable — the transcript marks it
									// on the re-read (a noop changes nothing).
									if (outcome.compacted) onCompacted?.();
								})
								.catch((err: unknown) => {
									if (n === identity.current)
										setCompactNote(
											`compact failed: ${err instanceof Error ? err.message : String(err)}`,
										);
								})
								.finally(() => {
									if (n === identity.current) setCompacting(false);
								});
						}}
					>
						{compacting ? "Compacting…" : "Compact now"}
					</button>
					{compactNote !== null && (
						<p className="ctx-outcome" role="status">
							{compactNote}
						</p>
					)}
				</div>
			)}
		</span>
	);
}
