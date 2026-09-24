import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureHomeLayout,
	loadConfig,
	providerKinds,
	providerSchema,
	splitModelRef,
	writeConfig,
	type Config,
} from "./config.ts";

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
	favorites: [],
	thinking: "medium",
	allowedUsers: [1],
	telegram: {},
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
			`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7]}`,
		);
		const c = loadConfig()!;
		expect(c.thinking).toBe("medium");
		expect(c.http.port).toBe(8787);
		expect(c.allowedUsers).toEqual([7]);
	});

	test("invalid config throws with file path", () => {
		const dir = useHome();
		writeFileSync(join(dir, "goblin.json5"), `{providers:{},model:"x",allowedUsers:[]}`);
		expect(() => loadConfig()).toThrow("goblin.json5");
	});

	test("a port outside 0–65535 is rejected", () => {
		const dir = useHome();
		writeFileSync(
			join(dir, "goblin.json5"),
			`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7],http:{port:70000}}`,
		);
		expect(() => loadConfig()).toThrow("goblin.json5");
	});

	test("a model naming a missing provider is rejected", () => {
		const dir = useHome();
		writeFileSync(
			join(dir, "goblin.json5"),
			`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"other/glm-4.6",allowedUsers:[7]}`,
		);
		expect(() => loadConfig()).toThrow('provider "other"');
	});

	test("a malformed model ref is rejected", () => {
		const dir = useHome();
		writeFileSync(
			join(dir, "goblin.json5"),
			`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"glm-4.6",allowedUsers:[7]}`,
		);
		expect(() => loadConfig()).toThrow("provider>/<model-id>");
	});

	test("titleModel is provider-validated like model; \"\" clears to unset", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"},openrouter:{kind:"openrouter",auth:"openrouter"}},model:"zai/glm-4.6",allowedUsers:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base},titleModel:"openrouter/openrouter/free"}`);
		expect(loadConfig()!.titleModel).toBe("openrouter/openrouter/free");
		writeFileSync(join(dir, "goblin.json5"), `${base},titleModel:""}`);
		expect(loadConfig()!.titleModel).toBeUndefined();
		writeFileSync(join(dir, "goblin.json5"), `${base},titleModel:"other/x"}`);
		expect(() => loadConfig()).toThrow('provider "other"');
	});

	test("tts validates edge voice/rate and \"\" clears to unset", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base},tts:{kind:"edge",voice:"en-US-AriaNeural",rate:"+10%"}}`);
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
		expect(loadConfig()!.tts).toBeUndefined();
		writeFileSync(join(dir, "goblin.json5"), `${base},tts:{kind:"edge",voice:""}}`);
		expect(() => loadConfig()).toThrow("goblin.json5");
	});

	test("transcription defaults its model; \"\" clears to unset", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base}}`);
		expect(loadConfig()!.transcription).toBeUndefined();
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},transcription:{kind:"groq",auth:"groq"}}`,
		);
		expect(loadConfig()!.transcription).toEqual({
			kind: "groq",
			model: "whisper-large-v3-turbo",
			auth: "groq",
		});
		writeFileSync(join(dir, "goblin.json5"), `${base},transcription:""}`);
		expect(loadConfig()!.transcription).toBeUndefined();
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},transcription:{kind:"elevenlabs",auth:"x"}}`,
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
		// and it round-trips
		expect(loadConfig()!.model).toBe("zai/glm-4.6");
	});

	test("memory is optional, validated, and \"\" clears to unset", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base}}`);
		expect(loadConfig()!.memory).toBeUndefined();
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},memory:{baseUrl:"http://127.0.0.1:8888",bankId:"goblin"}}`,
		);
		const mem = loadConfig()!.memory!;
		expect(mem.bankId).toBe("goblin");
		expect(mem.recallTimeoutMs).toBe(2000);
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
});

describe("ensureHomeLayout", () => {
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
});

describe("providerKinds", () => {
	// The kinds array must agree with the zod union in BOTH directions:
	// a kind in the schema but not the array → the mini app can't render
	// or save a hand-edited config using it; a kind in the array but not
	// the schema → the form offers what the config rejects.
	test("every kind parses with its required fields; an unknown kind is rejected", () => {
		const fields: Record<string, Record<string, unknown>> = {
			"openai-compatible": { baseUrl: "https://api.example.com", auth: "a" },
			openrouter: { auth: "a" },
			codex: {},
		};
		for (const kind of providerKinds) {
			expect(providerSchema.safeParse({ kind, ...fields[kind] }).success).toBe(true);
		}
		expect(providerSchema.safeParse({ kind: "anthropic" }).success).toBe(false);
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
