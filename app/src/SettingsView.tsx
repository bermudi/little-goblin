import { useEffect, useId, useRef, useState } from "react";
import type { ThinkingLevel } from "../../src/config.ts";
import type { ConfigResponse } from "../../src/http/operator-wire.ts";
import {
	ApiError,
	getOperatorConfig,
	getThinkingLevels,
	saveOperatorConfig,
	storeSecret,
} from "./api.ts";
import { saveFailure, shouldAutosave } from "./settingsSave.ts";
import {
	bodyFromDraft,
	type ChainEntry,
	displayLevel,
	draftFromConfig,
	EMPTY_DRAFT,
	emptyTranscription,
	FETCH_META,
	type KindMeta,
	type MemDraft,
	type ProvDraft,
	SEARCH_META,
	type SettingsDraft,
	switchTranscriptionKind,
	switchTtsKind,
	THINKING_ORDER,
	type TranscriptionKind,
	type TrDraft,
	type TrKindStash,
	type TtsDraft,
	type TtsKindStash,
	type TtsKind,
	type VisDraft,
	VOICE_SUGGESTIONS,
	switchProviderKind,
	validateDraft,
} from "./settingsDraft.ts";

type Section = "chat" | "voice" | "web" | "memory" | "providers" | "access";
type SheetMode = "model" | "telegram" | "title" | "vision";

// One channel's thinking rungs: the offered values plus whether the
// capability lookup behind them failed.
interface ChannelLevels {
	values: string[];
	unavailable: boolean;
}

// The draft serializes without the providers' render ids — they're a
// React keying detail, not editor state.
const serialize = (d: SettingsDraft, ps: ProvDraft[]) =>
	JSON.stringify({ d, ps: ps.map(({ id: _id, ...rest }) => rest) });

// Display names for the dirty-diff in the savebar — "unsaved" alone
// can't say what changed.
const FIELD_LABELS: Record<keyof SettingsDraft, string> = {
	model: "app model",
	titleModel: "topic-title model",
	favorites: "favorites",
	thinking: "app thinking",
	telegramModel: "telegram model",
	telegramThinking: "telegram thinking",
	tts: "text to speech",
	transcription: "speech to text",
	vision: "vision",
	search: "search chain",
	fetch: "fetch chain",
	operators: "operators",
	allowedUsers: "allowed users",
	publicUrl: "public url",
	apiRoot: "telegram api root",
	dmGap: "dm gap",
	richReplies: "rich replies",
	showReasoning: "show reasoning",
	port: "http port",
	logLevel: "log level",
	memory: "memory",
};

function Seg({
	options,
	value,
	onChange,
	ariaLabel,
}: {
	options: readonly string[];
	value: string;
	onChange: (v: string) => void;
	ariaLabel: string;
}) {
	return (
		<div className="seg" role="group" aria-label={ariaLabel}>
			{options.map((o) => (
				<button
					key={o}
					type="button"
					className={o === value ? "seg-btn on" : "seg-btn"}
					onClick={() => onChange(o)}
				>
					{o}
				</button>
			))}
		</div>
	);
}

function Switch({
	on,
	onChange,
	ariaLabel,
}: {
	on: boolean;
	onChange: (on: boolean) => void;
	ariaLabel: string;
}) {
	return (
		<button
			type="button"
			className={on ? "switch on" : "switch"}
			aria-pressed={on}
			aria-label={ariaLabel}
			onClick={() => onChange(!on)}
		/>
	);
}

// Every secret-name input shares one datalist — auth.jsonl's record
// names as loaded at boot — and one warning shape. A name that isn't in
// the list never blocks a save (config-before-key is legitimate order);
// it only flags typos against what the running process can resolve.
// openrouter is required because providers materialize blank auth from
// it; the rest are read by kind lookup.
export type AuthDefaults = Record<string, string> & { openrouter: string };
const AUTH_DL = "goblin-auth-names";
const authWarn = (name: string, known: readonly string[]): string | undefined => {
	const t = name.trim();
	return known.length > 0 && t !== "" && !known.includes(t)
		? `"${t}" is not in auth.jsonl (as loaded at boot)`
		: undefined;
};

function Row({
	label,
	cap,
	children,
	col,
	labelId,
}: {
	label: string;
	cap?: string;
	children?: React.ReactNode;
	col?: boolean;
	labelId?: string;
}) {
	return (
		<div className={col ? "row col" : "row"}>
			<div className="rstack">
				<div className="rlabel" id={labelId}>
					{label}
				</div>
				{cap !== undefined && <div className="cap">{cap}</div>}
			</div>
			{children}
		</div>
	);
}

function Field({
	label,
	value,
	onChange,
	placeholder,
	cap,
	numeric,
	mono,
	list,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	cap?: string | undefined;
	numeric?: boolean;
	mono?: boolean;
	list?: string | undefined;
}) {
	const id = useId();
	return (
		<div className="frow">
			<label className="flabel" htmlFor={id}>
				{label}
			</label>
			<input
				id={id}
				className={mono ? "mono" : undefined}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				inputMode={numeric ? "numeric" : undefined}
				autoComplete="off"
				spellCheck={false}
				autoCapitalize="off"
				list={list}
			/>
			{cap !== undefined && <div className="cap">{cap}</div>}
		</div>
	);
}

function ChipsEditor({
	values,
	onAdd,
	onRemove,
	placeholder,
	ariaLabel,
	numeric,
	suggestions,
	cap,
}: {
	values: string[];
	onAdd: (v: string) => void;
	onRemove: (i: number) => void;
	placeholder: string;
	ariaLabel: string;
	numeric?: boolean;
	suggestions?: readonly string[];
	cap?: string;
}) {
	const [v, setV] = useState("");
	const listId = useRef(`dl-${Math.random().toString(36).slice(2, 9)}`).current;
	const add = () => {
		const t = v.trim();
		if (t === "") return;
		onAdd(t);
		setV("");
	};
	return (
		<div className="frow">
			<div className="chips">
				{values.map((x, i) => (
					<span className="chip" key={`${i}:${x}`}>
						{x}
						<button type="button" aria-label={`remove ${x}`} onClick={() => onRemove(i)}>
							×
						</button>
					</span>
				))}
			</div>
			<div className="addrow">
				<input
					className="mono"
					value={v}
					onChange={(e) => setV(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							add();
						}
					}}
					placeholder={placeholder}
					inputMode={numeric ? "numeric" : undefined}
					autoComplete="off"
					spellCheck={false}
					autoCapitalize="off"
					aria-label={ariaLabel}
					list={suggestions !== undefined ? listId : undefined}
				/>
				<button className="addbtn" type="button" onClick={add}>
					Add
				</button>
			</div>
			{suggestions !== undefined && (
				<datalist id={listId}>
					{suggestions.map((s) => (
						<option key={s} value={s} />
					))}
				</datalist>
			)}
			{cap !== undefined && <div className="cap">{cap}</div>}
		</div>
	);
}

