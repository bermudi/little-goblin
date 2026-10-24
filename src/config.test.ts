import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import {
	authReferences,
	type Config,
	ensureHomeLayout,
	fetchEntrySchema,
	fetchKinds,
	loadConfig,
	missingAuthNames,
	parseConfig,
	paths,
	providerKinds,
	providerSchema,
	searchEntrySchema,
	searchKinds,
	splitModelRef,
	transcriptionDefaults,
	transcriptionKinds,
	transcriptionSchema,
	writeConfig,
} from "./config.ts";
import { log, setLogFile } from "./log.ts";
import { useHome } from "./testkit.ts";

// ----- parseConfig (object input): value/throw tables -----

const objBase = {
	providers: { test: { kind: "codex" } },
	model: "test/m",
	operators: [7],
	allowedUsers: [7],
};
const ocBase = {
	providers: {
		test: { kind: "openai-compatible", baseUrl: "https://api.example.org", auth: "ref" },
	},
	model: "test/m",
	operators: [42],
	allowedUsers: [42],
};

const parseValues: [string, unknown, (c: Config) => unknown, unknown][] = [
	[
		"mini-app clearing an absent public URL does not throw or retain an empty URL",
		{ ...objBase, publicUrl: "" },
		(c) => c.publicUrl,
		undefined,
	],
	[
		"the bot API root parses a local URL",
		{ ...objBase, telegram: { dmGapMinutes: 45, apiRoot: "http://127.0.0.1:8081" } },
		(c) => c.telegram.apiRoot,
		"http://127.0.0.1:8081",
	],
	[
		"the bot API root: '' clears to unset",
		{ ...objBase, telegram: { dmGapMinutes: 45, apiRoot: "" } },
		(c) => c.telegram.apiRoot,
		undefined,
	],
	[
		"the mini-app public URL accepts HTTPS",
		{ ...ocBase, publicUrl: "https://example.org" },
		(c) => c.publicUrl,
		"https://example.org",
	],
	["sandbox absent means no sandbox tool", objBase, (c) => c.sandbox, undefined],
	["sandbox '' means no sandbox tool", { ...objBase, sandbox: "" }, (c) => c.sandbox, undefined],
	[
		"sandbox empty block fills the defaults",
		{ ...objBase, sandbox: {} },
		(c) => c.sandbox,
		{ image: "docker.io/library/alpine:latest", idleHours: 24, memory: "2g", cpus: 2, pids: 512 },
	],
	[
		"sandbox explicit values parse",
		{
			...objBase,
			sandbox: { image: "docker.io/library/debian:stable-slim", idleHours: 0, pids: 64 },
		},
		(c) => [c.sandbox?.image, c.sandbox?.idleHours],
		["docker.io/library/debian:stable-slim", 0],
	],
];
for (const [name, input, pick, expected] of parseValues) {
	test(name, () => {
		expect(pick(parseConfig(input))).toEqual(expected);
	});
}

const parseThrows: [string, unknown][] = [
	[
		"the bot API root: a non-URL still fails loud",
		{ ...objBase, telegram: { dmGapMinutes: 45, apiRoot: "127.0.0.1:8081" } },
	],
	[
		"the mini-app public URL must be HTTPS, unlike the local bot API URL",
		{ ...ocBase, publicUrl: "http://example.org" },
	],
];
parseThrows.push(
	["sandbox flag-shaped image refs fail loud", { ...objBase, sandbox: { image: "--privileged" } }],
	["sandbox small pids fail loud", { ...objBase, sandbox: { pids: 4 } }],
	["sandbox negative idleHours fail loud", { ...objBase, sandbox: { idleHours: -1 } }],
);
for (const [name, input] of parseThrows) {
	test(name, () => {
		expect(() => parseConfig(input)).toThrow();
	});
}

test("telegram.enabled absent stays on; false permits an app-only config with no operators", () => {
	expect(parseConfig(objBase).telegram.enabled).toBe(true);
	const off = parseConfig({ ...objBase, operators: [], telegram: { enabled: false } });
	expect(off.telegram.enabled).toBe(false);
	expect(off.operators).toEqual([]);
});

test("telegram.enabled true keeps the one-operator floor", () => {
	expect(() => parseConfig({ ...objBase, operators: [], telegram: { enabled: true } })).toThrow(
		/operators/,
	);
	expect(() => parseConfig({ ...objBase, operators: [] })).toThrow(/operators/);
});

test("a disabled telegram pin keeps a stale provider ref; enabled stays strict", () => {
	const stale = {
		...objBase,
		operators: [],
		telegram: { enabled: false, model: "gone/m", thinking: "high" },
	};
	// Disabled + missing provider → the pin parses through untouched.
	const off = parseConfig(stale);
	expect(off.telegram).toMatchObject({ enabled: false, model: "gone/m", thinking: "high" });
	// A malformed ref is still a syntax error — dormancy is not a parse hole.
	expect(() => parseConfig({ ...stale, telegram: { enabled: false, model: "notaref" } })).toThrow();
	expect(() => parseConfig({ ...stale, telegram: { enabled: false, model: "/m" } })).toThrow();
	// Enabled mode is unchanged: a missing provider rejects.
	expect(() =>
		parseConfig({ ...stale, operators: [7], telegram: { enabled: true, model: "gone/m" } }),
	).toThrow(/telegram: custom/);
	// Restoring the provider re-enables the same pin without edits.
	const restored = parseConfig({
		providers: {
			test: { kind: "codex" },
			gone: { kind: "openai-compatible", baseUrl: "https://api.example.org", auth: "ref" },
		},
		model: "test/m",
		operators: [7],
		allowedUsers: [7],
		telegram: { enabled: true, model: "gone/m", thinking: "high" },
	});
	expect(restored.telegram).toMatchObject({ enabled: true, model: "gone/m" });
	// The exemption is telegram.model only — the live app model and
	// titleModel still demand a real provider while telegram is off.
	expect(() => parseConfig({ ...stale, telegram: { enabled: false }, model: "gone/m" })).toThrow(
		/model: custom/,
	);
	expect(() =>
		parseConfig({ ...stale, telegram: { enabled: false }, titleModel: "gone/m" }),
	).toThrow(/titleModel: custom/);
	// An unpinned disabled block still inherits the app model.
	expect(parseConfig({ ...stale, telegram: { enabled: false } }).telegram.model).toBe("test/m");
});

const valid: Config = {
	providers: {
		zai: { kind: "openai-compatible", baseUrl: "https://api.z.ai/v4", auth: "zai" },
	},
	model: "zai/glm-4.6",
	tts: false,
	favorites: [],
	thinking: "medium",
	operators: [1],
	allowedUsers: [1],
	telegram: { enabled: true, dmGapMinutes: 45, richReplies: true, showReasoning: false },
	http: { port: 8787 },
	logLevel: "info",
};

// ----- goblin.json5 (disk input): shared writer + tables -----

const P_ZAI = `zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}`;
const P_BOTH = `${P_ZAI},openrouter:{kind:"openrouter",auth:"openrouter"}`;
const disk = (providers: string, extra: string) =>
	`{providers:{${providers}},model:"zai/glm-4.6",operators:[7]${extra}}`;

function load(content: string): Config {
	const dir = useHome("goblin-cfg-");
	writeFileSync(join(dir, "goblin.json5"), content);
	return loadConfig()!;
}
const loadExtra = (extra: string, providers = P_ZAI) => load(disk(providers, extra));
const Z = (extra: string) => disk(P_ZAI, extra);
const B = (extra: string) => disk(P_BOTH, extra);

