import { describe, expect, test } from "bun:test";
import type { Config } from "../../src/config.ts";
import {
	bodyFromDraft,
	displayLevel,
	draftFromConfig,
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
	allowedUsers: [111, 222],
	telegram: { model: "route/auto", thinking: "low", dmGapMinutes: 45 },
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
		c.telegram = { dmGapMinutes: 45 };
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

	test("openai-compatible providers need a base url and a secret name", () => {
		expect(validateDraft(draft(), [prov({ baseUrl: "" })])).toMatch(/base url/);
		expect(validateDraft(draft(), [prov({ auth: " " })])).toMatch(/secret name/);
		// codex needs neither — the CLI's own auth file is the default.
		expect(validateDraft(draft(), [prov({ kind: "codex", baseUrl: "", auth: "" })])).toBeNull();
	});

	test("enabled blocks validate their required fields", () => {
		expect(validateDraft(draft({ tts: { voice: "", rate: "", voices: [] } }), [prov()])).toMatch(
			/voice/,
		);
		expect(validateDraft(draft({ transcription: { model: "", auth: "" } }), [prov()])).toMatch(
			/secret name/,
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

	test("chains need at least one step and required secret names", () => {
		expect(validateDraft(draft({ search: [] }), [prov()])).toMatch(/add at least one/);
		expect(validateDraft(draft({ search: [{ kind: "brave", auth: "" }] }), [prov()])).toMatch(
			/step 1/,
		);
		// ddg needs no key.
		expect(validateDraft(draft({ search: [{ kind: "ddg", auth: "" }] }), [prov()])).toBeNull();
	});

	test("port range, https public url, and non-empty allowed users", () => {
		expect(validateDraft(draft({ port: "abc" }), [prov()])).toMatch(/port/);
		expect(validateDraft(draft({ port: "70000" }), [prov()])).toMatch(/port/);
		expect(validateDraft(draft({ publicUrl: "http://x.test" }), [prov()])).toMatch(/HTTPS/);
		expect(validateDraft(draft({ allowedUsers: [] }), [prov()])).toMatch(/Allowed users/);
	});

	test("both models are required", () => {
		expect(validateDraft(draft({ model: "" }), [prov()])).toMatch(/app default/);
		expect(validateDraft(draft({ telegramModel: "" }), [prov()])).toMatch(/Telegram/);
	});
});

describe("bodyFromDraft", () => {
	test("null blocks serialize as the clearing convention", () => {
		const body = bodyFromDraft(draft(), [prov()]);
		expect(body.tts).toBe("");
		expect(body.transcription).toBe("");
		expect(body.vision).toBe("");
		expect(body.search).toBe("");
		expect(body.fetch).toBe("");
		expect(body.memory).toBe("");
	});

	test("providers map by kind — codex writes authFile, not a secret", () => {
		const body = bodyFromDraft(draft(), [
			prov({ name: "main" }),
			prov({ id: 2, name: "dex", kind: "codex", baseUrl: "", auth: "/home/me/.codex/auth.json" }),
			prov({ id: 3, name: "dex2", kind: "codex", baseUrl: "", auth: "" }),
		]);
		expect(body.providers["main"]).toEqual({
			kind: "openai-compatible",
			baseUrl: "https://api.example.test",
			auth: "KEY",
		});
		expect(body.providers["dex"]).toEqual({ kind: "codex", authFile: "/home/me/.codex/auth.json" });
		expect(body.providers["dex2"]).toEqual({ kind: "codex" });
	});

	test("keyless chain steps drop their auth field", () => {
		const body = bodyFromDraft(
			draft({
				search: [
					{ kind: "brave", auth: "BRAVE_KEY" },
					{ kind: "ddg", auth: "ignored" },
					{ kind: "jina", auth: "" },
				],
			}),
			[prov()],
		);
		expect(body.search).toEqual([
			{ kind: "brave", auth: "BRAVE_KEY" },
			{ kind: "ddg" },
			{ kind: "jina" },
		]);
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
		);
		expect(body.http.port).toBe(9999);
		expect(body.telegram.dmGapMinutes).toBe(30);
		expect(body.telegram.apiRoot).toBeUndefined();
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
		const body = bodyFromDraft(d, providers);
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
