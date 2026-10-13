import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	authReferences,
	type Config,
	ensureHomeLayout,
	fetchEntrySchema,
	fetchKinds,
	loadConfig,
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
import { setLogFile } from "./log.ts";

test("mini-app clearing an absent public URL does not throw or retain an empty URL", () => {
	expect(
		parseConfig({
			providers: { test: { kind: "codex" } },
			model: "test/m",
			operators: [7],
			allowedUsers: [7],
			publicUrl: "",
		}).publicUrl,
	).toBeUndefined();
});

// The same convention as publicUrl: "" is the form's explicit clear. The
// JSON body can't carry `undefined`, so an absent key would mean "keep".
test("the bot API root: '' clears to unset, and a non-URL still fails loud", () => {
	const config = {
		providers: { test: { kind: "codex" } },
		model: "test/m",
		operators: [7],
		allowedUsers: [7],
	};
	const withRoot = (apiRoot: string) => ({
		...config,
		telegram: { dmGapMinutes: 45, apiRoot },
	});
	expect(parseConfig(withRoot("http://127.0.0.1:8081")).telegram.apiRoot).toBe(
		"http://127.0.0.1:8081",
	);
	expect(parseConfig(withRoot("")).telegram.apiRoot).toBeUndefined();
	expect(() => parseConfig(withRoot("127.0.0.1:8081"))).toThrow();
});

test("the mini-app public URL must be HTTPS, unlike the local bot API URL", () => {
	const config = {
		providers: {
			test: { kind: "openai-compatible", baseUrl: "https://api.example.org", auth: "ref" },
		},
		model: "test/m",
		operators: [42],
		allowedUsers: [42],
	};
	expect(() => parseConfig({ ...config, publicUrl: "http://example.org" })).toThrow();
	expect(parseConfig({ ...config, publicUrl: "https://example.org" }).publicUrl).toBe(
		"https://example.org",
	);
});

let dirs: string[] = [];
let prevHome: string | undefined;

function useHome(): string {
	prevHome = process.env.GOBLIN_HOME;
	const dir = mkdtempSync(join(tmpdir(), "goblin-cfg-"));
	dirs.push(dir);
	process.env.GOBLIN_HOME = dir;
	return dir;
}

