import { useEffect, useRef, useState } from "react";
import type { ThinkingLevel } from "../../src/config.ts";
import type {
	ConfigResponse,
	OperatorStatusResponse,
	ProviderModelCatalog,
	ProviderPreset,
} from "../../src/http/operator-wire.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import {
	ApiError,
	getOperatorConfig,
	getServiceStatus,
	getThinkingLevels,
	saveOperatorConfig,
} from "./api.ts";
import { SettingsAccess } from "./SettingsAccess.tsx";
import { SettingsAccounts } from "./SettingsAccounts.tsx";
import { SettingsCapabilities } from "./SettingsCapabilities.tsx";
import { SettingsMemory } from "./SettingsMemory.tsx";
import { SettingsModels } from "./SettingsModels.tsx";
import { SettingsSystem } from "./SettingsSystem.tsx";
import { SettingsTelegram } from "./SettingsTelegram.tsx";
import { SettingsVoice } from "./SettingsVoice.tsx";
import { SettingsWeb } from "./SettingsWeb.tsx";
import { saveFailure, shouldAutosave } from "./settingsSave.ts";
import {
	bodyFromDraft,
	capabilityFlags,
	CAPABILITY_NAMES,
	draftFromConfig,
	EMPTY_DRAFT,
	type ProvDraft,
	type SettingsDraft,
	THINKING_ORDER,
	type TrDraft,
	type TrKindStash,
	type TtsDraft,
	type TtsKindStash,
	validateDraft,
} from "./settingsDraft.ts";
import {
	type ChannelLevels,
	type LastStash,
	Row,
	type Section,
	type SettingsCtx,
	type SheetMode,
} from "./settingsKit.tsx";

const SECTIONS: { key: Section; label: string; sub: string }[] = [
	{ key: "models", label: "Models", sub: "Chat models, helpers, favorites" },
	{ key: "accounts", label: "Accounts & keys", sub: "ChatGPT, model services, API keys" },
	{ key: "web", label: "Web", sub: "Search and page reading" },
	{ key: "voice", label: "Voice", sub: "Speaking and transcription" },
	{ key: "memory", label: "Memory", sub: "Long-term memory" },
	{ key: "telegram", label: "Telegram", sub: "Bot channel and replies" },
	{ key: "access", label: "Access", sub: "Who can talk to goblin" },
	{ key: "capabilities", label: "Capabilities", sub: "Tools goblin can use" },
	{ key: "system", label: "System", sub: "Version, restarts, log level" },
];

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
	telegramEnabled: "telegram channel",
	telegramModel: "telegram model",
	telegramThinking: "telegram thinking",
	tts: "text to speech",
	transcription: "speech to text",
	vision: "vision",
	image: "image generation",
	capabilities: "capabilities",
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

