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

	test("existing identity files are never clobbered", () => {
		const dir = useHome();
		mkdirSync(join(dir, "workspace"), { recursive: true });
		writeFileSync(join(dir, "workspace", "AGENTS.md"), "my notes");
		writeFileSync(join(dir, "workspace", "USER.md"), "my user model");
		ensureHomeLayout();
		expect(readFileSync(join(dir, "workspace", "AGENTS.md"), "utf8")).toBe("my notes");
		expect(readFileSync(join(dir, "workspace", "USER.md"), "utf8")).toBe("my user model");
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