afterEach(() => {
	if (prevHome === undefined) delete process.env.GOBLIN_HOME;
	else process.env.GOBLIN_HOME = prevHome;
	prevHome = undefined;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
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
	telegram: { dmGapMinutes: 45, richReplies: true, showReasoning: false },
	http: { port: 8787 },
	logLevel: "info",
};

describe("goblin.json5", () => {
	test("ENOENT → null", () => {
		useHome();
		expect(loadConfig()).toBeNull();
	});

	test("valid config loads with defaults applied", () => {
		const dir = useHome();
		writeFileSync(
			join(dir, "goblin.json5"),
			`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7]}`,
		);
		const c = loadConfig()!;
		expect(c.thinking).toBe("medium");
		expect(c.http.port).toBe(8787);
		expect(c.operators).toEqual([7]);
		// TTS is default-on: absent block, default voice.
		expect(c.tts).toEqual({ kind: "edge", voice: "en-US-AriaNeural" });
	});

	test("disk loads warn about retired delegation keys without activating them", () => {
		const dir = useHome();
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

	test("delegation.machines parses saved-machine and local-session targets; bad roots and both-kind targets are rejected", () => {
		const dir = useHome();
		const cfg = (machines: unknown) =>
			`{machines:${JSON.stringify(machines)},harnesses:{pi:{kind:"pi"}}}`;
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7],delegation:`;
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base}${cfg({ g7: { machine: "g7", root: "~/build" }, bench: { session: "bench", harnesses: { devin: { kind: "devin" } } } })}}`,
		);
		const c = loadConfig()!;
		expect(c.delegation?.machines?.["g7"]).toEqual({ machine: "g7", root: "~/build" });
		expect(c.delegation?.machines?.["bench"]?.session).toBe("bench");
		expect(c.delegation?.machines?.["bench"]?.harnesses?.["devin"]?.kind).toBe("devin");
		// A relative root names nothing on a remote host — reject at parse.
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base}${cfg({ g7: { machine: "g7", root: "relative/path" } })}}`,
		);
		expect(() => loadConfig()).toThrow("delegation: invalid_format");
		// `~user` is shell user-expansion the tool does NOT perform —
		// accepting it would stat it under the operator's home while the
		// literal path reaches herdr. Fail loud at this boundary.
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base}${cfg({ g7: { machine: "g7", root: "~other/build" } })}}`,
		);
		expect(() => loadConfig()).toThrow("delegation: invalid_format");
		// machine + session on one target is a contradiction — herdr's
		// CLI treats --machine and --session as mutually exclusive.
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base}${cfg({ both: { machine: "g7", session: "goblin" } })}}`,
		);
		expect(() => loadConfig()).toThrow("delegation: custom");
		// Session names ride herdr's session contract, not the harness
		// charset: dots and case are real (goblin.dev, side-session).
		writeFileSync(join(dir, "goblin.json5"), `${base}${cfg({ dev: { session: "goblin.dev" } })}}`);
		expect(loadConfig()!.delegation?.machines?.["dev"]?.session).toBe("goblin.dev");
	});

	test("invalid config throws with file path", () => {
		const dir = useHome();
		writeFileSync(join(dir, "goblin.json5"), `{providers:{},model:"x",operators:[]}`);
		expect(() => loadConfig()).toThrow("goblin.json5");
	});

	test("a port outside 0–65535 is rejected", () => {
		const dir = useHome();
		writeFileSync(
			join(dir, "goblin.json5"),
			`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7],http:{port:70000}}`,
		);
		expect(() => loadConfig()).toThrow("goblin.json5");
	});

	test("a model naming a missing provider is rejected", () => {
		const dir = useHome();
		writeFileSync(
			join(dir, "goblin.json5"),
			`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"other/glm-4.6",operators:[7]}`,
		);
		expect(() => loadConfig()).toThrow("model: custom");
	});

	test("a malformed model ref is rejected", () => {
		const dir = useHome();
		writeFileSync(
			join(dir, "goblin.json5"),
			`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"glm-4.6",operators:[7]}`,
		);
		expect(() => loadConfig()).toThrow("model: custom");
	});

	test('titleModel is provider-validated like model; "" clears to unset', () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"},openrouter:{kind:"openrouter",auth:"openrouter"}},model:"zai/glm-4.6",operators:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base},titleModel:"openrouter/openrouter/free"}`);
		expect(loadConfig()!.titleModel).toBe("openrouter/openrouter/free");
		writeFileSync(join(dir, "goblin.json5"), `${base},titleModel:""}`);
		expect(loadConfig()!.titleModel).toBeUndefined();
		writeFileSync(join(dir, "goblin.json5"), `${base},titleModel:"other/x"}`);
		expect(() => loadConfig()).toThrow("titleModel: custom");
	});

	test('vision: absent by default, defaults + mode, "" clears, model provider-validated', () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"},openrouter:{kind:"openrouter",auth:"openrouter"}},model:"zai/glm-4.6",operators:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base}}`);
		expect(loadConfig()!.vision).toBeUndefined();
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},vision:{model:"openrouter/google/gemini-2.5-flash"}}`,
		);
		expect(loadConfig()!.vision).toEqual({
			model: "openrouter/google/gemini-2.5-flash",
			maxTokens: 2000,
			mode: "auto",
		});
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},vision:{model:"zai/glm-4.6",maxTokens:512,mode:"always"}}`,
		);
		expect(loadConfig()!.vision).toEqual({ model: "zai/glm-4.6", maxTokens: 512, mode: "always" });
		writeFileSync(join(dir, "goblin.json5"), `${base},vision:""}`);
		expect(loadConfig()!.vision).toBeUndefined();
		writeFileSync(join(dir, "goblin.json5"), `${base},vision:{model:"other/x"}}`);
		expect(() => loadConfig()).toThrow("vision: custom");
		writeFileSync(join(dir, "goblin.json5"), `${base},vision:{model:"zai/glm-4.6",maxTokens:0}}`);
		expect(() => loadConfig()).toThrow();
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},vision:{model:"zai/glm-4.6",mode:"sometimes"}}`,
		);
		expect(() => loadConfig()).toThrow();
	});

	test("reviewer: threshold defaults, model is provider-validated, auth required", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base}}`);
		expect(loadConfig()!.reviewer).toBeUndefined();
		writeFileSync(join(dir, "goblin.json5"), `${base},reviewer:{auth:"openrouter"}}`);
		expect(loadConfig()!.reviewer).toEqual({
			threshold: 0.8,
			queueCap: 3,
			evidence: { calls: 8, argChars: 300, outChars: 300 },
			auth: "openrouter",
		});
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},reviewer:{auth:"openrouter",thresholds:{correction:0.7},queueCap:5,evidence:{calls:12}}}`,
		);
		expect(loadConfig()!.reviewer).toEqual({
			threshold: 0.8,
			thresholds: { correction: 0.7 },
			queueCap: 5,
			evidence: { calls: 12, argChars: 300, outChars: 300 },
			auth: "openrouter",
		});
		writeFileSync(join(dir, "goblin.json5"), `${base},reviewer:{auth:"openrouter",queueCap:0}}`);
		expect(() => loadConfig()).toThrow();
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},reviewer:{auth:"openrouter",model:"other/x"}}`,
		);
		expect(() => loadConfig()).toThrow("reviewer: custom");
		writeFileSync(join(dir, "goblin.json5"), `${base},reviewer:{threshold:0.5}}`);
		expect(() => loadConfig()).toThrow();
	});

	test("system1: optional block, model/baseUrl free-form, its own switch", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7]`;
		// Absent → undefined; the block alone enables the shared client.
		writeFileSync(join(dir, "goblin.json5"), `${base},system1:{auth:"x"}}`);
		expect(loadConfig()!.system1).toEqual({ auth: "x" });
		expect(loadConfig()!.reviewer).toBeUndefined();
		writeFileSync(join(dir, "goblin.json5"), `${base}}`);
		expect(loadConfig()!.system1).toBeUndefined();
		// Full block parses as-is.
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},system1:{auth:"x",model:"jev-latest",baseUrl:"https://example.com"}}`,
		);
		expect(loadConfig()!.system1).toEqual({
			auth: "x",
			model: "jev-latest",
			baseUrl: "https://example.com",
		});
		// system1.model is a bare decision-model id, NOT a <provider>/<model-id> chat
		// ref — it is NOT provider-validated (unlike reviewer.model).
		writeFileSync(join(dir, "goblin.json5"), `${base},system1:{auth:"x",model:"other/x"}}`);
		expect(loadConfig()!.system1?.model).toBe("other/x");
		// auth stays required.
		writeFileSync(join(dir, "goblin.json5"), `${base},system1:{model:"jev-latest"}}`);
		expect(() => loadConfig()).toThrow();
	});

	test("search/fetch: single entry, chain list, and rejection shapes", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7]`;
		// Object form normalizes to a one-entry chain (back-compat).
		writeFileSync(join(dir, "goblin.json5"), `${base},search:{kind:"brave",auth:"brave"}}`);
		expect(loadConfig()!.search).toEqual([{ kind: "brave", auth: "brave" }]);
		// List form preserves order — the chain is config order.
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},search:[{kind:"brave",auth:"brave"},{kind:"ddg"}]}`,
		);
		expect(loadConfig()!.search).toEqual([{ kind: "brave", auth: "brave" }, { kind: "ddg" }]);
		// Empty chain is no chain.
		writeFileSync(join(dir, "goblin.json5"), `${base},search:[]}`);
		expect(() => loadConfig()).toThrow();
		// "" clears; fetch takes the same two forms.
		writeFileSync(join(dir, "goblin.json5"), `${base},search:""}`);
		expect(loadConfig()!.search).toBeUndefined();
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},fetch:[{kind:"parallel",auth:"parallel"},{kind:"local"}]}`,
		);
		expect(loadConfig()!.fetch).toEqual([
			{ kind: "parallel", auth: "parallel" },
			{ kind: "local" },
		]);
		writeFileSync(join(dir, "goblin.json5"), `${base},fetch:{kind:"local"}}`);
		expect(loadConfig()!.fetch).toEqual([{ kind: "local" }]);
		// An omitted step auth defaults at parse, and writeConfig
		// materializes it into the file — the saved config stays
		// self-describing (jina stays keyless-blank: no default).
		writeFileSync(join(dir, "goblin.json5"), `${base},search:[{kind:"brave"},{kind:"jina"}]}`);
		const defaulted = loadConfig()!;
		expect(defaulted.search).toEqual([{ kind: "brave", auth: "brave" }, { kind: "jina" }]);
		writeConfig(defaulted);
		expect(readFileSync(join(dir, "goblin.json5"), "utf8")).toContain("auth: 'brave'");
	});

	test('tts defaults to edge; "" is an explicit off that round-trips', () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base}}`);
		expect(loadConfig()!.tts).toEqual({ kind: "edge", voice: "en-US-AriaNeural" });
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},tts:{kind:"edge",voice:"en-US-AriaNeural",rate:"+10%"}}`,
		);
		expect(loadConfig()!.tts).toEqual({ kind: "edge", voice: "en-US-AriaNeural", rate: "+10%" });
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},tts:{kind:"edge",voice:"en-US-AriaNeural",voices:["es-ES-ElviraNeural","es-MX-JorgeNeural"]}}`,
		);
		expect(loadConfig()!.tts).toEqual({
			kind: "edge",
			voice: "en-US-AriaNeural",
			voices: ["es-ES-ElviraNeural", "es-MX-JorgeNeural"],
		});
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},tts:{kind:"edge",voice:"en-US-AriaNeural",voices:[""]}}`,
		);
		expect(() => loadConfig()).toThrow("goblin.json5");
		writeFileSync(join(dir, "goblin.json5"), `${base},tts:""}`);
		expect(loadConfig()!.tts).toBe(false);
		writeFileSync(join(dir, "goblin.json5"), `${base},tts:{kind:"edge",voice:""}}`);
		expect(() => loadConfig()).toThrow("goblin.json5");
	});

	test("tts openrouter defaults model and auth; voice is optional", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base},tts:{kind:"openrouter"}}`);
		expect(loadConfig()!.tts).toEqual({
			kind: "openrouter",
			model: "fish-audio/s2.1-pro-free:free",
			auth: "openrouter",
		});
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},tts:{kind:"openrouter",model:"fish-audio/s2.1-pro",auth:"or-tts",voice:"b347db033a6549378b48d00acb0d06cd"}}`,
		);
		expect(loadConfig()!.tts).toEqual({
			kind: "openrouter",
			model: "fish-audio/s2.1-pro",
			auth: "or-tts",
			voice: "b347db033a6549378b48d00acb0d06cd",
		});
		writeFileSync(join(dir, "goblin.json5"), `${base},tts:{kind:"openrouter",model:""}}`);
		expect(() => loadConfig()).toThrow("goblin.json5");
	});

	test('transcription defaults its model; "" clears to unset', () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base}}`);
		expect(loadConfig()!.transcription).toBeUndefined();
		writeFileSync(join(dir, "goblin.json5"), `${base},transcription:{kind:"groq"}}`);
		expect(loadConfig()!.transcription).toEqual({
			kind: "groq",
			model: "whisper-large-v3-turbo",
			auth: "groq",
		});
		writeFileSync(join(dir, "goblin.json5"), `${base},transcription:""}`);
		expect(loadConfig()!.transcription).toBeUndefined();
		// Back-compat: the pre-union groq block, fields explicit.
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},transcription:{kind:"groq",model:"whisper-large-v3",auth:"groq"}}`,
		);
		expect(loadConfig()!.transcription).toEqual({
			kind: "groq",
			model: "whisper-large-v3",
			auth: "groq",
		});
	});

	test("whistle parses with keywords and its language set", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7]`;
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},transcription:{kind:"whistle",keywords:["goblin","bermudi"],language:"es"}}`,
		);
		expect(loadConfig()!.transcription).toEqual({
			kind: "whistle",
			keywords: ["goblin", "bermudi"],
			language: "es",
		});
		// Its language is an enum, not any 2-letter code.
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},transcription:{kind:"whistle",language:"ja"}}`,
		);
		expect(() => loadConfig()).toThrow("goblin.json5");
	});

	test("writeConfig preserves a hardened file mode", () => {
		const dir = useHome();
		const p = join(dir, "goblin.json5");
		writeFileSync(p, "{}");
		chmodSync(p, 0o600);
		writeConfig(valid);
		expect(statSync(p).mode & 0o777).toBe(0o600);
		// and it round-trips — including the explicit tts off
		expect(loadConfig()!.model).toBe("zai/glm-4.6");
		expect(loadConfig()!.tts).toBe(false);
	});

	test('memory is optional, validated, and "" clears to unset', () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base}}`);
		expect(loadConfig()!.memory).toBeUndefined();
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},memory:{baseUrl:"http://127.0.0.1:8888",bankId:"goblin"}}`,
		);
		const mem = loadConfig()!.memory!;
		expect(mem.bankId).toBe("goblin");
		expect(mem.recallTimeoutMs).toBe(5000);
		expect(mem.maxTokens).toBe(1024);
		expect(mem.budget).toBe("low");
		// Remote plain HTTP is rejected — loopback or HTTPS only.
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},memory:{baseUrl:"http://memory.example",bankId:"goblin"}}`,
		);
		expect(() => loadConfig()).toThrow("goblin.json5");
		writeFileSync(join(dir, "goblin.json5"), `${base},memory:""}`);
		expect(loadConfig()!.memory).toBeUndefined();
	});

	test("mail is optional; all three fields required when present", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base}}`);
		expect(loadConfig()!.mail).toBeUndefined();
		// Reads ride gws's own auth — the block holds only the send
		// credential (plus the public client id and secret ref).
		const block = `mail:{clientId:"x.apps.googleusercontent.com",clientSecretAuth:"gmail-secret",sendAuth:"gmail-send"}`;
		writeFileSync(join(dir, "goblin.json5"), `${base},${block}}`);
		expect(loadConfig()!.mail).toEqual({
			clientId: "x.apps.googleusercontent.com",
			clientSecretAuth: "gmail-secret",
			sendAuth: "gmail-send",
		});
		// A half-configured block is a boot error, not a silent half.
		writeFileSync(join(dir, "goblin.json5"), `${base},mail:{clientId:"x"}}`);
		expect(() => loadConfig()).toThrow("goblin.json5");
	});
});