describe("goblin.json5", () => {
	test("ENOENT → null", () => {
		useHome("goblin-cfg-");
		expect(loadConfig()).toBeNull();
	});

	test("valid config loads with defaults applied", () => {
		const c = loadExtra("");
		expect(c.thinking).toBe("medium");
		expect(c.http.port).toBe(8787);
		expect(c.operators).toEqual([7]);
		// TTS is default-on: absent block, default voice.
		expect(c.tts).toEqual({ kind: "edge", voice: "en-US-AriaNeural" });
	});

	test("disk loads warn about retired delegation keys without activating them", () => {
		const dir = useHome("goblin-cfg-");
		const logPath = join(dir, "config.log");
		writeFileSync(
			join(dir, "goblin.json5"),
			`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7],delegation:{machine:{label:"g7",cwd:"/home/daniel/goblin/delegated"},session:"other",maxRunning:3,harnesses:{pi:{kind:"pi"}}}}`,
		);
		setLogFile(logPath);
		try {
			const c = loadConfig()!;
			expect(c.delegation).toEqual({ harnesses: { pi: { kind: "pi" } } });
			const warnings = readFileSync(logPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { level: string; key: string; replacement: string });
			expect(warnings.map((w) => w.key)).toEqual([
				"delegation.machine",
				"delegation.session",
				"delegation.maxRunning",
			]);
			expect(warnings.every((w) => w.level === "warn")).toBe(true);
			expect(warnings[0]?.replacement).toContain("delegation.machines.<label>.machine");
			expect(warnings[1]?.replacement).toContain("delegation.machines.<label>.session");
			expect(warnings[2]?.replacement).toContain("no replacement");
			writeConfig(c);
			loadConfig();
			expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(3);
		} finally {
			setLogFile(null);
		}
	});

	// Per-block tables: [case name, extra fragment, expected].
	const valueRows = (
		block: string,
		providers: string,
		pick: (c: Config) => unknown,
		rows: [string, string, unknown][],
	) => {
		for (const [name, extra, expected] of rows) {
			test(`${block} ${name}`, () => {
				expect(pick(loadExtra(extra, providers))).toEqual(expected);
			});
		}
	};
	const throwRows = (
		block: string,
		providers: string,
		rows: [string, string, (string | undefined)?][],
	) => {
		for (const [name, extra, message] of rows) {
			test(`${block} ${name}`, () => {
				expect(() => loadExtra(extra, providers)).toThrow(message);
			});
		}
	};

	valueRows("titleModel", P_BOTH, (c) => c.titleModel, [
		[
			"parses a provider-validated ref",
			`,titleModel:"openrouter/openrouter/free"`,
			"openrouter/openrouter/free",
		],
		['"" clears to unset', `,titleModel:""`, undefined],
	]);
	throwRows("titleModel", P_BOTH, [
		["is provider-validated like model", `,titleModel:"other/x"`, "titleModel: custom"],
	]);

	valueRows("vision", P_BOTH, (c) => c.vision, [
		["is absent by default", "", undefined],
		[
			"defaults maxTokens and mode",
			`,vision:{model:"openrouter/google/gemini-2.5-flash"}`,
			{ model: "openrouter/google/gemini-2.5-flash", maxTokens: 2000, mode: "auto" },
		],
		[
			"parses explicit maxTokens and mode",
			`,vision:{model:"zai/glm-4.6",maxTokens:512,mode:"always"}`,
			{ model: "zai/glm-4.6", maxTokens: 512, mode: "always" },
		],
		['"" clears to unset', `,vision:""`, undefined],
	]);
	throwRows("vision", P_BOTH, [
		["model is provider-validated", `,vision:{model:"other/x"}`, "vision: custom"],
		["maxTokens must be positive", `,vision:{model:"zai/glm-4.6",maxTokens:0}`],
		["mode is an enum", `,vision:{model:"zai/glm-4.6",mode:"sometimes"}`],
	]);

	valueRows("image", P_BOTH, (c) => c.image, [
		["is absent by default", "", undefined],
		["parses its model", `,image:{model:"zai/flux-2-dev"}`, { model: "zai/flux-2-dev" }],
		[
			"parses an explicit size",
			`,image:{model:"zai/flux-2-dev",size:"1024x768"}`,
			{ model: "zai/flux-2-dev", size: "1024x768" },
		],
		['"" clears to unset', `,image:""`, undefined],
	]);
	throwRows("image", P_BOTH, [
		["model is provider-validated", `,image:{model:"other/x"}`, "image: custom"],
		// The provider must exist AND carry a baseUrl — the images POST needs one.
		["provider must carry a baseUrl", `,image:{model:"openrouter/flux-2-dev"}`, "image: custom"],
		["size is a WxH shape", `,image:{model:"zai/flux-2-dev",size:"big"}`],
	]);

	valueRows("reviewer", P_ZAI, (c) => c.reviewer, [
		["is absent by default", "", undefined],
		[
			"defaults threshold, queueCap and evidence",
			`,reviewer:{auth:"openrouter"}`,
			{
				threshold: 0.8,
				queueCap: 3,
				evidence: { calls: 8, argChars: 300, outChars: 300 },
				auth: "openrouter",
			},
		],
		[
			"parses thresholds, queueCap and evidence overrides",
			`,reviewer:{auth:"openrouter",thresholds:{correction:0.7},queueCap:5,evidence:{calls:12}}`,
			{
				threshold: 0.8,
				thresholds: { correction: 0.7 },
				queueCap: 5,
				evidence: { calls: 12, argChars: 300, outChars: 300 },
				auth: "openrouter",
			},
		],
	]);
	throwRows("reviewer", P_ZAI, [
		["queueCap must be positive", `,reviewer:{auth:"openrouter",queueCap:0}`],
		[
			"model is provider-validated",
			`,reviewer:{auth:"openrouter",model:"other/x"}`,
			"reviewer: custom",
		],
		["auth is required", `,reviewer:{threshold:0.5}`],
	]);

	valueRows("system1", P_ZAI, (c) => c.system1, [
		["is absent by default", "", undefined],
		[
			"parses model and baseUrl as-is",
			`,system1:{auth:"x",model:"jev-latest",baseUrl:"https://example.com"}`,
			{ auth: "x", model: "jev-latest", baseUrl: "https://example.com" },
		],
		// system1.model is a bare decision-model id, NOT a
		// <provider>/<model-id> chat ref — it is NOT provider-validated
		// (unlike reviewer.model).
		[
			"model is not provider-validated",
			`,system1:{auth:"x",model:"other/x"}`,
			{ auth: "x", model: "other/x" },
		],
	]);
	throwRows("system1", P_ZAI, [["auth is required", `,system1:{model:"jev-latest"}`]]);

	valueRows("search", P_ZAI, (c) => c.search, [
		[
			"object form normalizes to a one-entry chain",
			`,search:{kind:"brave",auth:"brave"}`,
			[{ kind: "brave", auth: "brave" }],
		],
		[
			"list form preserves chain order",
			`,search:[{kind:"brave",auth:"brave"},{kind:"ddg"}]`,
			[{ kind: "brave", auth: "brave" }, { kind: "ddg" }],
		],
		['"" clears to unset', `,search:""`, undefined],
		// An omitted step auth defaults at parse (jina stays
		// keyless-blank: no default — see the kinds suites).
		[
			"step auth defaults to the kind's record name",
			`,search:[{kind:"brave"},{kind:"jina"}]`,
			[{ kind: "brave", auth: "brave" }, { kind: "jina" }],
		],
	]);
	throwRows("search", P_ZAI, [["an empty chain is no chain", `,search:[]`]]);

	valueRows("fetch", P_ZAI, (c) => c.fetch, [
		[
			"list form preserves chain order",
			`,fetch:[{kind:"parallel",auth:"parallel"},{kind:"local"}]`,
			[{ kind: "parallel", auth: "parallel" }, { kind: "local" }],
		],
		["object form normalizes to a one-entry chain", `,fetch:{kind:"local"}`, [{ kind: "local" }]],
	]);

	valueRows("tts", P_ZAI, (c) => c.tts, [
		["defaults to edge", "", { kind: "edge", voice: "en-US-AriaNeural" }],
		[
			"edge parses rate",
			`,tts:{kind:"edge",voice:"en-US-AriaNeural",rate:"+10%"}`,
			{ kind: "edge", voice: "en-US-AriaNeural", rate: "+10%" },
		],
		[
			"edge parses the voice list",
			`,tts:{kind:"edge",voice:"en-US-AriaNeural",voices:["es-ES-ElviraNeural","es-MX-JorgeNeural"]}`,
			{
				kind: "edge",
				voice: "en-US-AriaNeural",
				voices: ["es-ES-ElviraNeural", "es-MX-JorgeNeural"],
			},
		],
		['"" is an explicit off', `,tts:""`, false],
		[
			"openrouter defaults model and auth; voice is optional",
			`,tts:{kind:"openrouter"}`,
			{ kind: "openrouter", model: "fish-audio/s2.1-pro-free:free", auth: "openrouter" },
		],
		[
			"openrouter parses explicit model, auth and voice",
			`,tts:{kind:"openrouter",model:"fish-audio/s2.1-pro",auth:"or-tts",voice:"b347db033a6549378b48d00acb0d06cd"}`,
			{
				kind: "openrouter",
				model: "fish-audio/s2.1-pro",
				auth: "or-tts",
				voice: "b347db033a6549378b48d00acb0d06cd",
			},
		],
		// 1min is the one cloud arm whose voice is REQUIRED on the wire —
		// the schema materializes alloy (tts-1's own default) instead of
		// leaving it optional like the /audio/speech kinds.
		[
			"onemin defaults model, auth, and materializes voice alloy",
			`,tts:{kind:"onemin"}`,
			{ kind: "onemin", model: "tts-1", auth: "onemin", voice: "alloy" },
		],
		[
			"onemin parses explicit model, auth and voice",
			`,tts:{kind:"onemin",model:"tts-1-hd",auth:"1min-tts",voice:"nova"}`,
			{ kind: "onemin", model: "tts-1-hd", auth: "1min-tts", voice: "nova" },
		],
	]);
	throwRows("tts", P_ZAI, [
		[
			"voices must be non-empty",
			`,tts:{kind:"edge",voice:"en-US-AriaNeural",voices:[""]}`,
			"goblin.json5",
		],
		["voice must be non-empty", `,tts:{kind:"edge",voice:""}`, "goblin.json5"],
		["openrouter model must be non-empty", `,tts:{kind:"openrouter",model:""}`, "goblin.json5"],
		["openrouter voice must be non-blank", `,tts:{kind:"openrouter",voice:" "}`, "goblin.json5"],
		[
			"onemin voice must be non-blank — it is required on the wire",
			`,tts:{kind:"onemin",voice:" "}`,
			"goblin.json5",
		],
	]);

	valueRows("transcription", P_ZAI, (c) => c.transcription, [
		["is absent by default", "", undefined],
		[
			"defaults its model and auth",
			`,transcription:{kind:"groq"}`,
			{ kind: "groq", model: "whisper-large-v3-turbo", auth: "groq" },
		],
		['"" clears to unset', `,transcription:""`, undefined],
		[
			"parses the pre-union groq block with explicit fields",
			`,transcription:{kind:"groq",model:"whisper-large-v3",auth:"groq"}`,
			{ kind: "groq", model: "whisper-large-v3", auth: "groq" },
		],
		[
			"whistle parses with keywords and its language set",
			`,transcription:{kind:"whistle",keywords:["goblin","bermudi"],language:"es"}`,
			{ kind: "whistle", keywords: ["goblin", "bermudi"], language: "es" },
		],
		// onemin takes the ISO code, qwen3's 3-letter codes, or the
		// locale form the short/long/phone/telephony/medical models
		// REQUIRE.
		[
			"onemin parses the locale form",
			`,transcription:{kind:"onemin",language:"en-US"}`,
			{ kind: "onemin", model: "whisper-1", auth: "onemin", language: "en-US" },
		],
		[
			"onemin parses qwen3's 3-letter codes",
			`,transcription:{kind:"onemin",language:"yue"}`,
			{ kind: "onemin", model: "whisper-1", auth: "onemin", language: "yue" },
		],
	]);
	throwRows("transcription", P_ZAI, [
		// Whistle's language is an enum, not any 2-letter code.
		[
			"whistle language is an enum",
			`,transcription:{kind:"whistle",language:"ja"}`,
			"goblin.json5",
		],
		[
			"onemin rejects a lowercase region",
			`,transcription:{kind:"onemin",language:"en-us"}`,
			"goblin.json5",
		],
		["onemin rejects a non-code", `,transcription:{kind:"onemin",language:"esp"}`, "goblin.json5"],
	]);

	valueRows("memory", P_ZAI, (c) => c.memory, [
		["is absent by default", "", undefined],
		['"" clears to unset', `,memory:""`, undefined],
	]);
	throwRows("memory", P_ZAI, [
		[
			"recallTimeoutMs has a floor",
			`,memory:{baseUrl:"http://127.0.0.1:8888",bankId:"goblin",recallTimeoutMs:99}`,
		],
		[
			"searchTimeoutMs has a floor",
			`,memory:{baseUrl:"http://127.0.0.1:8888",bankId:"goblin",searchTimeoutMs:0}`,
		],
		[
			"searchTimeoutMs has a ceiling",
			`,memory:{baseUrl:"http://127.0.0.1:8888",bankId:"goblin",searchTimeoutMs:120001}`,
		],
		// Remote plain HTTP is rejected — loopback or HTTPS only.
		[
			"baseUrl rejects remote plain HTTP",
			`,memory:{baseUrl:"http://memory.example",bankId:"goblin"}`,
			"goblin.json5",
		],
	]);

	valueRows("mail", P_ZAI, (c) => c.mail, [
		["is absent by default", "", undefined],
		// Reads ride gws's own auth — the block holds only the send
		// credential (plus client id and secret ref).
		[
			"parses all three fields",
			`,mail:{clientId:"x.apps.googleusercontent.com",clientSecretAuth:"gmail-secret",sendAuth:"gmail-send"}`,
			{
				clientId: "x.apps.googleusercontent.com",
				clientSecretAuth: "gmail-secret",
				sendAuth: "gmail-send",
			},
		],
	]);
	throwRows("mail", P_ZAI, [
		// A half-configured block is a boot error, not a silent half.
		["requires all three fields when present", `,mail:{clientId:"x"}`, "goblin.json5"],
	]);

	// Cases whose pick spans fields or whose content is not a BASE
	// fragment stay individual rows: [name, content, pick, expected].
	const singles: [string, string, (c: Config) => unknown, unknown][] = [
		[
			"system1 block alone enables it; reviewer stays off",
			Z(`,system1:{auth:"x"}`),
			(c) => [c.system1, c.reviewer],
			[{ auth: "x" }, undefined],
		],
		[
			"memory fills its recall/search/reflect defaults",
			Z(`,memory:{baseUrl:"http://127.0.0.1:8888",bankId:"goblin"}`),
			(c) => [
				c.memory?.bankId,
				c.memory?.recallTimeoutMs,
				c.memory?.maxTokens,
				c.memory?.budget,
				c.memory?.preferObservations,
				c.memory?.minScores,
				c.memory?.searchMaxTokens,
				c.memory?.searchBudget,
				c.memory?.searchTimeoutMs,
				c.memory?.searchMinScores,
				c.memory?.reflectTimeoutMs,
			],
			["goblin", 5000, 2048, "mid", true, { semantic: 0.3 }, 4096, "high", 30_000, {}, 120_000],
		],
		[
			"delegation.machines parses a saved-machine target",
			Z(
				`,delegation:{machines:{g7:{machine:"g7",root:"~/build"},bench:{session:"bench",harnesses:{devin:{kind:"devin"}}}},harnesses:{pi:{kind:"pi"}}}`,
			),
			(c) => c.delegation?.machines?.["g7"],
			{ machine: "g7", root: "~/build" },
		],
		[
			"delegation.machines parses a local-session target",
			Z(
				`,delegation:{machines:{g7:{machine:"g7",root:"~/build"},bench:{session:"bench",harnesses:{devin:{kind:"devin"}}}},harnesses:{pi:{kind:"pi"}}}`,
			),
			(c) => [
				c.delegation?.machines?.["bench"]?.session,
				c.delegation?.machines?.["bench"]?.harnesses?.["devin"]?.kind,
			],
			["bench", "devin"],
		],
		// Session names ride herdr's session contract, not the harness
		// charset: dots and case are real (goblin.dev, side-session).
		[
			"delegation.machines session names allow dots and case",
			Z(`,delegation:{machines:{dev:{session:"goblin.dev"}},harnesses:{pi:{kind:"pi"}}}`),
			(c) => c.delegation?.machines?.["dev"]?.session,
			"goblin.dev",
		],
	];
	for (const [name, content, pick, expected] of singles) {
		test(name, () => {
			expect(pick(load(content))).toEqual(expected);
		});
	}

	const rawThrows: [string, string, string?][] = [
		[
			"invalid config throws with file path",
			`{providers:{},model:"x",operators:[]}`,
			"goblin.json5",
		],
		["a port outside 0–65535 is rejected", Z(`,http:{port:70000}`), "goblin.json5"],
		[
			"a model naming a missing provider is rejected",
			`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"other/glm-4.6",operators:[7]}`,
			"model: custom",
		],
		[
			"a malformed model ref is rejected",
			`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"glm-4.6",operators:[7]}`,
			"model: custom",
		],
		// A relative root names nothing on a remote host — reject at parse.
		[
			"delegation.machines rejects a relative root",
			Z(
				`,delegation:{machines:{g7:{machine:"g7",root:"relative/path"}},harnesses:{pi:{kind:"pi"}}}`,
			),
			"delegation: invalid_format",
		],
		// `~user` is shell user-expansion the tool does NOT perform —
		// accepting it would stat it under the operator's home while the
		// literal path reaches herdr. Fail loud at this boundary.
		[
			"delegation.machines rejects ~user roots",
			Z(
				`,delegation:{machines:{g7:{machine:"g7",root:"~other/build"}},harnesses:{pi:{kind:"pi"}}}`,
			),
			"delegation: invalid_format",
		],
		// machine + session on one target is a contradiction — herdr's
		// CLI treats --machine and --session as mutually exclusive.
		[
			"delegation.machines rejects machine+session targets",
			Z(`,delegation:{machines:{both:{machine:"g7",session:"goblin"}},harnesses:{pi:{kind:"pi"}}}`),
			"delegation: custom",
		],
	];
	for (const [name, content, message] of rawThrows) {
		test(name, () => {
			expect(() => load(content)).toThrow(message);
		});
	}

	test("search defaults materialize into the saved file — the saved config stays self-describing", () => {
		const defaulted = loadExtra(`,search:[{kind:"brave"},{kind:"jina"}]`);
		writeConfig(defaulted);
		const dir = process.env.GOBLIN_HOME!;
		expect(readFileSync(join(dir, "goblin.json5"), "utf8")).toContain("auth: 'brave'");
	});

	test("writeConfig rewrites the whole file as the canonical parsed object", () => {
		const dir = useHome("goblin-cfg-");
		const p = join(dir, "goblin.json5");
		writeFileSync(
			p,
			`{
  // operator note — comments are not configuration
  providers: { ${P_ZAI} },
  model: "zai/glm-4.6",
  operators: [7],
  thinking: "low",
}
`,
		);
		const cfg = loadConfig()!;
		writeConfig({ ...cfg, thinking: "high" });
		const out = readFileSync(p, "utf8");
		expect(out).toBe(`${JSON5.stringify(parseConfig({ ...cfg, thinking: "high" }), null, 2)}\n`);
		expect(out).not.toContain("operator note");
		expect(loadConfig()!.thinking).toBe("high");
	});

	for (const configured of [false, true]) {
		test(`writeConfig clears optional integrations in the canonical object (configured=${configured})`, () => {
			useHome("goblin-cfg-");
			const original = parseConfig({
				...valid,
				...(configured
					? {
							transcription: { kind: "groq" },
							search: [{ kind: "brave" }],
							fetch: [{ kind: "jina" }],
						}
					: {}),
			});
			writeFileSync(paths.config(), `${JSON5.stringify(original, null, 2)}\n`);
			const cleared = parseConfig({ ...original, transcription: "", search: "", fetch: "" });
			expect(Object.hasOwn(cleared, "transcription")).toBe(true);
			expect(cleared.transcription).toBeUndefined();

			writeConfig(cleared);

			const out = readFileSync(paths.config(), "utf8");
			expect(out).toBe(`${JSON5.stringify(cleared, null, 2)}\n`);
			const loaded = loadConfig()!;
			for (const key of ["transcription", "search", "fetch"] as const) {
				expect(loaded[key]).toBeUndefined();
				expect(out).not.toContain(`${key}:`);
			}
		});
	}

	test("writeConfig initializes a missing file", () => {
		useHome("goblin-cfg-");
		writeConfig(valid);
		expect(loadConfig()).toEqual(parseConfig(valid));
	});

	test("unknown fields are rejected at load and preserved untouched on a refused save", () => {
		const dir = useHome("goblin-cfg-");
		const p = join(dir, "goblin.json5");
		const text = `${JSON.stringify({ ...valid, experimental: { notInSchema: true } }, null, 2)}\n`;
		writeFileSync(p, text);
		expect(() => loadConfig()).toThrow("config: unrecognized_keys");
		expect(() => writeConfig({ ...valid, thinking: "high" })).toThrow("config: unrecognized_keys");
		expect(readFileSync(p, "utf8")).toBe(text);
	});

	test("unknown fields inside a block are rejected too", () => {
		const cases: [string, Record<string, unknown>][] = [
			["telegram", { ...valid.telegram, typo: true }],
			["providers", { zai: { kind: "codex", extra: true } }],
		];
		for (const [name, value] of cases) {
			useHome("goblin-cfg-");
			writeFileSync(paths.config(), JSON.stringify({ ...valid, [name]: value }));
			expect(() => loadConfig()).toThrow(`${name}: unrecognized_keys`);
		}
	});

	test("writeConfig refuses to reset a schema-invalid existing file", () => {
		useHome("goblin-cfg-");
		const text = `${JSON.stringify({ model: "zai/glm-4.6" }, null, 2)}\n`;
		writeFileSync(paths.config(), text);
		expect(() => writeConfig(valid)).toThrow(`${paths.config()}: invalid config`);
		expect(readFileSync(paths.config(), "utf8")).toBe(text);
	});

	test("writeConfig leaves malformed JSON5 intact", () => {
		useHome("goblin-cfg-");
		const text = '// keep this comment\n{model: "unterminated}';
		writeFileSync(paths.config(), text);
		expect(() => writeConfig(valid)).toThrow(`${paths.config()}:2: invalid JSON5`);
		expect(readFileSync(paths.config(), "utf8")).toBe(text);
	});

	test.skipIf(process.getuid?.() === 0)(
		"writeConfig propagates EACCES and leaves the file intact",
		() => {
			useHome("goblin-cfg-");
			const p = paths.config();
			const text = `${JSON.stringify(valid)}\n`;
			writeFileSync(p, text);
			chmodSync(p, 0o000);
			try {
				expect(() => readFileSync(p, "utf8")).toThrow(expect.objectContaining({ code: "EACCES" }));
				expect(() => writeConfig({ ...valid, thinking: "high" })).toThrow(
					expect.objectContaining({ code: "EACCES" }),
				);
			} finally {
				chmodSync(p, 0o600);
			}
			expect(readFileSync(p, "utf8")).toBe(text);
		},
	);

	test("writeConfig preserves a hardened file mode", () => {
		const dir = useHome("goblin-cfg-");
		const p = join(dir, "goblin.json5");
		writeFileSync(p, JSON.stringify(valid));
		chmodSync(p, 0o600);
		writeConfig({ ...valid, thinking: "high" });
		expect(statSync(p).mode & 0o777).toBe(0o600);
		// and it round-trips — including the explicit tts off
		expect(loadConfig()!.model).toBe("zai/glm-4.6");
		expect(loadConfig()!.tts).toBe(false);
		expect(loadConfig()!.thinking).toBe("high");
	});

	test("subagents: absent block is off; block applies the design defaults", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base}}`);
		expect(loadConfig()!.subagents).toBeUndefined();
		const model = `{auth:"zai",id:"glm-5.3-flash",baseUrl:"https://api.z.ai/api/coding/paas/v4",api:"openai-completions",thinking:"low"}`;
		writeFileSync(join(dir, "goblin.json5"), `${base},subagents:{computer:{model:${model}}}}`);
		const sub = loadConfig()!.subagents!;
		expect(sub.maxRuns).toBe(3);
		expect(sub.worker).toBeUndefined();
		expect(sub.computer!.model.id).toBe("glm-5.3-flash");
		expect(sub.desktops).toEqual({
			image: "localhost/goblin-desktop:1",
			max: 3,
			idleHours: 24,
			memory: "3g",
			cpus: 2,
			pids: 1024,
		});
		// A wrong transport is a boot error — pi-ai speaks only
		// openai-completions here.
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},subagents:{computer:{model:${model.replace(`"openai-completions"`, `"responses"`)}}}}`,
		);
		expect(() => loadConfig()).toThrow("goblin.json5");
	});
});

