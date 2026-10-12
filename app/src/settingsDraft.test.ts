import { describe, expect, test } from "bun:test";
import { authDefaults, parseConfig, type Config } from "../../src/config.ts";
import {
	bodyFromDraft,
	displayLevel,
	draftFromConfig,
	emptyTranscription,
	switchTranscriptionKind,
	validateDraft,
	type ProvDraft,
	type SettingsDraft,
} from "./settingsDraft.ts";

// A Config in its parsed shape — the same object the settings GET
// ships inside ConfigResponse.
const baseConfig = (): Config => ({
	providers: {
		main: { kind: "openai-compatible", baseUrl: "https://api.example.test", auth: "MAIN_KEY" },
		route: { kind: "openrouter", auth: "OR_KEY" },
		dex: { kind: "codex" },
	},
	model: "main/gpt-5",
	titleModel: undefined,
	favorites: ["main/gpt-5", "route/auto"],
	thinking: "high",
	tts: false,
	transcription: undefined,
	vision: undefined,
	search: undefined,
	fetch: undefined,
	operators: [111],
	allowedUsers: [111, 222],
	telegram: { model: "route/auto", thinking: "low", dmGapMinutes: 45, richReplies: true, showReasoning: false },
	publicUrl: "https://goblin.example.test",
	http: { port: 8787 },
	logLevel: "info",
	memory: undefined,
});

const prov = (over: Partial<ProvDraft> = {}): ProvDraft => ({
	id: 1,
	name: "main",
	kind: "openai-compatible",
	baseUrl: "https://api.example.test",
	auth: "KEY",
	...over,
});

const draft = (over: Partial<SettingsDraft> = {}): SettingsDraft => ({
	model: "main/gpt-5",
	titleModel: "",
	favorites: [],
	thinking: "medium",
	telegramModel: "main/gpt-5",
	telegramThinking: "medium",
	tts: null,
	transcription: null,
	vision: null,
	search: null,
	fetch: null,
	operators: [111],
	allowedUsers: [111],
	publicUrl: "",
	apiRoot: "",
	dmGap: "45",
	port: "8787",
	logLevel: "info",
	memory: null,
	...over,
});

describe("draftFromConfig", () => {
	test("absent optional blocks become null; telegram falls back to the top-level picks", () => {
		const c = baseConfig();
		c.telegram = { dmGapMinutes: 45, richReplies: true, showReasoning: false };
		const { draft: d } = draftFromConfig(c);
		expect(d.tts).toBeNull();
		expect(d.transcription).toBeNull();
		expect(d.vision).toBeNull();
		expect(d.search).toBeNull();
		expect(d.fetch).toBeNull();
		expect(d.memory).toBeNull();
		// Mini-app populate(): telegram model/thinking pin to the
		// top-level when the channel block doesn't carry them.
		expect(d.telegramModel).toBe("main/gpt-5");
		expect(d.telegramThinking).toBe("high");
	});

	test("provider union arms widen to one card shape", () => {
		const { providers } = draftFromConfig(baseConfig());
		expect(providers.map((p) => p.name)).toEqual(["main", "route", "dex"]);
		expect(providers[0]).toMatchObject({
			kind: "openai-compatible",
			baseUrl: "https://api.example.test",
			auth: "MAIN_KEY",
		});
		expect(providers[1]).toMatchObject({ kind: "openrouter", auth: "OR_KEY" });
		// codex's auth field is the CLI's OAuth file, surfaced as auth.
		expect(providers[2]).toMatchObject({ kind: "codex", auth: "" });
	});

	test("populated optional blocks keep their values", () => {
		const c = baseConfig();
		c.tts = { kind: "edge", voice: "en-US-AriaNeural", rate: "+5%", voices: ["de-DE-KatjaNeural"] };
		c.memory = {
			baseUrl: "http://127.0.0.1:8888",
			bankId: "goblin",
			budget: "mid",
			maxTokens: 1024,
			recallTimeoutMs: 2000,
		};
		c.search = [{ kind: "brave", auth: "BRAVE_KEY" }, { kind: "ddg" }];
		const { draft: d } = draftFromConfig(c);
		expect(d.tts).toEqual({
			voice: "en-US-AriaNeural",
			rate: "+5%",
			voices: ["de-DE-KatjaNeural"],
		});
		expect(d.memory).toMatchObject({
			baseUrl: "http://127.0.0.1:8888",
			bankId: "goblin",
			budget: "mid",
		});
		expect(d.search).toEqual([
			{ kind: "brave", auth: "BRAVE_KEY" },
			{ kind: "ddg", auth: "" },
		]);
	});
});