describe("ensureHomeLayout", () => {
	test("first-boot directory names are synced before state and attachments are used", () => {
		const dir = useHome();
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
		const dir = useHome();
		writeFileSync(join(dir, "state"), "not a directory");
		expect(() => ensureHomeLayout()).toThrow("layout directory is not a directory");
	});

	test("first boot creates the reviewer's proposals directory", () => {
		const dir = useHome();
		ensureHomeLayout();
		expect(statSync(join(dir, "workspace", "skills-proposed")).isDirectory()).toBe(true);
	});

	test("first boot seeds SOUL.md and the AGENTS.md stub", () => {
		const dir = useHome();
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
		const dir = useHome();
		ensureHomeLayout();
		const skill = readFileSync(join(dir, "workspace", "skills", "browser", "SKILL.md"), "utf8");
		// The compatibility line is what the system prompt's catalog
		// renders — the recovery command must ride it, so a missing CLI is
		// never a dead-end invitation (DESIGN.md, "Web access").
		expect(skill).toContain(
			"compatibility: Requires the agent-browser CLI and a Chrome/Chromium binary",
		);
		expect(skill).toContain("npm i -g agent-browser && agent-browser install");
		// Frontmatter name must match the directory or the catalog skips it.
		expect(skill).toContain("name: browser");
		// The pass-cli skill seeds the same way (DESIGN.md, "Proton
		// Pass") — its compatibility line names the dependency (goblin's
		// own agent token), which the catalog renders every turn.
		const passCli = readFileSync(join(dir, "workspace", "skills", "pass-cli", "SKILL.md"), "utf8");
		expect(passCli).toContain("name: pass-cli");
		expect(passCli).toContain("compatibility:");
	});

	test("existing identity files are never clobbered", () => {
		const dir = useHome();
		mkdirSync(join(dir, "workspace"), { recursive: true });
		writeFileSync(join(dir, "workspace", "AGENTS.md"), "my notes");
		writeFileSync(join(dir, "workspace", "USER.md"), "my user model");
		ensureHomeLayout();
		expect(readFileSync(join(dir, "workspace", "AGENTS.md"), "utf8")).toBe("my notes");
		expect(readFileSync(join(dir, "workspace", "USER.md"), "utf8")).toBe("my user model");
	});

	test("an evolved browser skill is never clobbered by the seed", () => {
		const dir = useHome();
		mkdirSync(join(dir, "workspace", "skills", "browser"), { recursive: true });
		writeFileSync(join(dir, "workspace", "skills", "browser", "SKILL.md"), "my evolution");
		ensureHomeLayout();
		expect(readFileSync(join(dir, "workspace", "skills", "browser", "SKILL.md"), "utf8")).toBe(
			"my evolution",
		);
	});

	test("first boot seeds the mcp skill and an empty, import-free mcporter.json", () => {
		const dir = useHome();
		ensureHomeLayout();
		const skill = readFileSync(join(dir, "workspace", "skills", "mcp", "SKILL.md"), "utf8");
		expect(skill).toContain("name: mcp");
		expect(skill).toContain("compatibility:");
		// The seed is the isolation default: no servers, and imports []
		// so mcporter never merges the operator's editor setups
		// (DESIGN.md, "Web access" → "MCP").
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
		const dir = useHome();
		writeFileSync(join(dir, "mcporter.json"), '{"mcpServers": {"x": {}}, "imports": []}');
		ensureHomeLayout();
		expect(readFileSync(join(dir, "mcporter.json"), "utf8")).toContain('"x"');
	});

	test("first boot links the mcp shim at the home root, and a repo move heals it", () => {
		const dir = useHome();
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
		const dir = useHome();
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
			appToken: "app-token-record",
		});
		expect([...authReferences(c)].sort()).toEqual([
			"app-token-record",
			"brave-key",
			"telegram",
			"zai",
		]);
	});
});