describe("ensureHomeLayout", () => {
	test("first-boot directory names are synced before state and attachments are used", () => {
		const dir = useHome("goblin-cfg-");
		const opened = new Map<number, string>();
		const synced: string[] = [];
		const realOpen = fs.openSync;
		const realSync = fs.fsyncSync;
		const openSpy = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
			const fd = realOpen(path, flags, mode);
			opened.set(fd, String(path));
			return fd;
		});
		const syncSpy = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			const path = opened.get(fd);
			if (path) synced.push(path);
			realSync(fd);
		});
		try {
			ensureHomeLayout();
			expect(synced).toContain(dir); // workspace/ and state/ entries
			expect(synced).toContain(join(dir, "workspace")); // attachments/ entry
		} finally {
			syncSpy.mockRestore();
			openSpy.mockRestore();
		}
	});

	test("a file masquerading as a required directory fails boot", () => {
		const dir = useHome("goblin-cfg-");
		writeFileSync(join(dir, "state"), "not a directory");
		expect(() => ensureHomeLayout()).toThrow("layout directory is not a directory");
	});

	test("first boot creates the reviewer's proposals directory", () => {
		const dir = useHome("goblin-cfg-");
		ensureHomeLayout();
		expect(statSync(join(dir, "workspace", "skills-proposed")).isDirectory()).toBe(true);
	});

	test("first boot seeds SOUL.md and the AGENTS.md stub", () => {
		const dir = useHome("goblin-cfg-");
		ensureHomeLayout();
		const soul = readFileSync(join(dir, "workspace", "SOUL.md"), "utf8");
		expect(soul).toContain("You are goblin");
		const agents = readFileSync(join(dir, "workspace", "AGENTS.md"), "utf8");
		expect(agents).toContain("Your operating notes");
		// The growth rule must be inside the file — that's the mechanism.
		expect(agents).toContain("Write things down");
		const user = readFileSync(join(dir, "workspace", "USER.md"), "utf8");
		expect(user).toContain("Your model of the operator");
		expect(user).toContain("status: active");
		expect(statSync(join(dir, "workspace", "AGENTS.md")).mode & 0o777).toBe(0o644);
	});

	test("first boot seeds the browser skill — capability plumbing survives a rebuild", () => {
		const dir = useHome("goblin-cfg-");
		ensureHomeLayout();
		const skill = readFileSync(join(dir, "workspace", "skills", "browser", "SKILL.md"), "utf8");
		// The compatibility line is what the system prompt's catalog
		// renders — the recovery command must ride it, so a missing CLI
		// is never a dead-end invitation.
		expect(skill).toContain(
			"compatibility: Requires the agent-browser CLI and a Chrome/Chromium binary",
		);
		expect(skill).toContain("npm i -g agent-browser && agent-browser install");
		// Frontmatter name must match the directory or the catalog skips it.
		expect(skill).toContain("name: browser");
		// The pass-cli skill seeds the same way — its compatibility line
		// names the dependency (goblin's own agent token), which the
		// catalog renders every turn.
		const passCli = readFileSync(join(dir, "workspace", "skills", "pass-cli", "SKILL.md"), "utf8");
		expect(passCli).toContain("name: pass-cli");
		expect(passCli).toContain("compatibility:");
		// The herdr skill seeds the same way: a rebuilt box must regain
		// the pane-targeting contract — operator-pointed panes go through
		// the `herdr` tool, never the raw CLI.
		const herdr = readFileSync(join(dir, "workspace", "skills", "herdr", "SKILL.md"), "utf8");
		expect(herdr).toContain("name: herdr");
		expect(herdr).toContain("the `herdr` tool, never the CLI from bash");
	});

	test("existing identity files are never clobbered", () => {
		const dir = useHome("goblin-cfg-");
		mkdirSync(join(dir, "workspace"), { recursive: true });
		writeFileSync(join(dir, "workspace", "AGENTS.md"), "my notes");
		writeFileSync(join(dir, "workspace", "USER.md"), "my user model");
		ensureHomeLayout();
		expect(readFileSync(join(dir, "workspace", "AGENTS.md"), "utf8")).toBe("my notes");
		expect(readFileSync(join(dir, "workspace", "USER.md"), "utf8")).toBe("my user model");
	});

	test("an evolved browser skill is never clobbered by the seed", () => {
		const dir = useHome("goblin-cfg-");
		mkdirSync(join(dir, "workspace", "skills", "browser"), { recursive: true });
		writeFileSync(join(dir, "workspace", "skills", "browser", "SKILL.md"), "my evolution");
		ensureHomeLayout();
		expect(readFileSync(join(dir, "workspace", "skills", "browser", "SKILL.md"), "utf8")).toBe(
			"my evolution",
		);
	});

	test("first boot seeds the mcp skill and an empty, import-free mcporter.json", () => {
		const dir = useHome("goblin-cfg-");
		ensureHomeLayout();
		const skill = readFileSync(join(dir, "workspace", "skills", "mcp", "SKILL.md"), "utf8");
		expect(skill).toContain("name: mcp");
		expect(skill).toContain("compatibility:");
		// The seed is the isolation default: no servers, and imports []
		// so mcporter never merges the operator's editor setups.
		const mcporter = readFileSync(join(dir, "mcporter.json"), "utf8");
		expect(mcporter).toContain('"mcpServers": {}');
		expect(mcporter).toContain('"imports": []');
		// The gws skill seeds the same way — the Workspace capability
		// (mail reads through the goblin-mail wrapper, drive/calendar/
		// sheets discovery) survives a rebuild without operator memory.
		const gws = readFileSync(join(dir, "workspace", "skills", "gws", "SKILL.md"), "utf8");
		expect(gws).toContain("name: gws");
		expect(gws).toContain("compatibility:");
		expect(gws).toContain("goblin-mail");
	});

	test("an operator's mcporter.json is never clobbered by the seed", () => {
		const dir = useHome("goblin-cfg-");
		writeFileSync(join(dir, "mcporter.json"), '{"mcpServers": {"x": {}}, "imports": []}');
		ensureHomeLayout();
		expect(readFileSync(join(dir, "mcporter.json"), "utf8")).toContain('"x"');
	});

	test("first boot links the mcp shim at the home root, and a repo move heals it", () => {
		const dir = useHome("goblin-cfg-");
		ensureHomeLayout();
		const shim = join(dir, "mcp");
		expect(lstatSync(shim).isSymbolicLink()).toBe(true);
		expect(readlinkSync(shim)).toBe(join(import.meta.dir, "..", "scripts", "mcp"));
		// A stale link (repo moved) repoints on the next boot.
		rmSync(shim);
		symlinkSync(join("somewhere-else", "mcp"), shim);
		ensureHomeLayout();
		expect(readlinkSync(shim)).toBe(join(import.meta.dir, "..", "scripts", "mcp"));
		// The goblin-mail entry point links the same way — the
		// sanctioned mail-read path stays reachable as
		// $GOBLIN_HOME/goblin-mail from the workspace.
		const mailShim = join(dir, "goblin-mail");
		expect(lstatSync(mailShim).isSymbolicLink()).toBe(true);
		expect(readlinkSync(mailShim)).toBe(join(import.meta.dir, "..", "scripts", "goblin-mail"));
		const doctorShim = paths.doctorShim();
		expect(lstatSync(doctorShim).isSymbolicLink()).toBe(true);
		expect(readlinkSync(doctorShim)).toBe(join(import.meta.dir, "..", "scripts", "doctor"));
		rmSync(doctorShim);
		symlinkSync(join("somewhere-else", "doctor"), doctorShim);
		ensureHomeLayout();
		expect(readlinkSync(doctorShim)).toBe(join(import.meta.dir, "..", "scripts", "doctor"));
		rmSync(mailShim);
		symlinkSync(join("somewhere-else", "goblin-mail"), mailShim);
		ensureHomeLayout();
		expect(readlinkSync(mailShim)).toBe(join(import.meta.dir, "..", "scripts", "goblin-mail"));
	});

	test("a real file at the shim path is never clobbered", () => {
		const dir = useHome("goblin-cfg-");
		writeFileSync(join(dir, "mcp"), "operator's own");
		writeFileSync(join(dir, "goblin-mail"), "operator's own mail");
		writeFileSync(join(dir, "doctor"), "operator's own doctor");
		ensureHomeLayout();
		expect(lstatSync(join(dir, "mcp")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(dir, "mcp"), "utf8")).toBe("operator's own");
		expect(lstatSync(join(dir, "goblin-mail")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(dir, "goblin-mail"), "utf8")).toBe("operator's own mail");
		expect(lstatSync(paths.doctorShim()).isSymbolicLink()).toBe(false);
		expect(readFileSync(paths.doctorShim(), "utf8")).toBe("operator's own doctor");
	});
});

