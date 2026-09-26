import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureHomeLayout,
	loadConfig,
	providerKinds,
	providerSchema,
	fetchKinds,
	fetchEntrySchema,
	searchKinds,
	searchEntrySchema,
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
	tts: false,
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
		// TTS is default-on: absent block, default voice.
		expect(c.tts).toEqual({ kind: "edge", voice: "en-US-AriaNeural" });
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

	test("reviewer: threshold defaults, model is provider-validated, auth required", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base}}`);
		expect(loadConfig()!.reviewer).toBeUndefined();
		writeFileSync(join(dir, "goblin.json5"), `${base},reviewer:{auth:"openrouter"}}`);
		expect(loadConfig()!.reviewer).toEqual({ threshold: 0.8, auth: "openrouter" });
		writeFileSync(join(dir, "goblin.json5"), `${base},reviewer:{auth:"openrouter",model:"other/x"}}`);
		expect(() => loadConfig()).toThrow('provider "other"');
		writeFileSync(join(dir, "goblin.json5"), `${base},reviewer:{threshold:0.5}}`);
		expect(() => loadConfig()).toThrow();
	});

	test("search/fetch: single entry, chain list, and rejection shapes", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7]`;
		// Object form normalizes to a one-entry chain (back-compat).
		writeFileSync(join(dir, "goblin.json5"), `${base},search:{kind:"brave",auth:"brave"}}`);
		expect(loadConfig()!.search).toEqual([{ kind: "brave", auth: "brave" }]);
		// List form preserves order — the chain is config order.
		writeFileSync(
			join(dir, "goblin.json5"),
			`${base},search:[{kind:"brave",auth:"brave"},{kind:"ddg"}]}`,
		);
		expect(loadConfig()!.search).toEqual([
			{ kind: "brave", auth: "brave" },
			{ kind: "ddg" },
		]);
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
	});

	test("tts defaults to edge; \"\" is an explicit off that round-trips", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base}}`);
		expect(loadConfig()!.tts).toEqual({ kind: "edge", voice: "en-US-AriaNeural" });
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
		expect(loadConfig()!.tts).toBe(false);
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
		// and it round-trips — including the explicit tts off
		expect(loadConfig()!.model).toBe("zai/glm-4.6");
		expect(loadConfig()!.tts).toBe(false);
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

	test("mail is optional; all four fields required when present", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base}}`);
		expect(loadConfig()!.mail).toBeUndefined();
		const block = `mail:{clientId:"x.apps.googleusercontent.com",clientSecretAuth:"gmail-secret",readAuth:"gmail-read",sendAuth:"gmail-send"}`;
		writeFileSync(join(dir, "goblin.json5"), `${base},${block}}`);
		expect(loadConfig()!.mail).toEqual({
			clientId: "x.apps.googleusercontent.com",
			clientSecretAuth: "gmail-secret",
			readAuth: "gmail-read",
			sendAuth: "gmail-send",
		});
		// A half-configured block is a boot error, not a silent half.
		writeFileSync(join(dir, "goblin.json5"), `${base},mail:{clientId:"x"}}`);
		expect(() => loadConfig()).toThrow("goblin.json5");
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
	});

	test("a real file at the shim path is never clobbered", () => {
		const dir = useHome();
		writeFileSync(join(dir, "mcp"), "operator's own");
		ensureHomeLayout();
		expect(lstatSync(join(dir, "mcp")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(dir, "mcp"), "utf8")).toBe("operator's own");
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
		// Required-auth kinds really do require it.
		for (const kind of ["brave", "exa", "tavily", "firecrawl", "parallel"] as const) {
			expect(searchEntrySchema.safeParse({ kind }).success).toBe(false);
		}
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
		for (const kind of ["tavily", "firecrawl", "parallel"] as const) {
			expect(fetchEntrySchema.safeParse({ kind }).success).toBe(false);
		}
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