test("legacy Telegram selection pins independently from app-default patches and survives saves", () => {
	useHome();
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

	test("whistle keywords cap at 100 non-empty entries", () => {
		expect(
			transcriptionSchema.safeParse({ kind: "whistle", keywords: Array(101).fill("x") }).success,
		).toBe(false);
		expect(transcriptionSchema.safeParse({ kind: "whistle", keywords: [""] }).success).toBe(false);
		expect(
			transcriptionSchema.safeParse({ kind: "whistle", keywords: Array(100).fill("x") }).success,
		).toBe(true);
	});
});

describe("sandbox block", () => {
	const base = {
		providers: { test: { kind: "codex" } },
		model: "test/m",
		operators: [7],
		allowedUsers: [7],
	};
	test("absent and '' mean no sandbox tool", () => {
		expect(parseConfig(base).sandbox).toBeUndefined();
		expect(parseConfig({ ...base, sandbox: "" }).sandbox).toBeUndefined();
	});
	test("an empty block fills the defaults", () => {
		expect(parseConfig({ ...base, sandbox: {} }).sandbox).toEqual({
			image: "docker.io/library/alpine:latest",
			idleHours: 24,
			memory: "2g",
			cpus: 2,
			pids: 512,
		});
	});
	test("explicit values parse; bad image refs and small pids fail loud", () => {
		const cfg = parseConfig({
			...base,
			sandbox: { image: "docker.io/library/debian:stable-slim", idleHours: 0, pids: 64 },
		}).sandbox;
		expect(cfg?.image).toBe("docker.io/library/debian:stable-slim");
		expect(cfg?.idleHours).toBe(0);
		expect(() => parseConfig({ ...base, sandbox: { image: "--privileged" } })).toThrow();
		expect(() => parseConfig({ ...base, sandbox: { pids: 4 } })).toThrow();
		expect(() => parseConfig({ ...base, sandbox: { idleHours: -1 } })).toThrow();
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
			const dir = useHome();
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
		const dir = useHome();
		writeFileSync(join(dir, "goblin.json5"), `{\nmodel: ${sentinel}\n}`);
		expect(safeFailure(() => loadConfig()).message).toBe(
			`${join(dir, "goblin.json5")}:2: invalid JSON5`,
		);
	});
});