export function SettingsView({
	token,
	onDirtyChange,
}: {
	token: string | null;
	onDirtyChange?: (dirty: boolean) => void;
}) {
	const [kinds, setKinds] = useState<SettingsCtx["kinds"] | null>(null);
	const [authNames, setAuthNames] = useState<string[]>([]);
	const [authCommandNames, setAuthCommandNames] = useState<string[]>([]);
	const [serviceNames, setServiceNames] = useState<Record<string, string>>({});
	const [providerPresets, setProviderPresets] = useState<ProviderPreset[]>([]);
	const [capStates, setCapStates] = useState<ConfigResponse["capabilities"] | null>(null);
	const [status, setStatus] = useState<OperatorStatusResponse | null>(null);
	const [modelCatalog, setModelCatalog] = useState<ProviderModelCatalog[]>([]);
	const [hasAppToken, setHasAppToken] = useState(false);
	// A stored key's record joins the picker list so the "not in the
	// saved keys" hint clears without a reload; apply() points the
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
		retryable?: boolean;
	} | null>(null);
	const [saving, setSaving] = useState(false);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	// Bumps the settings GET — a completed ChatGPT sign-in may have
	// added a codex provider, so the form reloads on transition.
	const [reloadTick, setReloadTick] = useState(0);
	// Turned-off blocks keep their last content — toggling back on
	// restores it.
	const last = useRef<LastStash>({
		tts: null,
		transcription: null,
		vision: null,
		search: null,
		fetch: null,
		memory: null,
	});
	const ttsStash = useRef<TtsKindStash>({});
	const trStash = useRef<TrKindStash>({});
	const [levels, setLevels] = useState<{ app: ChannelLevels; telegram: ChannelLevels }>({
		app: { values: [...THINKING_ORDER], unavailable: false },
		telegram: { values: [...THINKING_ORDER], unavailable: false },
	});
	const thinkSeq = useRef(0);
	const patchDraft = (patch: Partial<SettingsDraft>) => setDraft((d) => ({ ...d, ...patch }));
	const patchProv = (id: number, patch: Partial<ProvDraft>) =>
		setProvs((ps) => ps.map((q) => (q.id === id ? { ...q, ...patch } : q)));
	const patchTts = (p: Partial<TtsDraft>) =>
		setDraft((d) => (d.tts === null ? d : { ...d, tts: { ...d.tts, ...p } }));
	const patchTranscription = (p: Partial<TrDraft>) =>
		setDraft((d) =>
			d.transcription === null ? d : { ...d, transcription: { ...d.transcription, ...p } },
		);
	const setCapability = (k: keyof SettingsDraft["capabilities"], on: boolean) =>
		setDraft((d) => ({ ...d, capabilities: { ...d.capabilities, [k]: on } }));

	// Provider ids whose card holds an uncommitted name draft — typed
	// but not blurred. That text is in no serialized field, so it joins
	// the dirty flag as a second, independent departure hazard.
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
	const departureDirty = dirty || namePending;
	useEffect(() => onDirtyChange?.(departureDirty), [departureDirty, onDirtyChange]);

	const { dirtyFields } = (() => {
		const none = { dirtyFields: [] as string[] };
		if (!dirty || baseline === null) return none;
		const cur = JSON.parse(serialize(draft, provs)) as { d: SettingsDraft; ps: unknown[] };
		const base = JSON.parse(baseline) as { d: SettingsDraft; ps: unknown[] };
		const keys = (Object.keys(FIELD_LABELS) as (keyof SettingsDraft)[]).filter(
			(k) => JSON.stringify(cur.d[k]) !== JSON.stringify(base.d[k]),
		);
		const fields = keys.map((k) => FIELD_LABELS[k]);
		if (JSON.stringify(cur.ps) !== JSON.stringify(base.ps)) fields.push("providers");
		return { dirtyFields: fields };
	})();

	const invalidReason = dirty ? validateDraft(draft, provs) : null;

	useEffect(() => {
		let live = true;
		getOperatorConfig(token).then(
			({ data, etag: tag }) => {
				if (!live) return;
				// A freshly built client against a not-yet-restarted server
				// (the forbidden rollout window) must fail loud here, not
				// crash later when a save materializes from authDefaults or
				// the model sheet reads the catalog.
				if (!("authDefaults" in data) || !("modelCatalog" in data)) {
					setLoadErr("The settings endpoint predates this client — restart goblin, then reload.");
					return;
				}
				const { draft: d, providers } = draftFromConfig(data.config, data.capabilities);
				setCapStates(data.capabilities ?? null);
				setHasAppToken(data.config.appToken !== undefined);
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
				setAuthCommandNames(data.authCommandNames ?? []);
				setServiceNames(data.serviceNames ?? {});
				setProviderPresets(data.providerPresets ?? []);
				setModelCatalog(data.modelCatalog);
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
	}, [token, reloadTick]);

	// The restart banner's source — fetched once and after every save.
	const refreshStatus = () => {
		getServiceStatus(token)
			.then((s) => setStatus(s))
			.catch(() => setStatus(null));
	};
	const statusSeq = useRef(0);
	useEffect(() => {
		const seq = ++statusSeq.current;
		getServiceStatus(token)
			.then((s) => {
				if (seq === statusSeq.current) setStatus(s);
			})
			.catch(() => {
				if (seq === statusSeq.current) setStatus(null);
			});
	}, [token, reloadTick]);

	// Thinking-level capability lookups — kind/base/model from the
	// form's own provider state, debounced.
	const provsSig = provs.map((p) => `${p.name.trim()}|${p.kind}|${p.baseUrl.trim()}`).join(",");
	useEffect(() => {
		if (kinds === null) return;
		const seq = ++thinkSeq.current;
		const t = setTimeout(() => {
			const channel = async (ref: string): Promise<ChannelLevels> => {
				const slash = ref.indexOf("/");
				if (slash <= 0) return { values: [...THINKING_ORDER], unavailable: true };
				const p = provs.find((x) => x.name.trim() === ref.slice(0, slash));
				if (p === undefined) return { values: [...THINKING_ORDER], unavailable: true };
				const base = "baseUrl" in p && typeof p.baseUrl === "string" ? p.baseUrl : undefined;
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

	const renameProvider = (id: number, v: string): string | null => {
		if (v === "") return "Every provider needs a name.";
		if (provs.some((q) => q.id !== id && q.name === v)) return `Duplicate provider name: ${v}`;
		setProvs((ps) => ps.map((q) => (q.id === id ? { ...q, name: v } : q)));
		return null;
	};

	// Which draft fields still name a provider — shown under the card
	// and repeated on remove.
	const providerRefs = (name: string): string[] => {
		const refs: string[] = [];
		const pfx = `${name}/`;
		if (draft.model.startsWith(pfx)) refs.push("app default model");
		if (draft.telegramModel.startsWith(pfx)) refs.push("Telegram model");
		if (draft.titleModel.startsWith(pfx)) refs.push("topic titles");
		if (draft.vision?.model.startsWith(pfx)) refs.push("vision");
		if (draft.image?.model.startsWith(pfx)) refs.push("image generation");
		if (draft.favorites.some((f) => f.startsWith(pfx))) refs.push("favorites");
		return refs;
	};

	const removeProvider = (p: ProvDraft) => {
		const refs = p.name !== "" ? providerRefs(p.name) : [];
		setProvs((ps) => ps.filter((q) => q.id !== p.id));
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

	const addProv = (p: Omit<ProvDraft, "id">) =>
		setProvs((ps) => [...ps, { id: Math.max(0, ...ps.map((q) => q.id)) + 1, ...p }]);

	const pickModel = (ref: string) => {
		if (sheet === "title") {
			patchDraft({ titleModel: ref });
		} else if (sheet === "vision") {
			setDraft((d) => {
				if (ref === "") {
					last.current.vision = d.vision;
					return {
						...d,
						capabilities: { ...d.capabilities, vision: false },
						vision: null,
					};
				}
				const prev = d.vision ??
					last.current.vision ?? { model: "", maxTokens: "2000", mode: "auto" as const };
				return {
					...d,
					capabilities: { ...d.capabilities, vision: true },
					vision: { ...prev, model: ref },
				};
			});
		} else if (sheet === "image") {
			setDraft((d) => {
				if (ref === "") {
					return {
						...d,
						capabilities: { ...d.capabilities, image: false },
						image: null,
					};
				}
				return {
					...d,
					capabilities: { ...d.capabilities, image: true },
					image: { ...(d.image ?? { model: "", size: "" }), model: ref },
				};
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
		const loadedCaps =
			capStates === null
				? undefined
				: capabilityFlags(CAPABILITY_NAMES.filter((k) => capStates[k]?.state === "on"));
		const body = bodyFromDraft(draft, provs, kinds.authDefaults, loadedCaps);
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
			// The capability baseline tracks the saved draft — a second save
			// diffs against what the server now holds.
			if (capStates !== null) {
				setCapStates(
					(cur) =>
						Object.fromEntries(
							CAPABILITY_NAMES.map((k) => [
								k,
								{
									state: draft.capabilities[k]
										? "on"
										: cur?.[k].state === "needs-setup"
											? "needs-setup"
											: "off",
									hint: cur?.[k].hint ?? null,
								},
							]),
						) as ConfigResponse["capabilities"],
				);
			}
			refreshStatus();
			setNotice({ text: "Saved.", kind: "ok" });
		} catch (e) {
			setNotice({ kind: "err", ...saveFailure(e) });
		} finally {
			setSaving(false);
		}
	};

	// Save on change: a valid edit writes itself after a short debounce.
	// A failed write isn't retried on the identical state — the next
	// edit re-arms.
	const attempted = useRef<string | null>(null);
	useEffect(() => {
		if (!dirty || namePending || invalidReason !== null || saving) return;
		const sig = serialize(draft, provs);
		if (!shouldAutosave({ dirty, invalidReason, saving, sig, attempted: attempted.current }))
			return;
		const t = setTimeout(() => {
			attempted.current = sig;
			void save();
		}, 800);
		return () => clearTimeout(t);
	}, [dirty, namePending, invalidReason, saving, draft, provs]);

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
	// ref → catalog display name, for the value buttons and the
	// favorites list; a favorite the catalog doesn't know shows its ref.
	const modelNames = new Map<string, string>();
	for (const group of modelCatalog)
		for (const m of group.models)
			if (m.name != null) modelNames.set(`${group.provider}/${m.id}`, m.name);

	const toggleFavoriteDraft = (ref: string, on: boolean) =>
		patchDraft({
			favorites: on
				? draft.favorites.includes(ref)
					? draft.favorites
					: [...draft.favorites, ref]
				: draft.favorites.filter((f) => f !== ref),
		});
	const moveFavorite = (i: number, d: number) => {
		const j = i + d;
		if (j < 0 || j >= draft.favorites.length) return;
		const next = draft.favorites.slice();
		next[i] = next[j]!;
		next[j] = draft.favorites[i]!;
		patchDraft({ favorites: next });
	};

	const sheetTitle =
		sheet === "title"
			? "Topic-title model"
			: sheet === "vision"
				? "Vision model"
				: sheet === "image"
					? "Image generation model"
					: sheet === "telegram"
						? "Telegram model"
						: sheet === "favorites"
							? "Favorites"
							: "App default model";
	const sheetCurrent =
		sheet === "telegram"
			? draft.telegramModel
			: sheet === "title"
				? draft.titleModel
				: sheet === "vision"
					? (draft.vision?.model ?? "")
					: sheet === "image"
						? (draft.image?.model ?? "")
						: sheet === "favorites"
							? ""
							: draft.model;

	const modelButton = (label: string, cap: string, mode: SheetMode, val: string, id: string) => {
		const name = val === "" ? null : (modelNames.get(val) ?? null);
		return (
			<Row label={label} cap={cap} labelId={id}>
				<button
					type="button"
					className="valuebtn"
					aria-labelledby={id}
					title={val === "" ? undefined : val}
					onClick={() => setSheet(mode)}
				>
					<span className="val">
						<span className="val-name">{val === "" ? "Off" : (name ?? val)}</span>
						{name !== null && <span className="val-ref">{val}</span>}
					</span>
					<span className="chev">›</span>
				</button>
			</Row>
		);
	};

	const eff: Section = section ?? "models";

	const ctx: SettingsCtx = {
		token,
		draft,
		provs,
		kinds,
		authNames,
		authCommandNames,
		serviceNames,
		providerPresets,
		capStates,
		status,
		hasAppToken,
		modelCatalog,
		modelNames,
		provNames,
		levels,
		patchDraft,
		setDraft,
		patchProv,
		patchTts,
		patchTranscription,
		setCapability,
		renameProvider,
		providerRefs,
		removeProvider,
		addProv,
		reportNameDirty,
		rememberAuthName,
		keyStored,
		addId,
		setSheet,
		setNotice,
		reload: () => setReloadTick((t) => t + 1),
		toggleFavoriteDraft,
		moveFavorite,
		last,
		ttsStash,
		trStash,
		modelButton,
	};

	// The image sheet only offers providers that can run the OpenAI
	// images endpoint — the ones carrying a base url.
	const imageCatalog = modelCatalog.filter((g) =>
		provs.some(
			(p) => p.name === g.provider && (p.kind === "openai-compatible" || p.kind === "responses"),
		),
	);

	const restartHints = status?.restartHints ?? [];

	return (
		<div className={`ops settings${section === null ? " at-index" : ""}`}>
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

			{restartHints.length > 0 && (
				<div className="card restart-banner">
					Restart goblin to apply: {restartHints.join(", ")}
				</div>
			)}

			{eff === "models" && <SettingsModels ctx={ctx} />}
			{eff === "accounts" && <SettingsAccounts ctx={ctx} />}
			{eff === "web" && <SettingsWeb ctx={ctx} />}
			{eff === "voice" && <SettingsVoice ctx={ctx} />}
			{eff === "memory" && <SettingsMemory ctx={ctx} />}
			{eff === "telegram" && <SettingsTelegram ctx={ctx} />}
			{eff === "access" && <SettingsAccess ctx={ctx} />}
			{eff === "capabilities" && <SettingsCapabilities ctx={ctx} />}
			{eff === "system" && <SettingsSystem ctx={ctx} />}

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
				<ModelPicker
					title={sheetTitle}
					current={sheetCurrent}
					allowOff={sheet === "title" || sheet === "vision" || sheet === "image"}
					favorites={draft.favorites}
					catalog={sheet === "image" ? imageCatalog : modelCatalog}
					provNames={provNames}
					mode={sheet === "favorites" ? "favorites" : "pick"}
					onPick={pickModel}
					onToggleFavorite={toggleFavoriteDraft}
					onClose={() => setSheet(null)}
				/>
			)}
		</div>
	);
}
