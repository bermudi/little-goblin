// The context window view — pi-mono's session viewer, stolen for one
// goblin conversation (design/app.md → Context window view). The newest
// model call's captured prompt — system, tool schemas, every message as
// the model read it — plus the call lineage. Read-only; media bytes were
// stubbed at capture and render as counts, never images.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getContext, getWindow } from "./api.ts";
import { Markdown } from "./markdown.tsx";
import { bytes, describe, ts } from "./opsShared.tsx";
import type { AppContextView, AppWindowView } from "../../src/http/app-wire.ts";

type Segments = NonNullable<AppWindowView["segments"]>;

// Segment display names — keys are code-owned server-side
// (src/turn/itemize.ts); toolResults is a subset of history and renders
// as an indented note, never a bar of its own.
const SEGMENTS: { key: keyof Segments; label: string }[] = [
	{ key: "identity", label: "identity (SOUL.md)" },
	{ key: "environment", label: "environment" },
	{ key: "project", label: "project" },
	{ key: "agentsMd", label: "AGENTS.md" },
	{ key: "userMd", label: "USER.md" },
	{ key: "skills", label: "skills" },
	{ key: "toolDefs", label: "tool schemas" },
	{ key: "history", label: "history" },
];

type RoleFilter = "all" | "user" | "assistant" | "tool";

const ROLE_FILTERS: { key: RoleFilter; label: string }[] = [
	{ key: "all", label: "all" },
	{ key: "user", label: "you" },
	{ key: "assistant", label: "goblin" },
	{ key: "tool", label: "tools" },
];

// Serialized size of one message — the same chars-not-tokens estimate
// the gauge's itemization uses, computed client-side from the payload.
function chars(value: unknown): number {
	return JSON.stringify(value ?? null).length;
}

function partText(part: unknown): string {
	if (typeof part === "string") return part;
	if (typeof part !== "object" || part === null) return "";
	const p = part as { text?: unknown };
	return typeof p.text === "string" ? p.text : "";
}

// The model's view of a tool result output — { type: "text"|"error-text",
// value } unwraps to its string; anything else renders as JSON.
function toolOutputText(output: unknown): string {
	if (typeof output === "string") return output;
	if (typeof output !== "object" || output === null) return JSON.stringify(output ?? null);
	const o = output as { type?: unknown; value?: unknown };
	if ((o.type === "text" || o.type === "error-text") && typeof o.value === "string") return o.value;
	return JSON.stringify(output, null, 2);
}

function mediaSize(part: unknown): string | null {
	if (typeof part !== "object" || part === null) return null;
	const p = part as Record<string, unknown>;
	const data = (p.data ?? p.image) as unknown;
	if (typeof data === "object" && data !== null && "count" in (data as object)) {
		return bytes((data as { count: number }).count);
	}
	if (typeof data === "string" && data.length > 0 && !data.startsWith("http")) {
		return bytes(Math.ceil((data.length * 3) / 4));
	}
	return null;
}

function Json({ value }: { value: unknown }) {
	return <pre className="win-json">{JSON.stringify(value, null, 2)}</pre>;
}

function TextPart({ text, raw }: { text: string; raw: boolean }) {
	if (raw) return <pre className="win-json">{text}</pre>;
	return (
		<div className="win-text">
			<Markdown text={text} />
		</div>
	);
}