describe("providerKinds", () => {
	// The kinds array must agree with the zod union in BOTH directions:
	// a kind in the schema but not the array → the mini app can't render
	// or save a hand-edited config using it; a kind in the array but not
	// the schema → the form offers what the config rejects.
	test("every kind parses with its required fields; an unknown kind is rejected", () => {
		const fields: Record<string, Record<string, unknown>> = {
			"openai-compatible": { baseUrl: "https://api.example.com", auth: "a" },
			responses: { baseUrl: "https://api.example.com/v1", auth: "a" },
			openrouter: { auth: "a" },
			codex: {},
		};
		for (const kind of providerKinds) {
			expect(providerSchema.safeParse({ kind, ...fields[kind] }).success).toBe(true);
		}
		expect(providerSchema.safeParse({ kind: "anthropic" }).success).toBe(false);
		// openrouter defaults its own record name when auth is omitted;
		// the openai-compatible/responses arms stay required — their kind
		// is a protocol, not a vendor, so no record name can be derived.
		expect(providerSchema.parse({ kind: "openrouter" })).toEqual({
			kind: "openrouter",
			auth: "openrouter",
		});
		expect(
			providerSchema.safeParse({ kind: "openai-compatible", baseUrl: "https://a.test" }).success,
		).toBe(false);
	});

	// The other direction: a literal the schema accepts but the array
	// omits renders a blank type selector in the mini app (kind.value ""
	// hides the base-url row) and a dropdown touch silently rewrites the
	// kind on save — the exact failure a hand-edited `responses` block hit
	// before this direction was pinned.
	test("every schema literal is offered — array and union agree both ways", () => {
		const schemaKinds = providerSchema.options.map((o) => o.shape.kind.value);
		expect(new Set(schemaKinds)).toEqual(new Set(providerKinds));
	});
});

