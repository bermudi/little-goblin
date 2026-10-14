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
export type TtsKind = "edge" | "openrouter" | "logfare";
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
// Blank falls back to the kind's defaults server-side.
export function switchTtsKind(t: TtsDraft, kind: TtsKind): TtsDraft {
	if (kind === t.kind) return t;
	return { ...t, kind, voice: "", model: "", auth: "" };
}
export type TranscriptionKind = (typeof transcriptionKinds)[number];

// The whole transcription block, widened to one shape. Whistle arms carry
// no model/auth; cloud arms carry no keywords/engine/weights. Both kinds
// keep every field so a save never drops a hand edit.
export interface TrDraft {
	kind: TranscriptionKind;
	model: string;
	auth: string;
	language: string;
	keywords: string[];
	engine: string;
	weights: string;
}

export function emptyTranscription(kind: TranscriptionKind = "whistle"): TrDraft {
	return { kind, model: "", auth: "", language: "", keywords: [], engine: "", weights: "" };
}

// The identity fields — model + auth — don't carry across kinds: a groq
// model + secret left under openai would send groq's credential to
// openai. Blank is always safe — cloud blanks fall back to the kind's
// defaults server-side. Whistle-only fields (keywords/engine/weights)
// DO ride along: they are hand-edit-only, so clearing them would
// destroy config the form cannot restore, and transcriptionBody emits
// them on the whistle arm only — they cannot leak into a cloud save.
export function switchTranscriptionKind(t: TrDraft, kind: TranscriptionKind): TrDraft {
	if (kind === t.kind) return t;
	return { ...t, kind, model: "", auth: "" };
}

function transcriptionDraft(t: NonNullable<Config["transcription"]>): TrDraft {
	// Optional fields may hold an explicit undefined (zod's parse output).
	const w: {
		kind: TranscriptionKind;
		model?: string | undefined;
		auth?: string | undefined;
		language?: string | undefined;
		keywords?: string[] | undefined;
		engine?: string | undefined;
		weights?: string | undefined;
	} = t;
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

function transcriptionBody(t: TrDraft): NonNullable<ConfigPostBody["transcription"]> {
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
						preferObservations: c.memory.preferObservations ?? true,
						minScores: c.memory.minScores ?? { semantic: 0.3 },
						searchMaxTokens: c.memory.searchMaxTokens ?? 4096,
						searchBudget: c.memory.searchBudget ?? "high",
						searchMinScores: c.memory.searchMinScores ?? {},
						reflectMaxTokens: c.memory.reflectMaxTokens ?? 4096,
						reflectBudget: c.memory.reflectBudget ?? "high",
						reflectTimeoutMs: c.memory.reflectTimeoutMs ?? 120_000,
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