// The "+ key" affordance every secret-name field carries: a pasted key
// lands in auth.jsonl under the field's effective name (the typed name,
// else the kind's default record) and resolves on the running process —
// no shell, no restart. Command records stay hand-managed; the server
// refuses those names and the error lands here.
function SecretEntry({
	token,
	name,
	onStored,
}: {
	token: string | null;
	/** The record name this store lands under — blank hides the affordance. */
	name: string;
	onStored: (name: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const record = name.trim();
	if (record === "") return null;
	const submit = async () => {
		setBusy(true);
		setErr(null);
		try {
			const res = await storeSecret(token, { name: record, value });
			setValue("");
			setOpen(false);
			onStored(res.name);
		} catch (e) {
			setErr(e instanceof ApiError ? e.message : "Couldn't reach goblin — check the tailnet.");
		} finally {
			setBusy(false);
		}
	};
	if (!open) {
		return (
			<button type="button" className="keylink" onClick={() => setOpen(true)}>
				+ store a key
			</button>
		);
	}
	return (
		<div className="keyentry">
			<div className="addrow">
				<input
					className="mono"
					type="password"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							void submit();
						}
					}}
					placeholder={`the key for "${record}"`}
					autoComplete="off"
					spellCheck={false}
					autoCapitalize="off"
					aria-label={`key for ${record}`}
				/>
				<button
					className="addbtn"
					type="button"
					disabled={busy || value.trim() === ""}
					onClick={() => void submit()}
				>
					Store
				</button>
				<button
					className="addbtn"
					type="button"
					onClick={() => {
						setOpen(false);
						setErr(null);
					}}
				>
					Cancel
				</button>
			</div>
			<div className="cap">
				Writes to auth.jsonl as "{record}" — resolvable right away, no restart.
			</div>
			{err !== null && <div className="cap err-inline">{err}</div>}
		</div>
	);
}