describe("validateDraft", () => {
	test("a sane draft passes", () => {
		expect(validateDraft(draft(), [prov()])).toBeNull();
	});

	test("provider names must be present and unique", () => {
		expect(validateDraft(draft(), [prov({ name: " " })])).toMatch(/name/);
		expect(
			validateDraft(draft(), [prov(), prov({ id: 2, name: "main", kind: "openrouter" })]),
		).toMatch(/Duplicate/);
	});

	test("openai-compatible providers need a base url; blank auth means their own name", () => {
		expect(validateDraft(draft(), [prov({ baseUrl: "" })])).toMatch(/base url/);
		// Blank auth is no longer a validation error — bodyFromDraft
		// materializes the provider's name (openrouter: its default record).
		expect(validateDraft(draft(), [prov({ auth: " " })])).toBeNull();
		// codex needs neither — the CLI's own auth file is the default.
		expect(validateDraft(draft(), [prov({ kind: "codex", baseUrl: "", auth: "" })])).toBeNull();
	});

	test("enabled blocks validate their required fields", () => {
		expect(validateDraft(draft({ tts: { voice: "", rate: "", voices: [] } }), [prov()])).toMatch(
			/voice/,
		);
		expect(
			validateDraft(draft({ vision: { model: "", maxTokens: "2000", mode: "auto" } }), [prov()]),
		).toMatch(/Vision/);
		expect(
			validateDraft(
				draft({
					memory: { baseUrl: "", bankId: "", auth: "", budget: "low", tokens: "", timeout: "" },
				}),
				[prov()],
			),
		).toMatch(/hindsight url/);
	});

	test("chains need at least one step; blank step auth rides the kind default", () => {
		expect(validateDraft(draft({ search: [] }), [prov()])).toMatch(/add at least one/);
		// Keyed kinds default their record server-side — blank is valid.
		expect(validateDraft(draft({ search: [{ kind: "brave", auth: "" }] }), [prov()])).toBeNull();
		// ddg needs no key.
		expect(validateDraft(draft({ search: [{ kind: "ddg", auth: "" }] }), [prov()])).toBeNull();
	});

	test("port range, https public url, and non-empty allowed users", () => {
		expect(validateDraft(draft({ port: "abc" }), [prov()])).toMatch(/port/);
		expect(validateDraft(draft({ port: "70000" }), [prov()])).toMatch(/port/);
		expect(validateDraft(draft({ publicUrl: "http://x.test" }), [prov()])).toMatch(/HTTPS/);
		expect(validateDraft(draft({ operators: [] }), [prov()])).toMatch(/Operators/);
	});

	test("dm gap must be a whole number of minutes, 1 or more", () => {
		// Number("") is 0, junk is NaN — both must fail client-side
		// instead of surfacing the server's 422 in the savebar.
		expect(validateDraft(draft({ dmGap: "" }), [prov()])).toMatch(/New-conversation gap/);
		expect(validateDraft(draft({ dmGap: "soon" }), [prov()])).toMatch(/New-conversation gap/);
		expect(validateDraft(draft({ dmGap: "0" }), [prov()])).toMatch(/New-conversation gap/);
		expect(validateDraft(draft({ dmGap: "4.5" }), [prov()])).toMatch(/New-conversation gap/);
		expect(validateDraft(draft({ dmGap: "90" }), [prov()])).toBeNull();
	});

	test("both models are required", () => {
		expect(validateDraft(draft({ model: "" }), [prov()])).toMatch(/app default/);
		expect(validateDraft(draft({ telegramModel: "" }), [prov()])).toMatch(/Telegram/);
	});
});

