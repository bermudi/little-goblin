// The settings editor's draft state — seeded as a port of the retired
// plain-JS mini app's DraftState/populate()/buildBody()/validate(),
// now an independent client (design/app.md, Operator console): the
// contract is ConfigPostBody, and the server's config-schema validation
// is the gate. This module only catches what the form can express
// badly before a round trip.

import type {
	Config,
	MemoryConfig,
	ProviderConfig,
	ThinkingLevel,
	TranscriptionEntry,
	transcriptionKinds,
} from "../../src/config.ts";
import type { ConfigPostBody, ConfigResponse } from "../../src/http/operator-wire.ts";

// The full operator vocabulary — the fallback when the model is
// unknown, and the ordering for nearest-rung clamping (mirrors the
// server's thinkingLevels).
export const THINKING_ORDER: readonly ThinkingLevel[] = [
	"off",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export interface KindMeta {
	// Keyed kinds carry no marker: blank auth means the kind's own
	// auth.jsonl record (authDefaults, served with the config), so the
	// editor never needs to require one.
	auth: "optional" | "none";
	note?: string;
}

export const SEARCH_META: Record<string, KindMeta> = {
	jina: { auth: "optional", note: "Works keyless, rate-limited." },
	ddg: { auth: "none", note: "Keyless — unofficial endpoint, may rate-limit or break." },
};
export const FETCH_META: Record<string, KindMeta> = {
	local: { auth: "none", note: "Direct download + readability — no key." },
	jina: { auth: "optional", note: "Works keyless, rate-limited." },
};

export const VOICE_SUGGESTIONS = [
	"en-US-AriaNeural",
	"en-US-GuyNeural",
	"en-GB-SoniaNeural",
	"en-AU-NatashaNeural",
	"es-ES-ElviraNeural",
	"es-MX-JorgeNeural",
	"de-DE-KatjaNeural",
	"fr-FR-DeniseNeural",
	"pt-BR-FranciscaNeural",
	"it-IT-ElsaNeural",
	"ru-RU-SvetlanaNeural",
	"pl-PL-ZofiaNeural",
	"uk-UA-PolinaNeural",
	"tr-TR-EmelNeural",
	"ar-EG-SalmaNeural",
	"hi-IN-SwaraNeural",
	"ja-JP-NanamiNeural",
	"ko-KR-SunHiNeural",
	"zh-CN-XiaoxiaoNeural",
	"nl-NL-ColetteNeural",
	"sv-SE-SofieNeural",
];

/** One ordered chain step (search/fetch) while editing. */
export interface ChainEntry {
	kind: string;
	auth: string;
}
/** Provider card while editing — numeric-ish fields stay strings. */
export interface ProvDraft {
	id: number;
	name: string;
	kind: string;
	baseUrl: string;
	auth: string;
}
export type TtsKind = "edge" | "openrouter" | "logfare" | "mimo";
// Widened like TrDraft: edge-only fields (rate/voices) and
// cloud-only fields (model/auth) all ride the draft so a save
// never drops a hand edit; bodyFromDraft emits each kind's own arm.
export interface TtsDraft {
	kind: TtsKind;
	voice: string;
	rate: string;
	voices: string[];
	model: string;
	auth: string;
}

// Identity fields don't carry across kinds: an edge voice name left
// under openrouter would go upstream as a Fish voice-library id and
// 400, and a stale model/auth would point a key at the wrong model.
// Blank falls back to the kind's defaults server-side. The stash
// remembers each kind's fields so a switch away and back restores
// them — session memory only, never part of the saved body.
export type TtsKindStash = Partial<Record<TtsKind, { voice: string; model: string; auth: string }>>;

export function switchTtsKind(t: TtsDraft, kind: TtsKind, stash?: TtsKindStash): TtsDraft {
	if (kind === t.kind) return t;
	if (stash !== undefined) stash[t.kind] = { voice: t.voice, model: t.model, auth: t.auth };
	const back = stash?.[kind];
	return { ...t, kind, voice: back?.voice ?? "", model: back?.model ?? "", auth: back?.auth ?? "" };
}
export type TranscriptionKind = (typeof transcriptionKinds)[number];

// One chain link, widened — the primary block and each fallback entry
// share this shape. Whistle arms carry no model/auth; cloud arms carry
// no keywords/engine/weights. Every field survives in the draft so a
// save never drops a hand edit.
export interface TrEntryDraft {
	kind: TranscriptionKind;
	model: string;
	auth: string;
	language: string;
	keywords: string[];
	engine: string;
	weights: string;
}

export interface TrDraft extends TrEntryDraft {
	// Ordered retry chain — rendered by the fallback editor; entries
	// carry no chain of their own (depth one, ≤4, per the schema).
	fallbacks: TrEntryDraft[];
}

export function emptyTrEntry(kind: TranscriptionKind = "whistle"): TrEntryDraft {
	return { kind, model: "", auth: "", language: "", keywords: [], engine: "", weights: "" };
}

export function emptyTranscription(kind: TranscriptionKind = "whistle"): TrDraft {
	return { ...emptyTrEntry(kind), fallbacks: [] };
}

// The identity fields — model + auth — don't carry across kinds: a groq
// model + secret left under openai would send groq's credential to
// openai. Blank is always safe — cloud blanks fall back to the kind's
// defaults server-side. Whistle-only fields (keywords/engine/weights)
// DO ride along: they are hand-edit-only, so clearing them would
// destroy config the form cannot restore, and transcriptionBody emits
// them on the whistle arm only — they cannot leak into a cloud save.
// The stash remembers each kind's fields so a switch away and back
// restores them — session memory only, never part of the saved body.
export type TrKindStash = Partial<
	Record<TranscriptionKind, { model: string; auth: string; language: string }>
>;

export function switchTranscriptionKind<T extends TrEntryDraft>(
	t: T,
	kind: TranscriptionKind,
	stash?: TrKindStash,
): T {
	if (kind === t.kind) return t;
	if (stash !== undefined) stash[t.kind] = { model: t.model, auth: t.auth, language: t.language };
	const back = stash?.[kind];
	let language = back?.language ?? t.language;
	// MiMo has a closed vocabulary; its explicit auto is not an ISO code
	// for other cloud kinds, and Whistle cannot accept Chinese either.
	// A stashed value is verbatim by construction — it was valid on
	// that kind when it was stashed — so only carried text needs this.
	if (back === undefined) {
		if (
			(kind === "mimo" && !["auto", "zh", "en"].includes(language)) ||
			(t.kind === "mimo" && (language === "auto" || (kind === "whistle" && language === "zh")))
		)
			language = "";
	}
	return { ...t, kind, model: back?.model ?? "", auth: back?.auth ?? "", language };
}

// Same rule as transcription kinds above: the auth reference is
// kind-scoped — a secret name left over from openai-compatible would
// resolve and be sent to openrouter's endpoint on the next autosave.
// Blank is always safe: it materializes to the provider's own name
// (openrouter: the kind's default record) at save. baseUrl rides
// along — not a credential, and the kinds that need it restore the
// editable field. The stash remembers each kind's auth so a switch
// away and back restores it — session memory only.
export function switchProviderKind(
	p: ProvDraft,
	kind: string,
	stash?: Record<string, string>,
): ProvDraft {
	if (kind === p.kind) return p;
	if (stash !== undefined) stash[p.kind] = p.auth;
	return { ...p, kind, auth: stash?.[kind] ?? "" };
}

// One entry's widen — primary block or fallback link alike; optional
// fields may hold an explicit undefined (zod's parse output).
function transcriptionEntryDraft(e: TranscriptionEntry): TrEntryDraft {
	const w: {
		kind: TranscriptionKind;
		model?: string | undefined;
		auth?: string | undefined;
		language?: string | undefined;
		keywords?: string[] | undefined;
		engine?: string | undefined;
		weights?: string | undefined;
	} = e;
	return {
		kind: w.kind,
		model: w.model || "",
		auth: w.auth || "",
		language: w.language || "",
		keywords: [...(w.keywords ?? [])],
		engine: w.engine || "",
		weights: w.weights || "",
	};
}

function transcriptionDraft(t: NonNullable<Config["transcription"]>): TrDraft {
	return {
		...transcriptionEntryDraft(t),
		fallbacks: (t.fallbacks ?? []).map(transcriptionEntryDraft),
	};
}

// The wire arm's object shape — the union also carries "" (clear) and
// null (unchanged), so entries extract off the object arm only.
type TrBodyArm = Extract<NonNullable<ConfigPostBody["transcription"]>, { kind: string }>;
type TrBodyEntry = NonNullable<TrBodyArm["fallbacks"]>[number];

// One chain link → its wire arm. Same field rules as the primary:
// whistle drops model/auth, cloud drops keywords/engine/weights, and
// blanks stay blank for the server's defaults.
function transcriptionEntryBody(t: TrEntryDraft): Omit<TrBodyArm, "fallbacks"> {
	const language = t.language.trim();
	if (t.kind === "whistle") {
		return {
			kind: "whistle",
			...(language ? { language } : {}),
			...(t.keywords.length ? { keywords: [...t.keywords] } : {}),
			...(t.engine.trim() ? { engine: t.engine.trim() } : {}),
			...(t.weights.trim() ? { weights: t.weights.trim() } : {}),
		};
	}
	// Blank cloud fields fall back to the kind's defaults on the server.
	return {
		kind: t.kind,
		...(t.model.trim() ? { model: t.model.trim() } : {}),
		...(t.auth.trim() ? { auth: t.auth.trim() } : {}),
		...(language ? { language } : {}),
	};
}

function transcriptionBody(t: TrDraft): TrBodyArm {
	const body = transcriptionEntryBody(t);
	if (t.fallbacks.length === 0) return body;
	return { ...body, fallbacks: t.fallbacks.map(transcriptionEntryBody) };
}
export interface VisDraft {
	model: string;
	maxTokens: string;
	mode: "auto" | "always";
}
export interface MemDraft {
	baseUrl: string;
	bankId: string;
	auth: string;
	budget: string;
	tokens: string;
	timeout: string;
	policy?: Omit<
		MemoryConfig,
		"baseUrl" | "bankId" | "auth" | "budget" | "maxTokens" | "recallTimeoutMs"
	>;
}

// The editor's mirror of the config. null blocks mean "unset" — saved
// as "", which the server normalizes to absent.
export interface SettingsDraft {
	model: string;
	titleModel: string;
	favorites: string[];
	thinking: ThinkingLevel;
	telegramModel: string;
	telegramThinking: ThinkingLevel;
	tts: TtsDraft | null;
	transcription: TrDraft | null;
	vision: VisDraft | null;
	search: ChainEntry[] | null;
	fetch: ChainEntry[] | null;
	operators: number[];
	allowedUsers: number[];
	publicUrl: string;
	apiRoot: string;
	dmGap: string;
	richReplies: boolean;
	showReasoning: boolean;
	port: string;
	logLevel: "debug" | "info" | "warn" | "error";
	memory: MemDraft | null;
}

export const EMPTY_DRAFT: SettingsDraft = {
	model: "",
	titleModel: "",
	favorites: [],
	thinking: "medium",
	telegramModel: "",
	telegramThinking: "medium",
	tts: null,
	transcription: null,
	vision: null,
	search: null,
	fetch: null,
	operators: [],
	allowedUsers: [],
	publicUrl: "",
	apiRoot: "",
	dmGap: "45",
	richReplies: true,
	showReasoning: false,
	port: "8787",
	logLevel: "info",
	memory: null,
};

let provSeq = 0;

// populate(): the loaded Config → the editable draft. Optional blocks
// arrive as their config arm or absent; draft nulls are "off".
export function draftFromConfig(c: Config): { draft: SettingsDraft; providers: ProvDraft[] } {
	const widen = (e: { kind: string; auth?: string | undefined }): ChainEntry => ({
		kind: e.kind,
		auth: e.auth ?? "",
	});
	const draft: SettingsDraft = {
		model: c.model || "",
		titleModel: c.titleModel || "",
		favorites: (c.favorites || []).slice(),
		thinking: c.thinking || "medium",
		telegramModel: c.telegram.model || c.model,
		telegramThinking: c.telegram.thinking || c.thinking,
		tts:
			c.tts === false || c.tts === undefined
				? null
				: {
						kind: c.tts.kind,
						voice: c.tts.voice || "",
						rate: c.tts.kind === "edge" ? c.tts.rate || "" : "",
						voices: c.tts.kind === "edge" ? [...(c.tts.voices ?? [])] : [],
						// Cloud arms share {model, auth, voice} — edge is the odd one.
						model: c.tts.kind !== "edge" ? c.tts.model : "",
						auth: c.tts.kind !== "edge" ? c.tts.auth : "",
					},
		transcription: c.transcription ? transcriptionDraft(c.transcription) : null,
		vision: c.vision
			? {
					model: c.vision.model || "",
					maxTokens: String(c.vision.maxTokens || 2000),
					mode: c.vision.mode || "auto",
				}
			: null,
		search: Array.isArray(c.search) ? c.search.map(widen) : null,
		fetch: Array.isArray(c.fetch) ? c.fetch.map(widen) : null,
		operators: [...c.operators],
		allowedUsers: [...c.allowedUsers],
		publicUrl: c.publicUrl || "",
		apiRoot: c.telegram.apiRoot || "",
		dmGap: c.telegram.dmGapMinutes !== undefined ? String(c.telegram.dmGapMinutes) : "45",
		richReplies: c.telegram.richReplies,
		showReasoning: c.telegram.showReasoning,
		port: c.http !== undefined ? String(c.http.port) : "8787",
		logLevel: c.logLevel || "info",
		memory: c.memory
			? {
					baseUrl: c.memory.baseUrl || "",
					bankId: c.memory.bankId || "",
					auth: c.memory.auth || "",
					budget: c.memory.budget || "mid",
					tokens: c.memory.maxTokens !== undefined ? String(c.memory.maxTokens) : "",
					timeout: c.memory.recallTimeoutMs !== undefined ? String(c.memory.recallTimeoutMs) : "",
					policy: {
						preferObservations: c.memory.preferObservations,
						minScores: c.memory.minScores,
						searchMaxTokens: c.memory.searchMaxTokens,
						searchBudget: c.memory.searchBudget,
						searchTimeoutMs: c.memory.searchTimeoutMs,
						searchMinScores: c.memory.searchMinScores,
						reflectMaxTokens: c.memory.reflectMaxTokens,
						reflectBudget: c.memory.reflectBudget,
						reflectTimeoutMs: c.memory.reflectTimeoutMs,
					},
				}
			: null,
	};
	// Union arms differ (openrouter has no baseUrl, codex uses authFile);
	// widen once — absent fields read as undefined either way.
	const providers: ProvDraft[] = Object.entries(c.providers || {}).map(([name, p]) => {
		const w = p as { kind: string; baseUrl?: string; auth?: string; authFile?: string };
		return {
			id: ++provSeq,
			name,
			kind: w.kind,
			baseUrl: w.baseUrl || "",
			auth: w.auth || w.authFile || "",
		};
	});
	return { draft, providers };
}

// The nearest expressible rung at or above the configured level —
// the segmented control highlights the rung the model will actually
// deliver (mirrors the mini app's displayLevel()).
export function displayLevel(configured: ThinkingLevel, levels: readonly string[]): string {
	const idx = THINKING_ORDER.indexOf(configured);
	return (
		levels.find((l) => THINKING_ORDER.indexOf(l as ThinkingLevel) >= idx) ??
		levels[levels.length - 1] ??
		configured
	);
}

// validate(): catches what the form can express badly; the server's
// schema is still the gate. The mini app's own-id check has no
// requester here — the schema's min(1) on operators covers lockout.
export function validateDraft(draft: SettingsDraft, provs: ProvDraft[]): string | null {
	const names = provs.map((p) => p.name.trim());
	if (names.some((n) => !n)) return "Every provider needs a name.";
	if (new Set(names).size !== names.length) return "Duplicate provider name.";
	for (const p of provs) {
		if (p.kind === "openai-compatible" || p.kind === "responses") {
			if (!p.baseUrl.trim()) return `Provider "${p.name}" needs a base url.`;
		}
	}
	// No secret-name checks anywhere: a blank provider auth means the
	// provider's own name (openrouter: its default record), a blank step
	// or cloud-transcription auth means the kind's — materialized below
	// and defaulted server-side. The picker's "not in auth.jsonl" hint
	// covers the typo case without blocking config-before-key.
	if (!draft.model) return "Pick an app default model.";
	if (!draft.telegramModel) return "Pick a Telegram model.";
	if (draft.tts && draft.tts.kind === "edge" && !draft.tts.voice.trim())
		return "Text to speech is on — set a voice.";
	// No transcription secret check: whistle takes none, and a blank cloud
	// secret means the kind's default record — the server fills it.
	if (draft.vision && !draft.vision.model.trim()) return "Vision is on — pick a model.";
	if (draft.search && !draft.search.length)
		return "Search is on — add at least one provider, or switch it off.";
	if (draft.fetch && !draft.fetch.length)
		return "The fetch chain is on — add at least one provider, or switch it off.";
	if (draft.memory) {
		if (!draft.memory.baseUrl.trim()) return "Memory is on — set the hindsight url.";
		if (!draft.memory.bankId.trim()) return "Memory is on — set a bank id.";
	}
	const port = Number(draft.port);
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		return "Http port must be a number between 0 and 65535.";
	// Number("") is 0 and junk is NaN — catch both here, not as a raw
	// 422 from the server (its schema: int, min 1).
	const dmGap = Number(draft.dmGap);
	if (!Number.isInteger(dmGap) || dmGap < 1)
		return "New-conversation gap must be a whole number of minutes, 1 or more.";
	if (draft.publicUrl.trim() && !draft.publicUrl.trim().startsWith("https://")) {
		return "Public URL must use HTTPS for Telegram Web Apps.";
	}
	if (!draft.operators.length) return "Operators must keep at least one Telegram id.";
	return null;
}

// buildBody(): the POST body — the contract is ConfigPostBody. Blank
// provider auths materialize here (the provider's own name; openrouter:
// its default record) so the saved file always carries an explicit
// name — the config stays self-describing and a later rename never
// re-points a credential.
export function bodyFromDraft(
	draft: SettingsDraft,
	provs: ProvDraft[],
	authDefaults: ConfigResponse["authDefaults"],
): ConfigPostBody {
	const providers: Record<string, ProviderConfig> = {};
	for (const p of provs) {
		const name = p.name.trim();
		if (p.kind === "openai-compatible" || p.kind === "responses") {
			providers[name] = { kind: p.kind, baseUrl: p.baseUrl.trim(), auth: p.auth.trim() || name };
		} else if (p.kind === "codex") {
			providers[name] = p.auth.trim()
				? { kind: p.kind, authFile: p.auth.trim() }
				: { kind: p.kind };
		} else {
			providers[name] = {
				kind: p.kind as "openrouter",
				auth: p.auth.trim() || authDefaults.openrouter,
			};
		}
	}
	const chainOut = (arr: ChainEntry[] | null, meta: Record<string, KindMeta>) =>
		(arr || []).map((e) => {
			const m = meta[e.kind];
			const auth = (e.auth || "").trim();
			if (!auth || m?.auth === "none") return { kind: e.kind };
			return { kind: e.kind, auth };
		});
	const numOrUndef = (s: string) => (s.trim() ? Number(s.trim()) : undefined);
	return {
		providers,
		model: draft.model,
		// "" clears — server normalizes.
		titleModel: draft.titleModel,
		favorites: [...draft.favorites],
		thinking: draft.thinking,
		tts:
			draft.tts === null
				? ""
				: draft.tts.kind === "edge"
					? {
							kind: "edge",
							voice: draft.tts.voice.trim(),
							rate: draft.tts.rate.trim() || undefined,
							voices: draft.tts.voices.length ? [...draft.tts.voices] : undefined,
						}
					: {
							kind: draft.tts.kind,
							// Blanks mean the kind's defaults — materialized server-side.
							...(draft.tts.model.trim() ? { model: draft.tts.model.trim() } : {}),
							...(draft.tts.auth.trim() ? { auth: draft.tts.auth.trim() } : {}),
							...(draft.tts.voice.trim() ? { voice: draft.tts.voice.trim() } : {}),
						},
		transcription: draft.transcription === null ? "" : transcriptionBody(draft.transcription),
		vision:
			draft.vision === null
				? ""
				: {
						model: draft.vision.model.trim(),
						maxTokens: Number(draft.vision.maxTokens) || 2000,
						mode: draft.vision.mode,
					},
		search: draft.search === null ? "" : chainOut(draft.search, SEARCH_META),
		fetch: draft.fetch === null ? "" : chainOut(draft.fetch, FETCH_META),
		operators: [...draft.operators],
		allowedUsers: [...draft.allowedUsers],
		telegram: {
			model: draft.telegramModel,
			thinking: draft.telegramThinking,
			// "" clears — the server treats an absent key as "keep".
			apiRoot: draft.apiRoot.trim(),
			// raw like http.port — the server validates.
			dmGapMinutes: Number(draft.dmGap),
			richReplies: draft.richReplies,
			showReasoning: draft.showReasoning,
		},
		publicUrl: draft.publicUrl.trim(),
		http: { port: Number(draft.port) },
		memory:
			draft.memory === null
				? ""
				: {
						...draft.memory.policy,
						baseUrl: draft.memory.baseUrl.trim(),
						bankId: draft.memory.bankId.trim(),
						auth: draft.memory.auth.trim() || undefined,
						budget: (draft.memory.budget || "mid") as "low" | "mid" | "high",
						maxTokens: numOrUndef(draft.memory.tokens),
						recallTimeoutMs: numOrUndef(draft.memory.timeout),
					},
		logLevel: draft.logLevel,
	};
}
