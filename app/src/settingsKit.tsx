// Shared controls and types for the settings sections — every section
// file gets the same `ctx` bag from SettingsView, so moved blocks
// compile unchanged against it.

import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { CapabilityName, ThinkingLevel, transcriptionKinds } from "../../src/config.ts";
import type {
	ConfigResponse,
	OperatorStatusResponse,
	ProviderModelCatalog,
	ProviderPreset,
} from "../../src/http/operator-wire.ts";
import { ApiError, storeSecret } from "./api.ts";
import type {
	ChainEntry,
	MemDraft,
	ProvDraft,
	SettingsDraft,
	TranscriptionKind,
	TrDraft,
	TrKindStash,
	TtsDraft,
	TtsKindStash,
	VisDraft,
} from "./settingsDraft.ts";

export type Section =
	| "models"
	| "accounts"
	| "web"
	| "voice"
	| "memory"
	| "telegram"
	| "access"
	| "capabilities"
	| "system";
export type SheetMode = "model" | "telegram" | "title" | "vision" | "image" | "favorites";

// One channel's thinking rungs: the offered values plus whether the
// capability lookup behind them failed.
export interface ChannelLevels {
	values: string[];
	unavailable: boolean;
}

// Turned-off blocks keep their last content — toggling back on
// restores it.
export interface LastStash {
	tts: TtsDraft | null;
	transcription: TrDraft | null;
	vision: VisDraft | null;
	search: ChainEntry[] | null;
	fetch: ChainEntry[] | null;
	memory: MemDraft | null;
}

// What the sections see — every piece of editor state plus its
// patchers. Sections destructure what they use.
export interface SettingsCtx {
	token: string | null;
	draft: SettingsDraft;
	provs: ProvDraft[];
	kinds: {
		provider: readonly string[];
		search: readonly string[];
		fetch: readonly string[];
		transcription: readonly TranscriptionKind[];
		authDefaults: ConfigResponse["authDefaults"];
		trDefaults: ConfigResponse["transcriptionDefaults"];
		ttsDefaults: ConfigResponse["ttsDefaults"];
	};
	authNames: string[];
	authCommandNames: string[];
	serviceNames: Record<string, string>;
	providerPresets: ProviderPreset[];
	capStates: ConfigResponse["capabilities"] | null;
	status: OperatorStatusResponse | null;
	/** config.appToken is set — the app door is bearer-gated. */
	hasAppToken: boolean;
	modelCatalog: ProviderModelCatalog[];
	modelNames: Map<string, string>;
	provNames: string[];
	levels: { app: ChannelLevels; telegram: ChannelLevels };
	patchDraft(patch: Partial<SettingsDraft>): void;
	setDraft(updater: (d: SettingsDraft) => SettingsDraft): void;
	patchProv(id: number, patch: Partial<ProvDraft>): void;
	patchTts(p: Partial<TtsDraft>): void;
	patchTranscription(p: Partial<TrDraft>): void;
	setCapability(k: CapabilityName, on: boolean): void;
	renameProvider(id: number, v: string): string | null;
	providerRefs(name: string): string[];
	removeProvider(p: ProvDraft): void;
	addProv(p: Omit<ProvDraft, "id">): void;
	reportNameDirty(id: number, dirty: boolean): void;
	rememberAuthName(name: string): void;
	keyStored(apply: (name: string) => void): (name: string) => void;
	addId(list: "operators" | "allowedUsers", v: string): void;
	setSheet(m: SheetMode | null): void;
	setNotice(n: { text: string; kind: "err" | "ok" } | null): void;
	reload(): void;
	toggleFavoriteDraft(ref: string, on: boolean): void;
	moveFavorite(i: number, d: number): void;
	last: { current: LastStash };
	ttsStash: { current: TtsKindStash };
	trStash: { current: TrKindStash };
	modelButton(label: string, cap: string, mode: SheetMode, val: string, id: string): ReactNode;
}

// Display name for a kind/provider id — the server's service catalog
// first, the raw id when nothing's registered.
export const displayName = (names: Record<string, string>, id: string): string => names[id] ?? id;