describe("bodyFromDraft", () => {
	test("null blocks serialize as the clearing convention", () => {
		const body = bodyFromDraft(draft(), [prov()], authDefaults);
		expect(body.tts).toBe("");
		expect(body.transcription).toBe("");
		expect(body.vision).toBe("");
		expect(body.search).toBe("");
		expect(body.fetch).toBe("");
		expect(body.memory).toBe("");
	});

	test("providers map by kind — codex writes authFile, not a secret", () => {
		const body = bodyFromDraft(
			draft(),
			[
				prov({ name: "main" }),
				prov({ id: 2, name: "dex", kind: "codex", baseUrl: "", auth: "/home/me/.codex/auth.json" }),
				prov({ id: 3, name: "dex2", kind: "codex", baseUrl: "", auth: "" }),
			],
			authDefaults,
		);
		expect(body.providers["main"]).toEqual({
			kind: "openai-compatible",
			baseUrl: "https://api.example.test",
			auth: "KEY",
		});
		expect(body.providers["dex"]).toEqual({ kind: "codex", authFile: "/home/me/.codex/auth.json" });
		expect(body.providers["dex2"]).toEqual({ kind: "codex" });
	});

	test("blank provider auth materializes — the provider's name, or the kind default", () => {
		const body = bodyFromDraft(
			draft(),
			[
				prov({ name: "zai", auth: "" }),
				prov({ id: 2, name: "route", kind: "openrouter", baseUrl: "", auth: " " }),
			],
			authDefaults,
		);
		// The config stays self-describing: saves write an explicit name,
		// so a later rename never re-points a credential.
		expect(body.providers["zai"]).toMatchObject({ auth: "zai" });
		expect(body.providers["route"]).toMatchObject({ auth: "openrouter" });
	});

	test("keyless and defaulted chain steps drop their auth field", () => {
		const body = bodyFromDraft(
			draft({
				search: [
					{ kind: "brave", auth: "BRAVE_KEY" },
					{ kind: "ddg", auth: "ignored" },
					{ kind: "jina", auth: "" },
					{ kind: "tavily", auth: "" },
				],
			}),
			[prov()],
			authDefaults,
		);
		expect(body.search).toEqual([
			{ kind: "brave", auth: "BRAVE_KEY" },
			{ kind: "ddg" },
			{ kind: "jina" },
			// Blank keyed auth rides the schema default server-side.
			{ kind: "tavily" },
		]);
	});

	// JSON drops `undefined`, so a blank that must clear has to be "" on the
	// wire — pinned through a real JSON round trip, not the in-memory object.
	test("a blank bot API root goes over the wire as an explicit clear", () => {
		const body = bodyFromDraft(draft({ apiRoot: "  " }), [prov()], authDefaults);
		expect(body.telegram.apiRoot).toBe("");
		expect(JSON.parse(JSON.stringify(body)).telegram).toMatchObject({ apiRoot: "" });
	});

	test("numeric fields coerce; blanks mean undefined", () => {
		const body = bodyFromDraft(
			draft({
				port: "9999",
				dmGap: "30",
				apiRoot: "  ",
				memory: {
					baseUrl: "http://127.0.0.1:8888",
					bankId: "goblin",
					auth: " ",
					budget: "high",
					tokens: "2048",
					timeout: "",
				},
			}),
			[prov()],
			authDefaults,
		);
		expect(body.http.port).toBe(9999);
		expect(body.telegram.dmGapMinutes).toBe(30);
		expect(body.memory).toEqual({
			baseUrl: "http://127.0.0.1:8888",
			bankId: "goblin",
			auth: undefined,
			budget: "high",
			maxTokens: 2048,
			recallTimeoutMs: undefined,
		});
	});

	test("round-trips a parsed config through draft and back", () => {
		const c = baseConfig();
		c.tts = { kind: "edge", voice: "en-US-AriaNeural" };
		c.transcription = { kind: "groq", model: "whisper-large-v3-turbo", auth: "GROQ_KEY" };
		c.vision = { model: "main/vl", maxTokens: 3000, mode: "always" };
		const { draft: d, providers } = draftFromConfig(c);
		expect(validateDraft(d, providers)).toBeNull();
		const body = bodyFromDraft(d, providers, authDefaults);
		expect(body.model).toBe("main/gpt-5");
		expect(body.telegram.model).toBe("route/auto");
		expect(body.vision).toEqual({ model: "main/vl", maxTokens: 3000, mode: "always" });
		expect(body.transcription).toEqual({
			kind: "groq",
			model: "whisper-large-v3-turbo",
			auth: "GROQ_KEY",
		});
		expect(body.allowedUsers).toEqual([111, 222]);
	});
});

describe("displayLevel", () => {
	test("clamps to the nearest expressible rung at or above the setting", () => {
		expect(displayLevel("high", ["off", "low", "medium", "high"])).toBe("high");
		expect(displayLevel("high", ["off", "medium"])).toBe("medium");
		expect(displayLevel("off", ["low", "medium"])).toBe("low");
	});
});