// The model picker: favorites, the current ref, and a custom
// provider/model-id pair — the mini app's sheet, verbatim semantics.
function ModelSheet({
	title,
	current,
	allowOff,
	favorites,
	provNames,
	onPick,
	onClose,
}: {
	title: string;
	current: string;
	allowOff: boolean;
	favorites: string[];
	provNames: string[];
	onPick: (ref: string) => void;
	onClose: () => void;
}) {
	const [custProv, setCustProv] = useState(provNames[0] ?? "");
	const [custModel, setCustModel] = useState("");
	const row = (ref: string, label: string) => (
		<button
			key={ref || "off"}
			type="button"
			className={ref === current ? "mrow sel" : "mrow"}
			onClick={() => onPick(ref)}
		>
			<span className={ref === "" ? "ref off-label" : "ref"} title={ref}>
				{label}
			</span>
			{ref === current && <span className="check">✓</span>}
		</button>
	);
	return (
		<div className="veil on" onClick={onClose}>
			<div className="msheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
				<header className="msheet-head">
					<h3>{title}</h3>
					<button type="button" aria-label="Close" onClick={onClose}>
						×
					</button>
				</header>
				<div className="msheet-body">
					{allowOff && row("", "Off")}
					{favorites.length > 0 && (
						<>
							<div className="mgroup">Favorites</div>
							{favorites.map((f) => row(f, f))}
						</>
					)}
					{current !== "" && !favorites.includes(current) && (
						<>
							<div className="mgroup">Current</div>
							{row(current, current)}
						</>
					)}
					{provNames.length > 0 && (
						<div className="msheet-custom">
							<select value={custProv} onChange={(e) => setCustProv(e.target.value)}>
								{provNames.map((n) => (
									<option key={n} value={n}>
										{n}
									</option>
								))}
							</select>
							<input
								className="mono"
								value={custModel}
								onChange={(e) => setCustModel(e.target.value)}
								placeholder="model id"
								autoComplete="off"
								spellCheck={false}
								autoCapitalize="off"
								onKeyDown={(e) => {
									if (e.key === "Enter" && custModel.trim() !== "") {
										onPick(`${custProv}/${custModel.trim()}`);
									}
								}}
							/>
							<button
								type="button"
								disabled={custModel.trim() === ""}
								onClick={() => onPick(`${custProv}/${custModel.trim()}`)}
							>
								Use
							</button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function ChainEditor({
	entries,
	kinds,
	meta,
	defaults,
	authNames,
	token,
	onSecretStored,
	onChange,
}: {
	entries: ChainEntry[];
	kinds: readonly string[];
	meta: Record<string, KindMeta>;
	/** Blank-auth defaults per kind — authDefaults off the config GET,
	 *  one source with the server schema. */
	defaults: AuthDefaults;
	authNames: string[];
	token: string | null;
	onSecretStored: (name: string) => void;
	onChange: (next: ChainEntry[]) => void;
}) {
	const move = (i: number, d: number) => {
		const j = i + d;
		if (j < 0 || j >= entries.length) return;
		const next = entries.slice();
		next[i] = entries[j]!;
		next[j] = entries[i]!;
		onChange(next);
	};
	return (
		<>
			{entries.map((e, i) => {
				const m = meta[e.kind];
				const def = defaults[e.kind] ?? "";
				const effective = e.auth.trim() || def;
				// Warn on any effective name the process can't resolve —
				// including a typed name on keyless-capable kinds; hint
				// "Blank uses X" only while the field is blank (mini-app
				// parity).
				const hint =
					authWarn(effective, authNames) ??
					(e.auth.trim() === "" && def !== "" ? `Blank uses ${def}.` : undefined);
				return (
					<div className="chain-card" key={i}>
						<div className="chain-head">
							<span className="chain-num">{i + 1}</span>
							<span className="chain-btns">
								<button
									type="button"
									aria-label="move up"
									disabled={i === 0}
									onClick={() => move(i, -1)}
								>
									↑
								</button>
								<button
									type="button"
									aria-label="move down"
									disabled={i === entries.length - 1}
									onClick={() => move(i, 1)}
								>
									↓
								</button>
								<button
									type="button"
									aria-label="remove"
									onClick={() => onChange(entries.filter((_, j) => j !== i))}
								>
									×
								</button>
							</span>
						</div>
						<select
							className="mono"
							value={e.kind}
							aria-label={`step ${i + 1} provider`}
							onChange={(ev) => {
								const kind = ev.target.value;
								onChange(
									entries.map((x, j) =>
										j === i && kind !== x.kind ? { ...x, kind, auth: "" } : x,
									),
								);
							}}
						>
							{kinds.map((k) => (
								<option key={k} value={k}>
									{k}
								</option>
							))}
						</select>
						{m?.auth === "none" ? (
							<div className="cap">{m.note ?? "No key needed."}</div>
						) : (
							<>
								<input
									className="mono"
									value={e.auth}
									onChange={(ev) =>
										onChange(entries.map((x, j) => (j === i ? { ...x, auth: ev.target.value } : x)))
									}
									placeholder={
										m?.auth === "optional"
											? "secret name (optional)"
											: def !== ""
												? `${def} — in auth.jsonl`
												: "secret name in auth.jsonl"
									}
									autoComplete="off"
									spellCheck={false}
									autoCapitalize="off"
									aria-label={`step ${i + 1} secret name`}
									list={AUTH_DL}
								/>
								{m?.auth === "optional" && m.note !== undefined && (
									<div className="cap">{m.note}</div>
								)}
								{hint !== undefined && <div className="cap">{hint}</div>}
								<SecretEntry
									token={token}
									name={effective}
									onStored={(n) => {
										onSecretStored(n);
										onChange(entries.map((x, j) => (j === i ? { ...x, auth: n } : x)));
									}}
								/>
							</>
						)}
					</div>
				);
			})}
			<button
				className="ghost"
				type="button"
				onClick={() => {
					const first = kinds[0];
					if (first === undefined) return;
					onChange([...entries, { kind: first, auth: "" }]);
				}}
			>
				+ Add provider
			</button>
		</>
	);
}

function ProviderCard({
	prov,
	kinds,
	referencedBy,
	authDefaults,
	authNames,
	token,
	onSecretStored,
	onPatch,
	onRename,
	onRemove,
	onNameDirtyChange,
}: {
	prov: ProvDraft;
	kinds: readonly string[];
	referencedBy: string[];
	authDefaults: AuthDefaults;
	authNames: string[];
	token: string | null;
	onSecretStored: (name: string) => void;
	onPatch: (patch: Partial<ProvDraft>) => void;
	onRename: (v: string) => string | null;
	onRemove: () => void;
	onNameDirtyChange: (dirty: boolean) => void;
}) {
	// Name edits commit on blur — a half-typed name would break model
	// refs while the operator is mid-word (the mini app's rule).
	const [nameDraft, setNameDraft] = useState(prov.name);
	const [nameErr, setNameErr] = useState<string | null>(null);
	// Per-kind auth memory — a kind switch clears the field (it must
	// never leak across kinds) and a switch back restores it.
	const authStash = useRef<Record<string, string>>({});
	useEffect(() => setNameDraft(prov.name), [prov.name]);
	// The uncommitted name is departure hazard the serialized diff can't
	// see: report divergence on every change, and clear on unmount —
	// section switches unmount the card and the draft dies with it, so
	// the pending flag must not outlive it. The callback rides a ref:
	// the parent's inline wrapper changes identity every render and a
	// cleanup bound to it would clear the flag on each re-render.
	const reportName = useRef(onNameDirtyChange);
	reportName.current = onNameDirtyChange;
	useEffect(() => {
		reportName.current(nameDraft !== prov.name);
		return () => reportName.current(false);
	}, [nameDraft, prov.name]);
	const commitName = () => {
		const v = nameDraft.trim();
		if (v === prov.name) {
			setNameDraft(prov.name);
			setNameErr(null);
			return;
		}
		const err = onRename(v);
		if (err !== null) {
			setNameDraft(prov.name);
			setNameErr(err);
		} else {
			setNameErr(null);
		}
	};
	const needsBase = prov.kind === "openai-compatible" || prov.kind === "responses";
	const codex = prov.kind === "codex";
	// Blank auth materializes at save: the provider's own name, or the
	// kind's default record for openrouter — the placeholder states
	// which, tracking the name live so the convention stays visible.
	const authFallback = prov.kind === "openrouter" ? authDefaults.openrouter : prov.name.trim();
	const authMissing = !codex && authWarn(prov.auth.trim() || authFallback, authNames);
	return (
		<div className="prov card">
			<div className="prov-head">
				<input
					className="pname mono"
					value={nameDraft}
					onChange={(e) => setNameDraft(e.target.value)}
					onBlur={commitName}
					onKeyDown={(e) => {
						if (e.key === "Enter") (e.target as HTMLInputElement).blur();
					}}
					placeholder="name"
					autoComplete="off"
					spellCheck={false}
					autoCapitalize="off"
					aria-label="provider name"
				/>
				<button type="button" className="rm" onClick={onRemove}>
					Remove
				</button>
			</div>
			{nameErr !== null && <div className="cap err-inline">{nameErr}</div>}
			{referencedBy.length > 0 && <div className="cap">Used by {referencedBy.join(", ")}.</div>}
			<div className="frow">
				<label className="flabel">Type</label>
				<select
					className="mono"
					value={prov.kind}
					aria-label="provider type"
					onChange={(e) => onPatch(switchProviderKind(prov, e.target.value, authStash.current))}
				>
					{kinds.map((k) => (
						<option key={k} value={k}>
							{k}
						</option>
					))}
				</select>
			</div>
			{needsBase && (
				<div className="frow">
					<label className="flabel">Base url</label>
					<input
						className="mono"
						value={prov.baseUrl}
						onChange={(e) => onPatch({ baseUrl: e.target.value })}
						placeholder="https://…"
						autoComplete="off"
						spellCheck={false}
						autoCapitalize="off"
						aria-label="base url"
					/>
				</div>
			)}
			<div className="frow">
				<label className="flabel">{codex ? "Codex auth file" : "Secret name"}</label>
				<input
					className="mono"
					value={prov.auth}
					onChange={(e) => onPatch({ auth: e.target.value })}
					placeholder={
						codex
							? "~/.codex/auth.json — blank = default"
							: `${authFallback || "provider name"} — in auth.jsonl`
					}
					autoComplete="off"
					spellCheck={false}
					autoCapitalize="off"
					aria-label={codex ? "codex auth file" : "secret name"}
					list={codex ? undefined : AUTH_DL}
				/>
			</div>
			{authMissing !== undefined && <div className="cap">{authMissing}</div>}
			{!codex && (
				<SecretEntry
					token={token}
					name={prov.auth.trim() || authFallback}
					onStored={(n) => {
						onSecretStored(n);
						onPatch({ auth: n });
					}}
				/>
			)}
		</div>
	);
}

const SECTIONS: { key: Section; label: string; sub: string }[] = [
	{ key: "chat", label: "Chat", sub: "Model, thinking, topic titles, favorites" },
	{ key: "voice", label: "Voice", sub: "Text to speech, transcription" },
	{ key: "web", label: "Web", sub: "Search and fetch providers" },
	{ key: "memory", label: "Memory", sub: "Hindsight service" },
	{ key: "providers", label: "Providers", sub: "Model vendors and secret names" },
	{ key: "access", label: "Access", sub: "Allowed users, doors, port, log level" },
];

export function SettingsView({
	token,
	onDirtyChange,
}: {
	token: string | null;
	onDirtyChange?: (dirty: boolean) => void;
}) {
	const [kinds, setKinds] = useState<{
		provider: readonly string[];
		search: readonly string[];
		fetch: readonly string[];
		transcription: readonly TranscriptionKind[];
		authDefaults: ConfigResponse["authDefaults"];
		trDefaults: ConfigResponse["transcriptionDefaults"];
		ttsDefaults: ConfigResponse["ttsDefaults"];
	} | null>(null);
	const [authNames, setAuthNames] = useState<string[]>([]);
	// A stored key's record joins the picker list so the "not in
	// auth.jsonl" hint clears without a reload; apply() points the
	// owning field's name at it.
	const rememberAuthName = (name: string) =>
		setAuthNames((n) => (n.includes(name) ? n : [...n, name].sort()));
	const keyStored = (apply: (name: string) => void) => (name: string) => {
		rememberAuthName(name);
		apply(name);
	};
	const [etag, setEtag] = useState("");
	const [draft, setDraft] = useState<SettingsDraft>(EMPTY_DRAFT);
	const [provs, setProvs] = useState<ProvDraft[]>([]);
	const [baseline, setBaseline] = useState<string | null>(null);
	const [section, setSection] = useState<Section | null>(null);
	const [sheet, setSheet] = useState<SheetMode | null>(null);
	const [notice, setNotice] = useState<{
		text: string;
		kind: "err" | "ok";
		// Whether the savebar's retry button makes sense for this error —
		// set only by the save catch; other error notices never retry.
		retryable?: boolean;
	} | null>(null);
	const [saving, setSaving] = useState(false);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	// Turned-off blocks keep their last content — toggling back on
	// restores it (the mini app's last* locals).
	const last = useRef<{
		tts: TtsDraft | null;
		transcription: TrDraft | null;
		vision: VisDraft | null;
		search: ChainEntry[] | null;
		fetch: ChainEntry[] | null;
		memory: MemDraft | null;
	}>({ tts: null, transcription: null, vision: null, search: null, fetch: null, memory: null });
	// Kind-switch memory — each engine's identity fields survive a
	// round-trip through another kind (switch*Kind clears them on
	// purpose; the stash restores what was entered for that kind).
	const ttsStash = useRef<TtsKindStash>({});
	const trStash = useRef<TrKindStash>({});
	// values = the rungs the Seg control offers; unavailable = the
	// capability lookup failed, so the full ladder is shown as a
	// stand-in and the caption says so — the server clamps silently at
	// call time otherwise.
	const [levels, setLevels] = useState<{ app: ChannelLevels; telegram: ChannelLevels }>({
		app: { values: [...THINKING_ORDER], unavailable: false },
		telegram: { values: [...THINKING_ORDER], unavailable: false },
	});
	const thinkSeq = useRef(0);
	const patchTranscription = (p: Partial<TrDraft>) =>
		setDraft((d) =>
			d.transcription === null ? d : { ...d, transcription: { ...d.transcription, ...p } },
		);
	const patchTts = (p: Partial<TtsDraft>) =>
		setDraft((d) => (d.tts === null ? d : { ...d, tts: { ...d.tts, ...p } }));

	// Provider ids whose card is holding an uncommitted name draft —
	// typed but not blurred. That text is in no serialized field, so it
	// joins the dirty flag as a second, independent departure hazard.
	const [pendingNames, setPendingNames] = useState<ReadonlySet<number>>(new Set());
	const reportNameDirty = (id: number, dirty: boolean) =>
		setPendingNames((s) => {
			if (s.has(id) === dirty) return s;
			const next = new Set(s);
			if (dirty) next.add(id);
			else next.delete(id);
			return next;
		});
	const namePending = pendingNames.size > 0;

	const dirty = baseline !== null && serialize(draft, provs) !== baseline;
	// The guard the parent navigation/beforeunload asks about: serialized
	// edits OR a provider name still uncommitted in its card.
	const departureDirty = dirty || namePending;
	useEffect(() => onDirtyChange?.(departureDirty), [departureDirty, onDirtyChange]);

	// Which top-level fields differ — serialized both sides so the
	// comparison sees exactly what dirty sees (provs minus ids).
	const { dirtyFields, stagedDirty } = (() => {
		const none = { dirtyFields: [] as string[], stagedDirty: false };
		if (!dirty || baseline === null) return none;
		const cur = JSON.parse(serialize(draft, provs)) as { d: SettingsDraft; ps: unknown[] };
		const base = JSON.parse(baseline) as { d: SettingsDraft; ps: unknown[] };
		const keys = (Object.keys(FIELD_LABELS) as (keyof SettingsDraft)[]).filter(
			(k) => JSON.stringify(cur.d[k]) !== JSON.stringify(base.d[k]),
		);
		// publicUrl IS this tab's origin gate — an intermediate value
		// ("" between clear and retype) autosaved would 403 the tab's
		// own next write. It stays staged until the savebar's Save.
		const stagedDirty = keys.includes("publicUrl");
		const fields = keys.map((k) => FIELD_LABELS[k]);
		if (JSON.stringify(cur.ps) !== JSON.stringify(base.ps)) fields.push("providers");
		return { dirtyFields: fields, stagedDirty };
	})();

	// A dirty draft that fails validation can't write — it stays dirty
	// and the savebar says why instead of listing fields.
	const invalidReason = dirty ? validateDraft(draft, provs) : null;

	useEffect(() => {
		let live = true;
		getOperatorConfig(token).then(
			({ data, etag: tag }) => {
				if (!live) return;
				// A freshly built client against a not-yet-restarted server
				// (the forbidden rollout window) must fail loud here, not
				// crash later when a save materializes from authDefaults.
				if (!("authDefaults" in data)) {
					setLoadErr("The settings endpoint predates this client — restart goblin, then reload.");
					return;
				}
				const { draft: d, providers } = draftFromConfig(data.config);
				setDraft(d);
				setProvs(providers);
				setPendingNames(new Set());
				setBaseline(serialize(d, providers));
				setEtag(tag ?? "");
				setKinds({
					provider: data.providerKinds,
					search: data.searchKinds,
					fetch: data.fetchKinds,
					transcription: data.transcriptionKinds,
					authDefaults: data.authDefaults,
					trDefaults: data.transcriptionDefaults,
					ttsDefaults: data.ttsDefaults,
				});
				setAuthNames(data.authNames);
			},
			(err) => {
				if (live)
					setLoadErr(
						err instanceof ApiError
							? `The settings endpoint answered ${err.status}: ${err.message}`
							: "Couldn't reach goblin — check the tailnet.",
					);
			},
		);
		return () => {
			live = false;
		};
	}, [token]);

	// Thinking-level capability lookups — kind/base/model from the
	// form's own provider state, debounced like the mini app's
	// refreshThinkingSoon.
	const provsSig = provs.map((p) => `${p.name.trim()}|${p.kind}|${p.baseUrl.trim()}`).join(",");
	useEffect(() => {
		if (kinds === null) return;
		const seq = ++thinkSeq.current;
		const t = setTimeout(() => {
			// The full ladder is honest for the no-lookup paths (no model
			// picked, provider unknown); only a real fetch failure is
			// degraded, and the flag surfaces it in the row caption.
			const full: ChannelLevels = { values: [...THINKING_ORDER], unavailable: false };
			const channel = async (ref: string): Promise<ChannelLevels> => {
				const slash = ref.indexOf("/");
				if (slash <= 0) return full;
				const p = provs.find((q) => q.name.trim() === ref.slice(0, slash));
				if (p === undefined) return full;
				const base =
					p.kind === "openai-compatible" || p.kind === "responses"
						? p.baseUrl.trim() || undefined
						: undefined;
				try {
					const r = await getThinkingLevels(token, p.kind, ref.slice(slash + 1), base);
					return { values: r.levels, unavailable: false };
				} catch {
					return { values: [...THINKING_ORDER], unavailable: true };
				}
			};
			void Promise.all([channel(draft.model), channel(draft.telegramModel)]).then(
				([app, telegram]) => {
					if (seq === thinkSeq.current) setLevels({ app, telegram });
				},
			);
		}, 300);
		return () => clearTimeout(t);
		// provsSig is the provs projection this effect actually keys on.
	}, [draft.model, draft.telegramModel, provsSig, token, kinds]);

	const patchDraft = (patch: Partial<SettingsDraft>) => setDraft((d) => ({ ...d, ...patch }));
	const patchProv = (id: number, patch: Partial<ProvDraft>) =>
		setProvs((ps) => ps.map((q) => (q.id === id ? { ...q, ...patch } : q)));

	const renameProvider = (id: number, v: string): string | null => {
		if (v === "") return "Every provider needs a name.";
		if (provs.some((q) => q.id !== id && q.name === v)) return `Duplicate provider name: ${v}`;
		setProvs((ps) => ps.map((q) => (q.id === id ? { ...q, name: v } : q)));
		return null;
	};

	// Which draft fields still name a provider — the mini app's
	// providerRefs(), shown under the card and repeated on remove.
	const providerRefs = (name: string): string[] => {
		const refs: string[] = [];
		const pfx = `${name}/`;
		if (draft.model.startsWith(pfx)) refs.push("app default model");
		if (draft.telegramModel.startsWith(pfx)) refs.push("Telegram model");
		if (draft.titleModel.startsWith(pfx)) refs.push("topic titles");
		if (draft.vision?.model.startsWith(pfx)) refs.push("vision");
		if (draft.favorites.some((f) => f.startsWith(pfx))) refs.push("favorites");
		return refs;
	};

	const removeProvider = (p: ProvDraft) => {
		const refs = p.name !== "" ? providerRefs(p.name) : [];
		setProvs((ps) => ps.filter((q) => q.id !== p.id));
		// The card's unmount also reports clear, but its effect ordering
		// isn't the contract — delete the id directly.
		setPendingNames((s) => {
			if (!s.has(p.id)) return s;
			const next = new Set(s);
			next.delete(p.id);
			return next;
		});
		if (refs.length > 0) {
			setNotice({
				text: `Removed — still referenced by ${refs.join(", ")}. Fix before saving.`,
				kind: "err",
			});
		}
	};

	const addProvider = () =>
		setProvs((ps) => [
			...ps,
			{
				id: Math.max(0, ...ps.map((q) => q.id)) + 1,
				name: `provider-${ps.length + 1}`,
				kind: kinds?.provider[0] ?? "openai-compatible",
				baseUrl: "",
				auth: "",
			},
		]);

	const pickModel = (ref: string) => {
		if (sheet === "title") {
			patchDraft({ titleModel: ref });
		} else if (sheet === "vision") {
			setDraft((d) => {
				if (ref === "") {
					last.current.vision = d.vision;
					return { ...d, vision: null };
				}
				const prev = d.vision ??
					last.current.vision ?? { model: "", maxTokens: "2000", mode: "auto" as const };
				return { ...d, vision: { ...prev, model: ref } };
			});
		} else if (sheet === "telegram") {
			patchDraft({ telegramModel: ref });
		} else {
			patchDraft({ model: ref });
		}
		setSheet(null);
	};

	const addId = (list: "operators" | "allowedUsers", v: string) => {
		const n = Number(v);
		if (!Number.isInteger(n) || n <= 0) {
			setNotice({ text: "Telegram user ids are positive integers.", kind: "err" });
			return;
		}
		if (draft[list].includes(n)) {
			setNotice({ text: `${n} is already on that list.`, kind: "err" });
			return;
		}
		patchDraft({ [list]: [...draft[list], n] });
	};

	const save = async () => {
		// A half-typed provider name isn't in the serialized draft — this
		// body would store everything but it and still announce "Saved."
		if (pendingNames.size > 0) {
			setNotice({
				text: "A provider name is still being edited — leave the field to commit it.",
				kind: "err",
			});
			return;
		}
		const err = validateDraft(draft, provs);
		if (err !== null) {
			setNotice({ text: err, kind: "err" });
			return;
		}
		// Saves only run once a baseline exists, and the baseline lands in
		// the same load that fills kinds — unreachable, but never silent.
		if (kinds === null) {
			setNotice({ text: "Settings are still loading.", kind: "err" });
			return;
		}
		setSaving(true);
		setNotice(null);
		const body = bodyFromDraft(draft, provs, kinds.authDefaults);
		const submittedProvs = provs;
		try {
			const res = await saveOperatorConfig(token, body, etag);
			if (res.etag !== null) setEtag(res.etag);
			const ackProvs = submittedProvs.map((p) => {
				const stored = body.providers[p.name.trim()];
				if (stored === undefined) return p;
				const w = stored as { auth?: string; authFile?: string };
				return { ...p, auth: w.auth ?? w.authFile ?? p.auth };
			});
			setBaseline(serialize(draft, ackProvs));
			setProvs((cur) =>
				cur.map((c) => {
					const sub = submittedProvs.find((s) => s.id === c.id);
					const ack = ackProvs.find((a) => a.id === c.id);
					if (sub === undefined || ack === undefined) return c;
					if (c.kind === sub.kind && c.auth === sub.auth) return { ...c, auth: ack.auth };
					return c;
				}),
			);
			setNotice({ text: "Saved.", kind: "ok" });
		} catch (e) {
			setNotice({ kind: "err", ...saveFailure(e) });
		} finally {
			setSaving(false);
		}
	};

	// Save on change: a valid edit writes itself after a short debounce —
	// rapid edits coalesce, an edit mid-write schedules another. A failed
	// write isn't retried on the identical state — the next edit re-arms.
	// A staged field (publicUrl) holds EVERYTHING: the save body is the
	// whole draft, so while an unstaged write would commit a half-edited
	// allowlist, nothing goes out until the operator's explicit Save.
	// The same holds for a pending provider name — an autosave over it
	// would store the old baseline and the savebar would call it "Saved".
	const attempted = useRef<string | null>(null);
	useEffect(() => {
		if (!dirty || stagedDirty || namePending || invalidReason !== null || saving) return;
		const sig = serialize(draft, provs);
		if (!shouldAutosave({ dirty, invalidReason, saving, sig, attempted: attempted.current }))
			return;
		const t = setTimeout(() => {
			attempted.current = sig;
			void save();
		}, 800);
		return () => clearTimeout(t);
	}, [dirty, stagedDirty, namePending, invalidReason, saving, draft, provs]);

	if (loadErr !== null) {
		return (
			<div className="ops settings">
				<p className="error">{loadErr}</p>
			</div>
		);
	}
	if (kinds === null) {
		return (
			<div className="ops settings">
				<p className="empty">Loading settings…</p>
			</div>
		);
	}

	const provNames = provs.map((p) => p.name).filter((n) => n !== "");
	const sheetTitle =
		sheet === "title"
			? "Topic-title model"
			: sheet === "vision"
				? "Vision model"
				: sheet === "telegram"
					? "Telegram model"
					: "App default model";
	const sheetCurrent =
		sheet === "telegram"
			? draft.telegramModel
			: sheet === "title"
				? draft.titleModel
				: sheet === "vision"
					? (draft.vision?.model ?? "")
					: draft.model;

	const modelButton = (label: string, cap: string, mode: SheetMode, val: string, id: string) => (
		<Row label={label} cap={cap} labelId={id}>
			<button
				type="button"
				className="valuebtn"
				aria-labelledby={id}
				onClick={() => setSheet(mode)}
			>
				<span className="val">{val === "" ? "Off" : val}</span>
				<span className="chev">›</span>
			</button>
		</Row>
	);

	// eff is the shown section — null means the narrow-screen index, and
	// on wide viewports the at-index rules swap that index for the chat
	// section so the two-pane never opens on a dead column.
	const eff: Section = section ?? "chat";

	return (
		<div className={`ops settings${section === null ? " at-index" : ""}`}>
			{/* One shared picker for every secret-name input — auth.jsonl
		    record names as loaded at boot, values never. */}
			<datalist id={AUTH_DL}>
				{authNames.map((n) => (
					<option key={n} value={n} />
				))}
			</datalist>
			<nav className="settings-nav" aria-label="Settings sections">
				<h2 className="ops-h2 settings-h2">
					Settings {departureDirty && <span className="dirty-pill">unsaved</span>}
				</h2>
				{SECTIONS.map((s) => (
					<button
						key={s.key}
						type="button"
						className={eff === s.key ? "snav on" : "snav"}
						onClick={() => setSection(s.key)}
					>
						<span className="ilabel">
							{s.label}
							<small>{s.sub}</small>
						</span>
					</button>
				))}
			</nav>
			{section === null && (
				<div className="settings-index">
					<h2 className="ops-h2">
						Settings {departureDirty && <span className="dirty-pill">unsaved</span>}
					</h2>
					<div className="card">
						{SECTIONS.map((s) => (
							<button key={s.key} type="button" className="idx" onClick={() => setSection(s.key)}>
								<span className="ilabel">
									{s.label}
									<small>{s.sub}</small>
								</span>
								<span className="chev">›</span>
							</button>
						))}
					</div>
				</div>
			)}
			{section !== null && (
				<div className="ops-back">
					<button type="button" className="ghost" onClick={() => setSection(null)}>
						‹ Settings
					</button>
					{departureDirty && <span className="dirty-pill">unsaved</span>}
				</div>
			)}

			{eff === "chat" && (
				<>
					<h2 className="ops-h2">App defaults</h2>
					<div className="card">
						{modelButton(
							"Default model",
							"New app conversations only. Each chat remembers its own model and thinking level.",
							"model",
							draft.model,
							"appModelLabel",
						)}
						<Row
							label="Thinking"
							cap={
								levels.app.unavailable
									? "Couldn't check this model's levels — every rung is shown; the server clamps at send time."
									: "Only levels this model can express are shown."
							}
							col
						>
							<Seg
								options={levels.app.values}
								value={displayLevel(draft.thinking, levels.app.values)}
								ariaLabel="App default thinking level"
								onChange={(v) => patchDraft({ thinking: v as ThinkingLevel })}
							/>
						</Row>
					</div>
					{/* Topic titles and Vision are global model calls — they run on
					    Telegram turns too; the card sits outside both channel
					    sections so the grouping says so. */}
					<h2 className="ops-h2">All channels</h2>
					<div className="card">
						{modelButton(
							"Topic titles",
							"Names Telegram topics and new app chats, then stops.",
							"title",
							draft.titleModel,
							"titleModelLabel",
						)}
						{modelButton(
							"Vision",
							"Adds a vision tool — answers questions about image files. Needed when the chat model can't see attachments. Telegram and app turns.",
							"vision",
							draft.vision?.model ?? "",
							"visionLabel",
						)}
					</div>
					<h2 className="ops-h2">Favorites</h2>
					<div className="card">
						<ChipsEditor
							values={draft.favorites}
							onAdd={(v) => patchDraft({ favorites: [...draft.favorites, v] })}
							onRemove={(i) => patchDraft({ favorites: draft.favorites.filter((_, j) => j !== i) })}
							placeholder="provider/model-id"
							ariaLabel="add favorite"
							cap="Offered in the pickers above."
						/>
					</div>
					<h2 className="ops-h2">Telegram</h2>
					<div className="card">
						{modelButton(
							"Model",
							"Shared by all Telegram conversations.",
							"telegram",
							draft.telegramModel,
							"tgModelLabel",
						)}
						<Row
							label="Thinking"
							cap={
								levels.telegram.unavailable
									? "Couldn't check this model's levels — every rung is shown; the server clamps at send time."
									: "Only levels this model can express are shown."
							}
							col
						>
							<Seg
								options={levels.telegram.values}
								value={displayLevel(draft.telegramThinking, levels.telegram.values)}
								ariaLabel="Telegram thinking level"
								onChange={(v) => patchDraft({ telegramThinking: v as ThinkingLevel })}
							/>
						</Row>
						<Row
							label="Rich replies"
							cap="Markdown replies in your DM with a live draft preview while goblin works. Off restores plain text — the off-switch if streaming misbehaves. Applies to new turns."
						>
							<Switch
								on={draft.richReplies}
								ariaLabel="rich replies"
								onChange={(on) => patchDraft({ richReplies: on })}
							/>
						</Row>
						{draft.richReplies && (
							<Row
								label="Show reasoning"
								cap="The model's thinking streams into its own preview bubble and lands collapsed above the reply. DMs only."
							>
								<Switch
									on={draft.showReasoning}
									ariaLabel="show reasoning"
									onChange={(on) => patchDraft({ showReasoning: on })}
								/>
							</Row>
						)}
					</div>
				</>
			)}

			{eff === "voice" && (
				<>
					<h2 className="ops-h2">Voice notes</h2>
					<div className="card">
						<Row
							label="Text to speech"
							cap="On by default — Edge read-aloud, free and unofficial, needs ffmpeg on the host. Failures post a note in chat."
						>
							<Switch
								on={draft.tts !== null}
								ariaLabel="text to speech"
								onChange={(on) =>
									setDraft((d) => {
										if (on) {
											return {
												...d,
												tts: last.current.tts ?? {
													kind: "edge",
													voice: "",
													rate: "",
													voices: [],
													model: "",
													auth: "",
												},
											};
										}
										last.current.tts = d.tts;
										return { ...d, tts: null };
									})
								}
							/>
						</Row>
						{draft.tts !== null && (
							<>
								<Row
									label="Engine"
									cap="Edge runs free and unofficial on this machine's ffmpeg; openrouter and logfare ride their keys through an OpenAI-shaped speech endpoint, mimo through Xiaomi's chat-completions speech."
								>
									<select
										className="mono"
										aria-label="tts kind"
										value={draft.tts.kind}
										onChange={(e) =>
											setDraft((d) =>
												d.tts === null
													? d
													: {
															...d,
															tts: switchTtsKind(
																d.tts,
																e.target.value as TtsKind,
																ttsStash.current,
															),
														},
											)
										}
									>
										<option value="edge">edge</option>
										<option value="openrouter">openrouter</option>
										<option value="logfare">logfare</option>
										<option value="mimo">mimo</option>
									</select>
								</Row>
								{draft.tts.kind !== "edge" && (
									<>
										<Field
											label="Model"
											value={draft.tts.model}
											onChange={(v) => patchTts({ model: v })}
											placeholder={kinds?.ttsDefaults[draft.tts.kind].model}
											mono
											cap={`Blank uses ${kinds?.ttsDefaults[draft.tts.kind].model ?? "the kind's default"}.`}
										/>
										<Field
											label="Secret name"
											value={draft.tts.auth}
											onChange={(v) => patchTts({ auth: v })}
											placeholder={`${kinds?.ttsDefaults[draft.tts.kind].auth ?? "auth"} — in auth.jsonl`}
											cap={
												authWarn(
													draft.tts.auth.trim() || (kinds?.ttsDefaults[draft.tts.kind].auth ?? ""),
													authNames,
												) ??
												(draft.tts.auth.trim() === ""
													? `Blank uses ${kinds?.ttsDefaults[draft.tts.kind].auth ?? "the kind's record"}.`
													: undefined)
											}
											mono
											list={AUTH_DL}
										/>
										<SecretEntry
											token={token}
											name={
												draft.tts.auth.trim() || (kinds?.ttsDefaults[draft.tts.kind].auth ?? "")
											}
											onStored={keyStored((n) => patchTts({ auth: n }))}
										/>
									</>
								)}
								<Field
									label="Voice"
									value={draft.tts.voice}
									onChange={(v) => patchTts({ voice: v })}
									placeholder={draft.tts.kind === "edge" ? "en-US-AriaNeural" : "model default"}
									mono
									cap={
										draft.tts.kind === "edge"
											? "Default for /voice mode, the speaker button, and the speak tool — an alternate matching the reply's language wins; this speaks when the language is unclear or none matches."
											: draft.tts.kind === "openrouter"
												? "The upstream voice id — a Fish voice-library hex id for fish-audio models. Blank speaks the model's default voice."
												: draft.tts.kind === "mimo"
													? "A MiMo built-in voice — Mia, Chloe, Milo, Dean, or a Chinese name like 冰糖. Blank speaks mimo_default."
													: "The upstream voice id — an Aura voice like aura-2-asteria-en for logfare. Blank speaks the model's default voice."
									}
								/>
								{draft.tts.kind === "edge" && (
									<>
										<Field
											label="Rate"
											value={draft.tts.rate}
											onChange={(v) => patchTts({ rate: v })}
											placeholder="+10%"
											mono
										/>
										<ChipsEditor
											values={draft.tts.voices}
											onAdd={(v) =>
												setDraft((d) => ({
													...d,
													tts: d.tts === null ? d.tts : { ...d.tts, voices: [...d.tts.voices, v] },
												}))
											}
											onRemove={(i) =>
												setDraft((d) => ({
													...d,
													tts:
														d.tts === null
															? d.tts
															: { ...d.tts, voices: d.tts.voices.filter((_, j) => j !== i) },
												}))
											}
											placeholder="add a voice"
											ariaLabel="add alternate voice"
											suggestions={VOICE_SUGGESTIONS}
											cap="Alternate voices — picked by reply language wherever speech is synthesized; the speak tool may also name one per call. Only English and Spanish are recognized, matched on each name's language tag."
										/>
									</>
								)}
							</>
						)}
					</div>
					<h2 className="ops-h2">Transcription</h2>
					<div className="card">
						<Row
							label="Speech to text"
							cap="Voice and video notes are transcribed on arrival; the bot can transcribe other audio files on request."
						>
							<Switch
								on={draft.transcription !== null}
								ariaLabel="speech to text"
								onChange={(on) =>
									setDraft((d) => {
										if (on) {
											return {
												...d,
												transcription: last.current.transcription ?? emptyTranscription(),
											};
										}
										last.current.transcription = d.transcription;
										return { ...d, transcription: null };
									})
								}
							/>
						</Row>
						{draft.transcription !== null && (
							<>
								<Row
									label="Engine"
									cap="Whistle runs on this machine with no model or secret; the rest are cloud services."
								>
									<select
										className="mono"
										aria-label="transcription kind"
										value={draft.transcription.kind}
										onChange={(e) => {
											const next = kinds?.transcription.find((k) => k === e.target.value);
											if (next === undefined) return;
											setDraft((d) =>
												d.transcription === null
													? d
													: {
															...d,
															transcription: switchTranscriptionKind(
																d.transcription,
																next,
																trStash.current,
															),
														},
											);
										}}
									>
										{(kinds?.transcription ?? []).map((k) => (
											<option key={k} value={k}>
												{k}
											</option>
										))}
									</select>
								</Row>
								{draft.transcription.kind === "whistle" ? (
									<div className="cap ops-cap">
										Whistle's keyword list and engine path can't be edited here yet — saving keeps
										them exactly as they are.
									</div>
								) : (
									<>
										<Field
											label="Model"
											value={draft.transcription.model}
											onChange={(v) => patchTranscription({ model: v })}
											placeholder="kind default"
											mono
											cap="Blank uses the kind's default."
										/>
										<Field
											label="Secret name"
											value={draft.transcription.auth}
											onChange={(v) => patchTranscription({ auth: v })}
											placeholder={`${kinds.trDefaults[draft.transcription.kind].auth} — in auth.jsonl`}
											cap={
												authWarn(
													draft.transcription.auth.trim() ||
														kinds.trDefaults[draft.transcription.kind].auth,
													authNames,
												) ??
												(draft.transcription.auth.trim() === ""
													? `Blank uses ${kinds.trDefaults[draft.transcription.kind].auth}.`
													: undefined)
											}
											mono
											list={AUTH_DL}
										/>
										<SecretEntry
											token={token}
											name={
												draft.transcription.auth.trim() ||
												kinds.trDefaults[draft.transcription.kind].auth
											}
											onStored={keyStored((n) => patchTranscription({ auth: n }))}
										/>
									</>
								)}
								{draft.transcription.kind === "mimo" ? (
									<Row label="Language" cap="Blank lets the engine detect it.">
										<select
											aria-label="Transcription language"
											value={draft.transcription.language}
											onChange={(e) => patchTranscription({ language: e.target.value })}
										>
											<option value="">Detect</option>
											<option value="auto">Auto</option>
											<option value="zh">Chinese</option>
											<option value="en">English</option>
										</select>
									</Row>
								) : (
									<Field
										label="Language"
										value={draft.transcription.language}
										onChange={(v) => patchTranscription({ language: v })}
										placeholder="detect"
										mono
										cap="An ISO code like es. Blank lets the engine detect it."
									/>
								)}
							</>
						)}
					</div>
				</>
			)}

			{eff === "web" && (
				<>
					<h2 className="ops-h2">Search</h2>
					<div className="card">
						<Row label="Search tool" cap="Off removes search from the agent's tools.">
							<Switch
								on={draft.search !== null}
								ariaLabel="search tool"
								onChange={(on) =>
									setDraft((d) => {
										if (on) return { ...d, search: last.current.search ?? [] };
										last.current.search = d.search;
										return { ...d, search: null };
									})
								}
							/>
						</Row>
					</div>
					{draft.search !== null && (
						<>
							<ChainEditor
								entries={draft.search}
								kinds={kinds.search}
								meta={SEARCH_META}
								defaults={kinds.authDefaults}
								authNames={authNames}
								token={token}
								onSecretStored={rememberAuthName}
								onChange={(search) => patchDraft({ search })}
							/>
							<div className="cap ops-cap">
								Tried top to bottom. A failure moves on to the next; an empty result is an answer
								and stops the chain.
							</div>
						</>
					)}
					<h2 className="ops-h2">Fetch</h2>
					<div className="card">
						<Row
							label="Custom extraction chain"
							cap="Off uses built-in extraction: direct download, no key. JS-heavy sites need the browser skill either way."
						>
							<Switch
								on={draft.fetch !== null}
								ariaLabel="custom extraction chain"
								onChange={(on) =>
									setDraft((d) => {
										if (on) return { ...d, fetch: last.current.fetch ?? [] };
										last.current.fetch = d.fetch;
										return { ...d, fetch: null };
									})
								}
							/>
						</Row>
					</div>
					{draft.fetch !== null && (
						<>
							<ChainEditor
								entries={draft.fetch}
								kinds={kinds.fetch}
								meta={FETCH_META}
								defaults={kinds.authDefaults}
								authNames={authNames}
								token={token}
								onSecretStored={rememberAuthName}
								onChange={(fetch) => patchDraft({ fetch })}
							/>
							<div className="cap ops-cap">Same rule as search — order is the fallback order.</div>
						</>
					)}
				</>
			)}

			{eff === "memory" && (
				<>
					<p className="lead">What goblin retains and recalls — browse it in the Memories view.</p>
					<h2 className="ops-h2">Long-term memory</h2>
					<div className="card">
						<Row
							label="Memory"
							cap="Self-hosted hindsight. Completed exchanges are retained; relevant facts are recalled into new turns."
						>
							<Switch
								on={draft.memory !== null}
								ariaLabel="long-term memory"
								onChange={(on) =>
									setDraft((d) => {
										if (on) {
											return {
												...d,
												memory: last.current.memory ?? {
													baseUrl: "",
													bankId: "",
													auth: "",
													budget: "mid",
													tokens: "",
													timeout: "",
												},
											};
										}
										last.current.memory = d.memory;
										return { ...d, memory: null };
									})
								}
							/>
						</Row>
						{draft.memory !== null && (
							<>
								<Field
									label="Hindsight url"
									value={draft.memory.baseUrl}
									onChange={(v) =>
										setDraft((d) => ({
											...d,
											memory: d.memory === null ? d.memory : { ...d.memory, baseUrl: v },
										}))
									}
									placeholder="http://127.0.0.1:8888"
									mono
								/>
								<Field
									label="Bank id"
									value={draft.memory.bankId}
									onChange={(v) =>
										setDraft((d) => ({
											...d,
											memory: d.memory === null ? d.memory : { ...d.memory, bankId: v },
										}))
									}
									placeholder="goblin"
									mono
								/>
								<Field
									label="Secret name"
									value={draft.memory.auth}
									onChange={(v) =>
										setDraft((d) => ({
											...d,
											memory: d.memory === null ? d.memory : { ...d.memory, auth: v },
										}))
									}
									placeholder="in auth.jsonl — blank for loopback"
									cap={authWarn(draft.memory.auth, authNames)}
									mono
									list={AUTH_DL}
								/>
								<SecretEntry
									token={token}
									name={draft.memory.auth}
									onStored={keyStored((n) =>
										setDraft((d) => ({
											...d,
											memory: d.memory === null ? d.memory : { ...d.memory, auth: n },
										})),
									)}
								/>
								<Row label="Recall budget" col>
									<Seg
										options={["low", "mid", "high"]}
										value={draft.memory.budget || "mid"}
										ariaLabel="Recall budget"
										onChange={(v) =>
											setDraft((d) => ({
												...d,
												memory: d.memory === null ? d.memory : { ...d.memory, budget: v },
											}))
										}
									/>
								</Row>
								<details className="tuning">
									<summary>Recall tuning</summary>
									<div className="inner">
										<Field
											label="Timeout (ms)"
											value={draft.memory.timeout}
											onChange={(v) =>
												setDraft((d) => ({
													...d,
													memory: d.memory === null ? d.memory : { ...d.memory, timeout: v },
												}))
											}
											placeholder="2000"
											numeric
											mono
										/>
										<Field
											label="Max tokens"
											value={draft.memory.tokens}
											onChange={(v) =>
												setDraft((d) => ({
													...d,
													memory: d.memory === null ? d.memory : { ...d.memory, tokens: v },
												}))
											}
											placeholder="1024"
											numeric
											mono
											cap="Tight by default — turns must not wait on memory."
										/>
									</div>
								</details>
							</>
						)}
					</div>
				</>
			)}

			{eff === "providers" && (
				<>
					<p className="lead">
						Model vendors goblin can call. Secrets are names in auth.jsonl — the values never land
						in config.
					</p>
					<h2 className="ops-h2">Providers</h2>
					<div className="prov-grid">
						{provs.map((p) => (
							<ProviderCard
								key={p.id}
								prov={p}
								kinds={kinds.provider}
								referencedBy={p.name !== "" ? providerRefs(p.name) : []}
								authDefaults={kinds.authDefaults}
								authNames={authNames}
								token={token}
								onSecretStored={rememberAuthName}
								onPatch={(patch) => patchProv(p.id, patch)}
								onRename={(v) => renameProvider(p.id, v)}
								onRemove={() => removeProvider(p)}
								onNameDirtyChange={(d) => reportNameDirty(p.id, d)}
							/>
						))}
					</div>
					<button className="ghost" type="button" onClick={addProvider}>
						+ Add provider
					</button>
				</>
			)}

			{eff === "access" && (
				<>
					<h2 className="ops-h2">Operators</h2>
					<div className="card">
						<ChipsEditor
							values={draft.operators.map(String)}
							onAdd={(v) => addId("operators", v)}
							onRemove={(i) => patchDraft({ operators: draft.operators.filter((_, j) => j !== i) })}
							placeholder="telegram user id"
							ariaLabel="add operator"
							numeric
							cap="Telegram user ids with the full personal agent on every surface — these settings included. The list can't be emptied — that would lock everyone out."
						/>
					</div>
					<h2 className="ops-h2">Allowed users</h2>
					<div className="card">
						<ChipsEditor
							values={draft.allowedUsers.map(String)}
							onAdd={(v) => addId("allowedUsers", v)}
							onRemove={(i) =>
								patchDraft({ allowedUsers: draft.allowedUsers.filter((_, j) => j !== i) })
							}
							placeholder="telegram user id"
							ariaLabel="add allowed user"
							numeric
							cap="Telegram user ids that may talk to goblin sandboxed — a guest persona, search-only tools, no memory, no app. DM them directly or @mention in groups; everyone else gets a refusal line."
						/>
					</div>
					<h2 className="ops-h2">Doors</h2>
					<div className="card">
						<Field
							label="Public url"
							value={draft.publicUrl}
							onChange={(v) => patchDraft({ publicUrl: v })}
							placeholder="https://…"
							mono
							cap="HTTPS door for this app — tailscale serve, funnel, or a reverse proxy pointed at the port below. Commits only on Save — an in-between value would cut this tab's own access."
						/>
						<Field
							label="Bot api root"
							value={draft.apiRoot}
							onChange={(v) => patchDraft({ apiRoot: v })}
							placeholder="http://127.0.0.1:8081"
							mono
							cap="Self-hosted telegram-bot-api in --local mode, for large files. Blank = Telegram cloud. Restart applies."
						/>
						<Field
							label="New conversation after (quiet minutes)"
							value={draft.dmGap}
							onChange={(v) => patchDraft({ dmGap: v })}
							placeholder="45"
							numeric
							mono
							cap="Quiet minutes before a DM may roll into a new conversation. Applies immediately."
						/>
					</div>
					<h2 className="ops-h2">Advanced</h2>
					<div className="card">
						<Field
							label="Http port"
							value={draft.port}
							onChange={(v) => patchDraft({ port: v })}
							placeholder="8787"
							numeric
							mono
							cap="The port this settings app is served on. Restart applies."
						/>
						<Row label="Log level" col>
							<Seg
								options={["debug", "info", "warn", "error"]}
								value={draft.logLevel}
								ariaLabel="Log level"
								onChange={(v) => patchDraft({ logLevel: v as SettingsDraft["logLevel"] })}
							/>
						</Row>
					</div>
				</>
			)}

			<div className="savebar">
				<span className={notice?.kind === "err" ? "savebar-msg err" : "savebar-msg"}>
					{(() => {
						if (saving) return "Saving…";
						if (notice?.kind === "err") return notice.text;
						if (invalidReason !== null) return invalidReason;
						const fields = dirtyFields.slice();
						if (namePending) fields.unshift("provider name (still editing)");
						if (fields.length > 0) return `Unsaved: ${fields.join(", ")}`;
						return notice?.text ?? "";
					})()}
				</span>
				{stagedDirty && (
					<button
						type="button"
						className="savebar-save"
						disabled={saving || invalidReason !== null || namePending}
						onClick={() => void save()}
					>
						Save
					</button>
				)}
				{notice?.kind === "err" && notice.retryable === true && !saving && dirty && (
					<button
						type="button"
						className="ghost-inline"
						onClick={() => {
							// Re-arm the attempted guard for this exact state —
							// without it the debounce would chain retries forever.
							attempted.current = serialize(draft, provs);
							void save();
						}}
					>
						retry
					</button>
				)}
			</div>

			{sheet !== null && (
				<ModelSheet
					title={sheetTitle}
					current={sheetCurrent}
					allowOff={sheet === "title" || sheet === "vision"}
					favorites={draft.favorites}
					provNames={provNames}
					onPick={pickModel}
					onClose={() => setSheet(null)}
				/>
			)}
		</div>
	);
}