describe("searchKinds", () => {
	// Same two-direction contract as providerKinds, for the mini app's
	// search chain builder. Keyless kinds parse with no auth field.
	test("every kind parses with its required fields; an unknown kind is rejected", () => {
		const fields: Record<string, Record<string, unknown>> = {
			brave: { auth: "a" },
			exa: { auth: "a" },
			jina: {},
			tavily: { auth: "a" },
			firecrawl: { auth: "a" },
			parallel: { auth: "a" },
			ddg: {},
		};
		for (const kind of searchKinds) {
			expect(searchEntrySchema.safeParse({ kind, ...fields[kind] }).success).toBe(true);
		}
		expect(searchEntrySchema.safeParse({ kind: "bing" }).success).toBe(false);
		// Keyed kinds default their own record name when auth is omitted;
		// the config materializes it on the next save.
		for (const kind of ["brave", "exa", "tavily", "firecrawl", "parallel"] as const) {
			expect(searchEntrySchema.parse({ kind })).toEqual({ kind, auth: kind });
		}
		// jina is the exception: it works keyless, so blank must stay
		// keyless — no default may turn "no key" into a "jina" record.
		expect(searchEntrySchema.parse({ kind: "jina" })).toEqual({ kind: "jina" });
		// An explicitly empty name is still a typo, not a default.
		expect(searchEntrySchema.safeParse({ kind: "brave", auth: "" }).success).toBe(false);
	});
});