// A kind's default key record — the wire's authDefaults is a closed
// literal map, so dynamic kind lookups widen it here.
export const authDefault = (defs: ConfigResponse["authDefaults"], kind: string): string =>
	(defs as Record<string, string>)[kind] ?? "";

export function Seg({
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

export function Switch({
	on,
	onChange,
	ariaLabel,
	disabled,
}: {
	on: boolean;
	onChange: (on: boolean) => void;
	ariaLabel: string;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			className={on ? "switch on" : "switch"}
			aria-pressed={on}
			aria-label={ariaLabel}
			disabled={disabled === true}
			onClick={() => onChange(!on)}
		/>
	);
}

export function Row({
	label,
	cap,
	children,
	col,
	labelId,
}: {
	label: string;
	cap?: string | undefined;
	children?: ReactNode;
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

export function Field({
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

export function ChipsEditor({
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

// A numbered, reorderable list — chain rows in Web and Voice, the
// favorites list. Each row: position, content, then ↑ ↓ ×.
export function OrderedList({
	items,
	onMove,
	onRemove,
	cap,
}: {
	items: {
		key: string | number;
		label: ReactNode;
		sub?: ReactNode;
		aside?: ReactNode;
	}[];
	onMove(i: number, d: number): void;
	onRemove(i: number): void;
	cap?: string;
}) {
	return (
		<>
			{items.map((it, i) => (
				<div className="chain-card" key={it.key}>
					<div className="chain-head">
						<span className="chain-num">{i + 1}</span>
						<span className="fav-cell">
							<span className="fav-name">{it.label}</span>
							{it.sub !== undefined && <span className="fav-ref">{it.sub}</span>}
						</span>
						{it.aside}
						<span className="chain-btns">
							<button
								type="button"
								aria-label="move up"
								disabled={i === 0}
								onClick={() => onMove(i, -1)}
							>
								↑
							</button>
							<button
								type="button"
								aria-label="move down"
								disabled={i === items.length - 1}
								onClick={() => onMove(i, 1)}
							>
								↓
							</button>
							<button type="button" aria-label="remove" onClick={() => onRemove(i)}>
								×
							</button>
						</span>
					</div>
				</div>
			))}
			{cap !== undefined && <div className="cap ops-cap">{cap}</div>}
		</>
	);
}

// The paste box — former SecretEntry. Stores a value under a fixed
// record name (never editable in the form itself); the name surfaces
// only as a tooltip on the status line.
function KeyPaste({
	token,
	name,
	verb,
	onStored,
}: {
	token: string | null;
	/** The record name this store lands under — blank hides the box. */
	name: string;
	verb: string;
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
				{verb}
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
			<div className="cap">Saved as a key record — resolvable right away, no restart.</div>
			{err !== null && <div className="cap err-inline">{err}</div>}
		</div>
	);
}

// One service's key state — replaces every former secret-name input.
// `name` is the effective record name (explicit value or the kind's
// default); it appears only as a tooltip, never as an editable field.
export function KeyStatus({
	token,
	name,
	keyless,
	commandNames,
	authNames,
	onStored,
}: {
	token: string | null;
	name: string;
	/** Kind carries no credential at all (ddg, local, edge, whistle…). */
	keyless?: boolean;
	commandNames: readonly string[];
	authNames: readonly string[];
	onStored: (name: string) => void;
}) {
	if (keyless === true) {
		return <span className="cap keystat">No key needed</span>;
	}
	const record = name.trim();
	if (record !== "" && commandNames.includes(record)) {
		return (
			<span className="cap keystat" title={record}>
				From pass-keys
			</span>
		);
	}
	const saved = record !== "" && authNames.includes(record);
	return (
		<span className="keystat">
			{saved ? (
				<span className="cap keystat" title={record}>
					Key saved
				</span>
			) : (
				<span className="cap err-inline keystat" title={record === "" ? undefined : record}>
					Key missing
				</span>
			)}
			<KeyPaste
				key={record}
				token={token}
				name={record}
				verb={saved ? "Replace" : "Add key"}
				onStored={onStored}
			/>
		</span>
	);
}