function MessageCard({
	message,
	index,
	raw,
	openBodies,
}: {
	message: { role: string; content: unknown };
	index: number;
	raw: boolean;
	openBodies: boolean;
}) {
	const content = message.content;
	const parts = Array.isArray(content) ? content : [content];
	return (
		<li className={`win-msg win-msg-${message.role}`} data-role={message.role}>
			<div className="win-msg-head">
				<span className="win-idx">#{index + 1}</span>
				<span className="win-role">{message.role}</span>
				<span className="win-size">{chars(message.content).toLocaleString()} chars</span>
			</div>
			{raw ? (
				<Json value={message} />
			) : (
				<div className="win-parts">
					{parts.map((part, i) => {
						if (typeof part === "string") {
							return <TextPart key={i} text={part} raw={raw} />;
						}
						if (typeof part !== "object" || part === null) {
							return (
								<pre key={i} className="win-json">
									{String(part)}
								</pre>
							);
						}
						const p = part as Record<string, unknown>;
						const type = typeof p.type === "string" ? p.type : "unknown";
						if (type === "text") {
							return <TextPart key={i} text={partText(part)} raw={raw} />;
						}
						if (type === "reasoning") {
							// Keyed by the toggle so the collapse re-derives when
							// it flips; the operator's own open/close wins after.
							return (
								<details key={`r${openBodies ? "o" : "c"}${i}`} open={openBodies}>
									<summary>thinking</summary>
									<pre className="win-json">{partText(part)}</pre>
								</details>
							);
						}
						if (type === "tool-call" || type === "tool-result") {
							const name = typeof p.toolName === "string" ? p.toolName : "?";
							const isCall = type === "tool-call";
							const body = isCall ? (
								<Json value={p.input ?? null} />
							) : (
								<pre className="win-json">{toolOutputText(p.output ?? null)}</pre>
							);
							return (
								<details key={`t${openBodies ? "o" : "c"}${i}`} open={openBodies}>
									<summary>
										{isCall ? "call" : "result"} · {String(name ?? "")}
										{!isCall && p.output !== undefined && (
											<span className="win-size"> {chars(p.output).toLocaleString()} chars</span>
										)}
									</summary>
									{body}
								</details>
							);
						}
						if (type === "file" || type === "image") {
							const mediaType = typeof p.mediaType === "string" ? p.mediaType : "media";
							const size = mediaSize(part);
							const url = typeof p.data === "string" && p.data.startsWith("http") ? p.data : null;
							return (
								<span key={i} className="chip">
									{type} · {mediaType}
									{size !== null ? ` · ${size}` : ""}
									{url !== null ? ` · ${url}` : " · bytes omitted"}
								</span>
							);
						}
						return <Json key={i} value={part} />;
					})}
				</div>
			)}
		</li>
	);
}