describe("fetchKinds", () => {
	test("every kind parses with its required fields; an unknown kind is rejected", () => {
		const fields: Record<string, Record<string, unknown>> = {
			local: {},
			jina: {},
			tavily: { auth: "a" },
			firecrawl: { auth: "a" },
			parallel: { auth: "a" },
		};
		for (const kind of fetchKinds) {
			expect(fetchEntrySchema.safeParse({ kind, ...fields[kind] }).success).toBe(true);
		}
		expect(fetchEntrySchema.safeParse({ kind: "diffbot" }).success).toBe(false);
		// Keyed kinds default their own record name when auth is omitted;
		// jina stays keyless-blank (see searchKinds above).
		for (const kind of ["tavily", "firecrawl", "parallel"] as const) {
			expect(fetchEntrySchema.parse({ kind })).toEqual({ kind, auth: kind });
		}
		expect(fetchEntrySchema.parse({ kind: "jina" })).toEqual({ kind: "jina" });
	});
});

describe("splitModelRef", () => {
	test("splits on first slash only", () => {
		expect(splitModelRef("openrouter/anthropic/claude-sonnet-4.5")).toEqual({
			provider: "openrouter",
			modelId: "anthropic/claude-sonnet-4.5",
		});
	});
	test("rejects refs without a provider", () => {
		expect(() => splitModelRef("glm-4.6")).toThrow();
	});
});