// The transcription block is one shape on the client but two arms on the
// wire: whistle (local, keywords/engine/weights) and the cloud kinds
// (model/auth). The page must never drop or leak fields across them.
describe("transcription block", () => {
	test("a whistle block validates without a secret name", () => {
		expect(validateDraft(draft({ transcription: emptyTranscription() }), [prov()])).toBeNull();
	});

	// Blank cloud model and secret are the server's job: config.ts fills the
	// kind's defaults, and the mini app already saves blanks the same way.
	// Rejecting blanks here blocked a valid Whistle -> Groq switch.
	test("a blank cloud block validates, and the server fills the kind's defaults", () => {
		const c = baseConfig();
		const { draft: d, providers } = draftFromConfig(c);
		const groq = { ...d, transcription: switchTranscriptionKind(emptyTranscription(), "groq") };
		expect(validateDraft(groq, providers)).toBeNull();
		expect(
			parseConfig({ ...c, ...bodyFromDraft(groq, providers, authDefaults) }).transcription,
		).toEqual({
			kind: "groq",
			model: "whisper-large-v3-turbo",
			auth: "groq",
		});
	});

	test("a save keeps whistle's hand-edited keywords, engine and weights", () => {
		const c = baseConfig();
		c.transcription = {
			kind: "whistle",
			keywords: ["goblin", "bermudi"],
			engine: "/opt/whistle/needle",
			weights: "/opt/whistle/w.bin",
			language: "es",
		};
		const { draft: d, providers } = draftFromConfig(c);
		expect(validateDraft(d, providers)).toBeNull();
		expect(bodyFromDraft(d, providers, authDefaults).transcription).toEqual({
			kind: "whistle",
			keywords: ["goblin", "bermudi"],
			engine: "/opt/whistle/needle",
			weights: "/opt/whistle/w.bin",
			language: "es",
		});
	});

	test("a cloud save sends only the fields the operator filled, defaults left to the server", () => {
		const { draft: d, providers } = draftFromConfig(baseConfig());
		const body = bodyFromDraft(
			{ ...d, transcription: { ...emptyTranscription("openai"), auth: "OPENAI_KEY" } },
			providers,
			authDefaults,
		);
		expect(body.transcription).toEqual({ kind: "openai", auth: "OPENAI_KEY" });
	});

	test("switching kinds clears the identity fields but keeps hand-edit-only whistle config", () => {
		const whistle = {
			...emptyTranscription(),
			keywords: ["goblin"],
			engine: "/opt/needle",
			weights: "base",
		};
		const groq = switchTranscriptionKind(whistle, "groq");
		expect(groq).toMatchObject({
			kind: "groq",
			model: "",
			auth: "",
			// Hand-edit-only: the form cannot restore these, and the body
			// builder never emits them on a cloud arm, so riding along is
			// safe — a whistle → groq → whistle round trip preserves them.
			keywords: ["goblin"],
			engine: "/opt/needle",
			weights: "base",
		});
		const { draft: full, providers } = draftFromConfig(baseConfig());
		expect(
			bodyFromDraft({ ...full, transcription: groq }, providers, authDefaults).transcription,
		).toEqual({ kind: "groq" });
		expect(switchTranscriptionKind(groq, "whistle")).toMatchObject({
			keywords: ["goblin"],
			engine: "/opt/needle",
		});
		const cloud = { ...emptyTranscription("groq"), model: "m", auth: "KEY" };
		expect(switchTranscriptionKind(cloud, "whistle")).toMatchObject({
			kind: "whistle",
			model: "",
			auth: "",
		});
	});

	// A model and secret name belong to one vendor. Carrying them across a
	// cloud-to-cloud switch saved groq's secret name under openai, and the
	// adapter then sent that credential to openai.
	test("switching between cloud vendors clears the old model and secret name", () => {
		const groq = {
			...emptyTranscription("groq"),
			model: "whisper-large-v3-turbo",
			auth: "groq-record",
		};
		const switched = switchTranscriptionKind(groq, "openai");
		expect(switched).toMatchObject({ kind: "openai", model: "", auth: "" });

		const c = baseConfig();
		const { draft: d, providers } = draftFromConfig(c);
		const saved = parseConfig({
			...c,
			...bodyFromDraft({ ...d, transcription: switched }, providers, authDefaults),
		});
		// Blank falls back to openai's own defaults, never groq's record.
		expect(saved.transcription).toEqual({
			kind: "openai",
			model: "gpt-4o-mini-transcribe",
			auth: "openai",
		});
	});

	test("re-selecting the current kind keeps what the operator typed", () => {
		const groq = { ...emptyTranscription("groq"), model: "my-model", auth: "MY_KEY" };
		expect(switchTranscriptionKind(groq, "groq")).toEqual(groq);
	});
});