function CallsTable({ calls }: { calls: AppWindowView["calls"] }) {
	return (
		<div className="win-tablewrap">
			<table className="win-table">
				<thead>
					<tr>
						<th>when</th>
						<th>model</th>
						<th>in</th>
						<th>out</th>
						<th>cache read</th>
						<th>cache write</th>
						<th>prefix</th>
						<th>shared</th>
						<th>purpose</th>
						<th>status</th>
					</tr>
				</thead>
				<tbody>
					{calls.map((c) => (
						<tr key={c.callId}>
							<td>{ts(new Date(c.startedMs).toISOString())}</td>
							<td>{c.model}</td>
							<td>{c.inputTokens?.toLocaleString() ?? "?"}</td>
							<td>{c.outputTokens?.toLocaleString() ?? "?"}</td>
							<td>{c.cacheRead?.toLocaleString() ?? "—"}</td>
							<td>{c.cacheWrite?.toLocaleString() ?? "—"}</td>
							<td title="relation to the previous call's prompt: first / same / append / rewrite">
								{c.prefixRelation}
							</td>
							<td>{c.sharedMessages}</td>
							<td>{c.purpose ?? "turn"}</td>
							<td>{c.status}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

const num = (n: number): string => n.toLocaleString();

// The parts of the window, biggest first. Characters come from the
// captured window; tokens come from the context read (the gauge's scaling
// of the same itemization) when it answered. Neither is invented here.
function Breakdown({
	segments,
	tokens,
}: {
	segments: Segments;
	tokens: Map<string, number> | null;
}) {
	const rows = SEGMENTS.map(({ key, label }) => ({ key, label, n: segments[key] }))
		.filter((r) => r.n > 0)
		.sort((a, b) => b.n - a.n);
	const total = rows.reduce((sum, r) => sum + r.n, 0);
	if (total === 0) return null;
	return (
		<table className="win-break">
			<thead>
				<tr>
					<th>part</th>
					<th className="num">chars</th>
					{tokens !== null && <th className="num">tokens</th>}
					<th className="num">share</th>
					<th aria-hidden />
				</tr>
			</thead>
			<tbody>
				{rows.map((r) => {
					const share = (r.n / total) * 100;
					return (
						<tr key={r.key}>
							<td>{r.label}</td>
							<td className="num">{num(r.n)}</td>
							{tokens !== null && (
								<td className="num">{tokens.has(r.key) ? num(tokens.get(r.key)!) : "—"}</td>
							)}
							<td className="num">{share < 1 ? "<1" : Math.round(share)}%</td>
							<td className="win-break-bar" aria-hidden>
								<span style={{ width: `${Math.max(share, 1)}%` }} />
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}

// What the next turn will do, from figures the backend serves: the
// window's last input, the model's limit, and the compaction threshold.
function nextTurnNote(ctx: AppContextView | null, stale: boolean): string | null {
	if (stale) return "The model changed since this capture: the next turn rebuilds the window.";
	if (ctx === null || ctx.input === null || ctx.limit === null || ctx.limit <= 0) {
		return "No token count for this window: the provider reported no usage or the model has no known limit, so the fill and the room before compaction are unknown.";
	}
	const at = Math.floor((ctx.limit * ctx.compactAtPct) / 100);
	if (ctx.input >= at) {
		return `At or above ${ctx.compactAtPct}% of the window: the turn that just ended compacts the history before the next one.`;
	}
	return `A finished turn at ${ctx.compactAtPct}% of the window (${num(at)} tokens) compacts the history. ${num(at - ctx.input)} tokens of room remain before that.`;
}

function WindowSummary({
	view,
	ctx,
	stale,
}: {
	view: AppWindowView;
	ctx: AppContextView | null;
	stale: boolean;
}) {
	const used = ctx?.input ?? null;
	const limit = ctx?.limit ?? null;
	const pct = ctx?.pct ?? null;
	const note = nextTurnNote(ctx, stale);
	const nearing = ctx !== null && pct !== null && pct >= ctx.compactAtPct;
	const segments = view.segments;
	const totalChars = segments === null ? null : SEGMENTS.reduce((sum, { key }) => sum + segments[key], 0);
	const tokens =
		ctx?.segments != null && ctx.segments.length > 0
			? new Map(ctx.segments.map((s) => [s.key, s.tokens]))
			: null;
	return (
		<section className="win-summary">
			<div className="sumstrip">
				<div className={`sumtile${nearing ? " warn" : ""}`}>
					<b>{used === null ? "—" : num(used)}</b>
					<span>{limit === null ? "tokens used" : `tokens used of ${num(limit)}`}</span>
				</div>
				<div className={`sumtile${nearing ? " warn" : ""}`}>
					<b>{pct === null ? "—" : `${pct}%`}</b>
					<span>of the window</span>
				</div>
				<div className="sumtile">
					<b>{view.messages === null ? "—" : num(view.messages.length)}</b>
					<span>messages</span>
				</div>
				<div className="sumtile">
					<b>{view.tools === null ? "—" : num(view.tools.length)}</b>
					<span>tools</span>
				</div>
				{ctx?.cacheHitRate != null && (
					<div className="sumtile">
						<b>{Math.round(ctx.cacheHitRate * 100)}%</b>
						<span>read from cache</span>
					</div>
				)}
			</div>
			{pct !== null && ctx !== null && (
				<div
					className="win-fill"
					role="img"
					aria-label={`${pct}% of the window used; compaction at ${ctx.compactAtPct}%`}
				>
					<span className={nearing ? "win-fill-used warn" : "win-fill-used"} style={{ width: `${Math.min(pct, 100)}%` }} />
					<span className="win-fill-mark" style={{ left: `${ctx.compactAtPct}%` }} />
				</div>
			)}
			{note !== null && <p className={nearing ? "win-next warn" : "win-next"}>{note}</p>}
			{segments !== null && totalChars !== null && (
				<>
					<h3 className="win-h3">What takes the space</h3>
					<Breakdown segments={segments} tokens={tokens} />
					<p className="win-cap">
						{num(totalChars)} chars serialized
						{segments.toolResults > 0 && ` · ${num(segments.toolResults)} of the history are tool calls and results`}
						{tokens !== null && " · tokens are the gauge's scaling of the same split"}
					</p>
				</>
			)}
		</section>
	);
}

function Fold({
	title,
	count,
	children,
}: {
	title: string;
	count?: string | undefined;
	children: React.ReactNode;
}) {
	return (
		<details className="win-fold">
			<summary>
				<span className="win-h3-inline">{title}</span>
				{count !== undefined && <span className="win-size"> {count}</span>}
			</summary>
			{children}
		</details>
	);
}

export function WindowView({
	token,
	conversationId,
	title,
	onBack,
}: {
	token: string | null;
	conversationId: string;
	title: string | null;
	onBack: () => void;
}) {
	const [view, setView] = useState<AppWindowView | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [role, setRole] = useState<RoleFilter>("all");
	const [openBodies, setOpenBodies] = useState(false);
	const [raw, setRaw] = useState(false);
	const [query, setQuery] = useState("");
	const [ctx, setCtx] = useState<AppContextView | null>(null);
	const seq = useRef(0);

	const load = useCallback(() => {
		const n = ++seq.current;
		setErr(null);
		// Tokens and the limit come from the gauge's read; without it the
		// page still shows the capture in characters.
		getContext(token, conversationId).then(
			(c) => {
				if (n === seq.current) setCtx(c);
			},
			() => {
				if (n === seq.current) setCtx(null);
			},
		);
		getWindow(token, conversationId).then(
			(v) => {
				if (n === seq.current) setView(v);
			},
			(e) => {
				if (n === seq.current) setErr(describe(e));
			},
		);
	}, [token, conversationId]);
	useEffect(load, [load]);

	// The substring filter's haystacks serialize once per loaded view —
	// re-stringifying every message per keystroke and toggle reads badly
	// on the multi-megabyte payloads this view exists for.
	const haystacks = useMemo(
		() => (view?.messages ?? []).map((m) => JSON.stringify(m).toLowerCase()),
		[view],
	);

	if (err !== null) {
		return (
			<div className="ops">
				<h2 className="ops-h2">Context window</h2>
				<p className="error" role="alert">
					{err}
				</p>
				<div className="ops-back">
					<button type="button" className="ghost" onClick={onBack}>
						‹ Back to {title ?? "the conversation"}
					</button>
				</div>
			</div>
		);
	}
	if (view === null) {
		return (
			<div className="ops">
				<h2 className="ops-h2">Context window</h2>
				<p className="empty">Loading…</p>
			</div>
		);
	}

	const stale = view.capturedModel !== null && view.capturedModel !== view.model;
	const q = query.trim().toLowerCase();
	// The payload is ModelMessage-shaped with media stubbed (see the wire
	// type); every field below is read defensively.
	const isMessage = (m: unknown): m is { role: string; content: unknown } =>
		typeof m === "object" && m !== null && typeof (m as { role?: unknown }).role === "string";
	// Each card keeps its index in the captured window — filtered views
	// number honestly against the unfiltered list, not the subset.
	const messages = (view.messages ?? [])
		.map((message, index) => ({ message, index }))
		.filter((e): e is { message: { role: string; content: unknown }; index: number } =>
			isMessage(e.message),
		)
		.filter(
			(e) =>
				(role === "all" || e.message.role === role) &&
				(q === "" || haystacks[e.index]!.includes(q)),
		);
	return (
		<div className="ops win-page">
			<div className="proj-sec-head">
				<h2 className="ops-h2">Context window</h2>
				<button type="button" className="ghost" onClick={load}>
					Refresh
				</button>
			</div>
			<p className="lead">
				{view.capturedAt === null ? (
					"No model call yet — the window appears after this conversation's first turn."
				) : (
					<>
						Captured {ts(view.capturedAt)} · {view.capturedModel} · {view.steps} step
						{view.steps === 1 ? "" : "s"}
						{stale && (
							<span className="win-stale">
								{" "}
								— this conversation now runs {view.model}; the next turn rebuilds the window
							</span>
						)}
					</>
				)}
			</p>

			{view.capturedAt !== null && (
				<>
					<WindowSummary view={view} ctx={ctx} stale={stale} />

					<h3 className="win-h3">Raw parts</h3>
					<Fold
						title="System prompt"
						count={view.system !== null ? `${num(view.system.length)} chars` : undefined}
					>
						{view.system === null ? (
							<p className="empty">not captured</p>
						) : raw ? (
							<Json value={view.system} />
						) : (
							<pre className="win-json">{view.system}</pre>
						)}
					</Fold>

					<Fold title="Tools" count={view.tools !== null ? String(view.tools.length) : undefined}>
						{view.tools === null || view.tools.length === 0 ? (
							<p className="empty">{view.tools === null ? "not captured" : "no tools mounted"}</p>
						) : (
							<ul className="win-tools">
								{view.tools.map((t) => (
									<li key={t.name}>
										<details key={`tool${raw ? "r" : "p"}`}>
											<summary>
												{t.name}
												<span className="win-size">
													{" "}
													{chars(t.parameters).toLocaleString()} chars
												</span>
											</summary>
											{t.description !== null && <p className="win-tooldesc">{t.description}</p>}
											<Json value={t.parameters} />
										</details>
									</li>
								))}
							</ul>
						)}
					</Fold>

					<Fold
						title="Messages"
						count={`${messages.length}${
							messages.length !== (view.messages ?? []).length
								? ` of ${(view.messages ?? []).length}`
								: ""
						}`}
					>
						<div className="win-controls">
							<div className="chips" role="group" aria-label="role filter">
								{ROLE_FILTERS.map((f) => (
									<button
										key={f.key}
										type="button"
										className={role === f.key ? "chip on" : "chip"}
										aria-pressed={role === f.key}
										onClick={() => setRole(f.key)}
									>
										{f.label}
									</button>
								))}
							</div>
							<div className="chips" role="group" aria-label="display">
								<button
									type="button"
									className={openBodies ? "chip on" : "chip"}
									aria-pressed={openBodies}
									onClick={() => setOpenBodies(!openBodies)}
								>
									thinking &amp; tool bodies
								</button>
								<button
									type="button"
									className={raw ? "chip on" : "chip"}
									aria-pressed={raw}
									onClick={() => setRaw(!raw)}
								>
									raw JSON
								</button>
							</div>
							<input
								type="search"
								className="win-search"
								placeholder="filter messages…"
								aria-label="filter messages"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
							/>
						</div>
						<ul className="win-msgs">
							{messages.map((e) => (
								<MessageCard
									key={e.index}
									message={e.message}
									index={e.index}
									raw={raw}
									openBodies={openBodies}
								/>
							))}
						</ul>
						{messages.length === 0 && <p className="empty">nothing matches</p>}
					</Fold>
				</>
			)}

			<Fold title="Model calls" count={String(view.calls.length)}>
				{view.calls.length === 0 ? (
					<p className="empty">no model calls recorded for this conversation</p>
				) : (
					<CallsTable calls={view.calls} />
				)}
			</Fold>

			<div className="ops-back">
				<button type="button" className="ghost" onClick={onBack}>
					‹ Back to {title ?? "the conversation"}
				</button>
			</div>
		</div>
	);
}
