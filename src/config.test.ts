import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, splitModelRef, writeConfig, type Config } from "./config.ts";

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