describe("authReferences", () => {
	test("telegram is implicit; provider/feature auth names join; credential-free features do not", () => {
		const c = parseConfig({
			providers: {
				zai: { kind: "openai-compatible", baseUrl: "https://fixture.invalid", auth: "zai" },
				codex: { kind: "codex" },
			},
			model: "zai/glm-4.6",
			operators: [7],
			allowedUsers: [7],
			search: [{ kind: "brave", auth: "brave-key" }],
			tts: { kind: "openrouter", auth: "or-tts" },
			appToken: "app-token-record",
			subagents: {
				worker: {
					model: {
						auth: "zai",
						id: "glm-5.3",
						baseUrl: "https://fixture.invalid",
						api: "openai-completions",
						thinking: "high",
					},
				},
				computer: {
					model: {
						auth: "zai-flash",
						id: "glm-5.3-flash",
						baseUrl: "https://fixture.invalid",
						api: "openai-completions",
						thinking: "low",
					},
				},
			},
		});
		expect([...authReferences(c)].sort()).toEqual([
			"app-token-record",
			"brave-key",
			"or-tts",
			"telegram",
			"zai",
			"zai-flash",
		]);
	});

	test("edge tts contributes no auth ref", () => {
		const c = parseConfig({
			providers: {
				zai: { kind: "openai-compatible", baseUrl: "https://fixture.invalid", auth: "zai" },
			},
			model: "zai/glm-4.6",
			operators: [7],
			allowedUsers: [7],
			tts: { kind: "edge", voice: "en-US-AriaNeural" },
		});
		expect([...authReferences(c)].sort()).toEqual(["telegram", "zai"]);
	});

	test("transcription fallback auth names join the sweep", () => {
		const c = parseConfig({
			providers: {
				zai: { kind: "openai-compatible", baseUrl: "https://fixture.invalid", auth: "zai" },
			},
			model: "zai/glm-4.6",
			operators: [7],
			allowedUsers: [7],
			transcription: {
				kind: "groq",
				fallbacks: [{ kind: "openrouter", auth: "or-asr" }, { kind: "whistle" }],
			},
		});
		// Primary default "groq", the fallback's explicit "or-asr"; a
		// keyless whistle entry adds nothing.
		expect([...authReferences(c)].sort()).toEqual(["groq", "or-asr", "telegram", "zai"]);
	});

	test("telegram auth leaves the sweep when the channel is disabled", () => {
		const c = parseConfig({
			providers: {
				zai: { kind: "openai-compatible", baseUrl: "https://fixture.invalid", auth: "zai" },
			},
			model: "zai/glm-4.6",
			operators: [],
			telegram: { enabled: false },
		});
		expect([...authReferences(c)].sort()).toEqual(["zai"]);
		expect(missingAuthNames(c, () => false)).toEqual(["zai"]);
	});

	test("missingAuthNames names the absent records, sorted — boot's warn sweep", () => {
		const c = parseConfig({
			providers: {
				zai: { kind: "openai-compatible", baseUrl: "https://fixture.invalid", auth: "zai" },
			},
			model: "zai/glm-4.6",
			operators: [7],
			allowedUsers: [7],
			transcription: { kind: "mimo", auth: "mimo" },
		});
		// telegram + zai recorded, mimo not — the sweep reports just it.
		const has = (n: string) => n === "telegram" || n === "zai";
		expect(missingAuthNames(c, has)).toEqual(["mimo"]);
		expect(missingAuthNames(c, () => true)).toEqual([]);
	});
});

test("legacy Telegram selection pins independently from app-default patches and survives saves", () => {
	useHome("goblin-cfg-");
	const legacy = parseConfig({
		providers: { test: { kind: "codex" } },
		model: "test/old",
		thinking: "high",
		operators: [7],
		allowedUsers: [7],
	});
	expect(legacy.telegram.model).toBe("test/old");
	expect(legacy.telegram.thinking).toBe("high");
	const changed = parseConfig({ ...legacy, model: "test/new", thinking: "low" });
	writeConfig(changed);
	expect(loadConfig()!.telegram).toMatchObject({ model: "test/old", thinking: "high" });
	expect(loadConfig()!.model).toBe("test/new");
	expect(() => parseConfig({ ...changed, telegram: { model: "missing/x" } })).toThrow(
		"telegram: custom",
	);
	expect(() => parseConfig({ ...changed, telegram: { model: "bare" } })).toThrow(
		"telegram: custom",
	);
	expect(() => parseConfig({ ...changed, telegram: { thinking: "invalid" } })).toThrow();
});

