// The settings editor's draft state — a port of the mini app's
// DraftState/populate()/buildBody()/validate() (src/http/app.js). The
// wire body is identical (ConfigPostBody); the server still validates
// through the config schema, this module only catches what the form
// can express badly before a round trip.

import type {
	Config,
	ProviderConfig,
	ThinkingLevel,
	transcriptionKinds,
} from "../../src/config.ts";
import type { ConfigPostBody } from "../../src/http/operator-wire.ts";

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
	auth: "required" | "optional" | "none";
	note?: string;
}

export const SEARCH_META: Record<string, KindMeta> = {
	brave: { auth: "required" },
	exa: { auth: "required" },
	jina: { auth: "optional", note: "Works keyless, rate-limited." },
	tavily: { auth: "required" },
	firecrawl: { auth: "required" },
	parallel: { auth: "required" },
	ddg: { auth: "none", note: "Keyless — unofficial endpoint, may rate-limit or break." },
};
export const FETCH_META: Record<string, KindMeta> = {
	local: { auth: "none", note: "Direct download + readability — no key." },
	jina: { auth: "optional", note: "Works keyless, rate-limited." },
	tavily: { auth: "required" },
	firecrawl: { auth: "required" },
	parallel: { auth: "required" },
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
export interface TtsDraft {
	voice: string;
	rate: string;
	voices: string[];
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

// Provider-specific fields don't carry across kinds: a groq model + secret
// left under openai would send groq's credential to openai, and one left
// under whistle would save into the wrong union arm. Blank is always
// safe — cloud blanks fall back to the kind's defaults server-side.
export function switchTranscriptionKind(t: TrDraft, kind: TranscriptionKind): TrDraft {
	if (kind === t.kind) return t;
	const cleared = { ...t, kind, model: "", auth: "" };
	if (kind === "whistle") return cleared;
	return { ...cleared, keywords: [], engine: "", weights: "" };
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
	allowedUsers: number[];
	publicUrl: string;
	apiRoot: string;
	dmGap: string;
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
	allowedUsers: [],
	publicUrl: "",
	apiRoot: "",
	dmGap: "45",
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
				: { voice: c.tts.voice || "", rate: c.tts.rate || "", voices: [...(c.tts.voices ?? [])] },
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
		allowedUsers: [...c.allowedUsers],
		publicUrl: c.publicUrl || "",
		apiRoot: c.telegram.apiRoot || "",
		dmGap: c.telegram.dmGapMinutes !== undefined ? String(c.telegram.dmGapMinutes) : "45",
		port: c.http !== undefined ? String(c.http.port) : "8787",
		logLevel: c.logLevel || "info",
		memory: c.memory
			? {
					baseUrl: c.memory.baseUrl || "",
					bankId: c.memory.bankId || "",
					auth: c.memory.auth || "",
					budget: c.memory.budget || "low",
					tokens: c.memory.maxTokens !== undefined ? String(c.memory.maxTokens) : "",
					timeout: c.memory.recallTimeoutMs !== undefined ? String(c.memory.recallTimeoutMs) : "",
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
// requester here — the schema's min(1) on allowedUsers covers lockout.
export function validateDraft(draft: SettingsDraft, provs: ProvDraft[]): string | null {
	const names = provs.map((p) => p.name.trim());
	if (names.some((n) => !n)) return "Every provider needs a name.";
	if (new Set(names).size !== names.length) return "Duplicate provider name.";
	for (const p of provs) {
		if (p.kind === "openai-compatible" || p.kind === "responses") {
			if (!p.baseUrl.trim()) return `Provider "${p.name}" needs a base url.`;
			if (!p.auth.trim()) return `Provider "${p.name}" needs a secret name.`;
		} else if (p.kind === "openrouter" && !p.auth.trim()) {
			return `Provider "${p.name}" needs a secret name.`;
		}
	}
	if (!draft.model) return "Pick an app default model.";
	if (!draft.telegramModel) return "Pick a Telegram model.";
	if (draft.tts && !draft.tts.voice.trim()) return "Text to speech is on — set a voice.";
	if (
		draft.transcription &&
		draft.transcription.kind !== "whistle" &&
		!draft.transcription.auth.trim()
	)
		return "Transcription is on — set a secret name.";
	if (draft.vision && !draft.vision.model.trim()) return "Vision is on — pick a model.";
	if (draft.search) {
		if (!draft.search.length) return "Search is on — add at least one provider, or switch it off.";
		for (const [i, e] of draft.search.entries()) {
			const m = SEARCH_META[e.kind];
			if (m?.auth === "required" && !e.auth.trim()) {
				return `Search step ${i + 1} (${e.kind}) needs a secret name.`;
			}
		}
	}
	if (draft.fetch) {
		if (!draft.fetch.length)
			return "The fetch chain is on — add at least one provider, or switch it off.";
		for (const [i, e] of draft.fetch.entries()) {
			const m = FETCH_META[e.kind];
			if (m?.auth === "required" && !e.auth.trim()) {
				return `Fetch step ${i + 1} (${e.kind}) needs a secret name.`;
			}
		}
	}
	if (draft.memory) {
		if (!draft.memory.baseUrl.trim()) return "Memory is on — set the hindsight url.";
		if (!draft.memory.bankId.trim()) return "Memory is on — set a bank id.";
	}
	const port = Number(draft.port);
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		return "Http port must be a number between 0 and 65535.";
	if (draft.publicUrl.trim() && !draft.publicUrl.trim().startsWith("https://")) {
		return "Public URL must use HTTPS for Telegram Web Apps.";
	}
	if (!draft.allowedUsers.length) return "Allowed users must keep at least one Telegram id.";
	return null;
}

// buildBody(): the POST body — identical contract to the mini app's.
export function bodyFromDraft(draft: SettingsDraft, provs: ProvDraft[]): ConfigPostBody {
	const providers: Record<string, ProviderConfig> = {};
	for (const p of provs) {
		const name = p.name.trim();
		if (p.kind === "openai-compatible" || p.kind === "responses") {
			providers[name] = { kind: p.kind, baseUrl: p.baseUrl.trim(), auth: p.auth.trim() };
		} else if (p.kind === "codex") {
			providers[name] = p.auth.trim()
				? { kind: p.kind, authFile: p.auth.trim() }
				: { kind: p.kind };
		} else {
			providers[name] = {
				kind: p.kind as "openrouter",
				auth: p.auth.trim(),
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
				: {
						kind: "edge",
						voice: draft.tts.voice.trim(),
						rate: draft.tts.rate.trim() || undefined,
						voices: draft.tts.voices.length ? [...draft.tts.voices] : undefined,
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
		allowedUsers: [...draft.allowedUsers],
		telegram: {
			model: draft.telegramModel,
			thinking: draft.telegramThinking,
			apiRoot: draft.apiRoot.trim() || undefined,
			// raw like http.port — the server validates.
			dmGapMinutes: Number(draft.dmGap),
		},
		publicUrl: draft.publicUrl.trim(),
		http: { port: Number(draft.port) },
		memory:
			draft.memory === null
				? ""
				: {
						baseUrl: draft.memory.baseUrl.trim(),
						bankId: draft.memory.bankId.trim(),
						auth: draft.memory.auth.trim() || undefined,
						budget: (draft.memory.budget || "low") as "low" | "mid" | "high",
						maxTokens: numOrUndef(draft.memory.tokens),
						recallTimeoutMs: numOrUndef(draft.memory.timeout),
					},
		logLevel: draft.logLevel,
	};
}