describe("transcriptionKinds", () => {
	// Same two-direction contract as providerKinds, for the mini app's
	// Voice card: schema-only kind → the selector can't offer it;
	// array-only kind → the form offers what the config rejects.
	test("every kind parses bare; an unknown kind is rejected", () => {
		for (const kind of transcriptionKinds) {
			const parsed = transcriptionSchema.safeParse({ kind });
			expect(parsed.success).toBe(true);
			if (parsed.success && parsed.data.kind !== "whistle") {
				expect(parsed.data.model).toBe(transcriptionDefaults[parsed.data.kind].model);
				expect(parsed.data.auth).toBe(transcriptionDefaults[parsed.data.kind].auth);
			}
		}
		expect(transcriptionSchema.safeParse({ kind: "whispercpp" }).success).toBe(false);
	});

	test("every schema literal is offered — array and union agree both ways", () => {
		const schemaKinds = transcriptionSchema.options.map((o) => o.shape.kind.value);
		expect(new Set(schemaKinds)).toEqual(new Set(transcriptionKinds));
	});

	test("cloud language passthrough validates as ISO-639-1", () => {
		expect(transcriptionSchema.safeParse({ kind: "groq", language: "es" }).success).toBe(true);
		expect(transcriptionSchema.safeParse({ kind: "groq", language: "esp" }).success).toBe(false);
		expect(transcriptionSchema.safeParse({ kind: "groq", language: "ES" }).success).toBe(false);
	});

	test("mimo's language is the closed asr_options vocabulary", () => {
		expect(transcriptionSchema.safeParse({ kind: "mimo", language: "en" }).success).toBe(true);
		expect(transcriptionSchema.safeParse({ kind: "mimo", language: "zh" }).success).toBe(true);
		expect(transcriptionSchema.safeParse({ kind: "mimo", language: "auto" }).success).toBe(true);
		expect(transcriptionSchema.safeParse({ kind: "mimo", language: "es" }).success).toBe(false);
	});

	test("whistle keywords cap at 100 non-empty entries", () => {
		expect(
			transcriptionSchema.safeParse({ kind: "whistle", keywords: Array(101).fill("x") }).success,
		).toBe(false);
		expect(transcriptionSchema.safeParse({ kind: "whistle", keywords: [""] }).success).toBe(false);
		expect(
			transcriptionSchema.safeParse({ kind: "whistle", keywords: Array(100).fill("x") }).success,
		).toBe(true);
	});

	test("fallbacks are ordered chain entries with kind-scoped validation", () => {
		const parsed = transcriptionSchema.parse({
			kind: "groq",
			fallbacks: [{ kind: "openrouter" }, { kind: "whistle", keywords: ["goblin"] }],
		});
		expect(parsed.fallbacks).toHaveLength(2);
		expect(parsed.fallbacks?.[0]).toMatchObject({
			kind: "openrouter",
			model: transcriptionDefaults.openrouter.model,
			auth: transcriptionDefaults.openrouter.auth,
		});
		expect(parsed.fallbacks?.[1]).toMatchObject({ kind: "whistle" });
	});

	test("a fallback entry's own kind rules still apply — no free-for-all", () => {
		expect(
			transcriptionSchema.safeParse({ kind: "groq", fallbacks: [{ kind: "bogus" }] }).success,
		).toBe(false);
		expect(
			transcriptionSchema.safeParse({ kind: "groq", fallbacks: [{ model: "x" }] }).success,
		).toBe(false);
		expect(
			transcriptionSchema.safeParse({
				kind: "groq",
				fallbacks: [{ kind: "mimo", language: "es" }],
			}).success,
		).toBe(false);
	});

	test("chains are depth-one and bounded — no nesting, max four links", () => {
		expect(() =>
			transcriptionSchema.parse({
				kind: "groq",
				fallbacks: [{ kind: "whistle", fallbacks: [{ kind: "groq" }] }],
			}),
		).toThrow();
		const five = Array.from({ length: 5 }, () => ({ kind: "whistle" }));
		expect(transcriptionSchema.safeParse({ kind: "groq", fallbacks: five }).success).toBe(false);
		expect(
			transcriptionSchema.safeParse({ kind: "groq", fallbacks: five.slice(0, 4) }).success,
		).toBe(true);
	});
});

const sentinel = "SYNTHETIC_CONFIG_INPUT_DO_NOT_ECHO";
const invalidInputs: unknown[] = [
	{ ...valid, model: sentinel },
	{ ...valid, model: `${sentinel}/model` },
	{ ...valid, providers: { [sentinel]: { kind: sentinel, auth: sentinel } } },
	{ ...valid, thinking: sentinel },
	{ ...valid, publicUrl: `http://${sentinel}:credential@example.org` },
	{ ...valid, delegation: { machines: { [sentinel]: { root: sentinel } } } },
	{ ...valid, telegram: { model: sentinel } },
	[sentinel],
];

function safeFailure(fn: () => unknown): Error {
	let failure: unknown;
	try {
		fn();
	} catch (err) {
		failure = err;
	}
	expect(failure).toBeInstanceOf(Error);
	const err = failure as Error;
	expect(err.message).not.toContain(sentinel);
	expect(err.stack).not.toContain(sentinel);
	expect(err).not.toHaveProperty("cause");
	expect(err).not.toHaveProperty("issues");
	expect(JSON.stringify(err)).not.toContain(sentinel);
	return err;
}

describe("config parser safety", () => {
	test.each(invalidInputs)("schema input never survives in the thrown error (%#)", (raw) => {
		expect(safeFailure(() => parseConfig(raw)).message).toContain("invalid config");
	});

	test("malformed model references do not survive in standalone split errors", () => {
		safeFailure(() => splitModelRef(sentinel));
	});

	const invalidFiles = [
		`{\nmodel: ${sentinel}\n}`,
		`{\n"model": "${sentinel}",\n`,
		...invalidInputs.map((raw) => JSON.stringify(raw)),
	];
	test.each(invalidFiles)(
		"disk parser and helper CLI stderr omit synthetic input (%#)",
		async (raw) => {
			const dir = useHome("goblin-cfg-");
			writeFileSync(join(dir, "goblin.json5"), raw);
			safeFailure(() => loadConfig());
			// An inert helper exercises Bun's uncaught-error renderer without boot.
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`import { loadConfig } from ${JSON.stringify(join(import.meta.dir, "config.ts"))}; loadConfig();`,
				],
				{ env: { ...process.env, GOBLIN_HOME: dir }, stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code).not.toBe(0);
			expect(stdout).toBe("");
			expect(stderr).toContain("goblin.json5");
			expect(stderr).not.toContain(sentinel);
		},
	);

	test("JSON5 syntax errors retain only a safe numeric line", () => {
		const dir = useHome("goblin-cfg-");
		writeFileSync(join(dir, "goblin.json5"), `{\nmodel: ${sentinel}\n}`);
		expect(safeFailure(() => loadConfig()).message).toBe(
			`${join(dir, "goblin.json5")}:2: invalid JSON5`,
		);
	});

	test("write errors and their logs omit malformed file input without replacing it", () => {
		const dir = useHome("goblin-cfg-");
		const text = `{\nmodel: ${sentinel}\n}`;
		writeFileSync(paths.config(), text);
		const err = safeFailure(() => writeConfig(valid));
		expect(err.message).toBe(`${paths.config()}:2: invalid JSON5`);
		const logPath = join(dir, "config.log");
		setLogFile(logPath);
		try {
			log.error("fixture config write failed", err);
		} finally {
			setLogFile(null);
		}
		expect(readFileSync(logPath, "utf8")).not.toContain(sentinel);
		expect(readFileSync(paths.config(), "utf8")).toBe(text);
	});
});

describe("parked capability blocks", () => {
	const base = () => ({
		providers: { zai: { kind: "openrouter" } },
		model: "zai/m",
		operators: [],
		telegram: { enabled: false },
	});

	test("an empty parked object is dropped on parse and write", () => {
		const home = useHome("goblin-cfg-");
		const parsed = parseConfig({ ...base(), parked: {} });
		expect("parked" in parsed).toBe(false);
		writeConfig(parseConfig({ ...base(), parked: {} }));
		expect(readFileSync(paths.config(), "utf8")).not.toContain("parked");
		expect(home).toContain("goblin-cfg-");
	});

	test("parked blocks keep their own schema; authReferences never sees them", () => {
		const parsed = parseConfig({
			...base(),
			parked: {
				reviewer: { auth: "parked-secret-name" },
				vision: { model: "zai/m", maxTokens: 999 },
			},
		});
		expect(parsed.parked?.reviewer?.auth).toBe("parked-secret-name");
		expect(parsed.parked?.vision?.maxTokens).toBe(999);
		expect(authReferences(parsed).has("parked-secret-name")).toBe(false);
	});

	test("parked fields that fail their own schema are rejected", () => {
		expect(
			safeFailure(() => parseConfig({ ...base(), parked: { memory: { bankId: "x" } } })).message,
		).toContain("invalid config");
	});
});
