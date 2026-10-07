import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setLogFile, setLogWriter } from "./log.ts";
import * as fs from "node:fs";
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
	parseConfig,
	type Config,
} from "./config.ts";

test("the mini-app public URL must be HTTPS, unlike the local bot API URL", () => {
	const config = { providers: { test: { kind: "openai-compatible", baseUrl: "https://api.example.org", auth: "ref" } },
		model: "test/m", allowedUsers: [42] };
	expect(() => parseConfig({ ...config, publicUrl: "http://example.org" })).toThrow();
	expect(parseConfig({ ...config, publicUrl: "https://example.org" }).publicUrl).toBe("https://example.org");
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
	allowedUsers: [1],
	telegram: { dmGapMinutes: 45 },
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

	test("a legacy delegation.session warns and is ignored — the unit owns the session", () => {
		const dir = useHome();
		writeFileSync(
				join(dir, "goblin.json5"),
				`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7],delegation:{session:"other",harnesses:{pi:{kind:"pi"}}}}`,
		);
		const captured: string[] = [];
		setLogFile("config-legacy-session-test.log");
		setLogWriter((_path, line) => {
			captured.push(line);
		});
		try {
			const c = loadConfig()!;
			// The knob strips; the rest of the delegation block stands.
			expect(c.delegation?.harnesses["pi"]?.kind).toBe("pi");
			const warns = captured
				.map((l) => JSON.parse(l) as Record<string, unknown>)
				.filter((l) => typeof l.msg === "string" && l.msg.includes("delegation.session is gone"));
			expect(warns).toHaveLength(1);
		} finally {
			setLogFile(null);
			setLogWriter(null);
		}
	});

	test("delegation.machines parses saved-machine and local-session targets; bad roots and both-kind targets are rejected", () => {
		const dir = useHome();
		const cfg = (machines: unknown) =>
			`{machines:${JSON.stringify(machines)},harnesses:{pi:{kind:"pi"}}}`;
		const base =
			`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7],delegation:`;
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
		expect(() => loadConfig()).toThrow(/root must be absolute/);
		// machine + session on one target is a contradiction — herdr's
		// CLI treats --machine and --session as mutually exclusive.
		writeFileSync(
				join(dir, "goblin.json5"),
				`${base}${cfg({ both: { machine: "g7", session: "goblin" } })}}`,
		);
		expect(() => loadConfig()).toThrow(/exactly one of machine/);
		// Session names ride herdr's session contract, not the harness
		// charset: dots and case are real (goblin.dev, side-session).
		writeFileSync(
				join(dir, "goblin.json5"),
				`${base}${cfg({ dev: { session: "goblin.dev" } })}}`,
		);
		expect(loadConfig()!.delegation?.machines?.["dev"]?.session).toBe("goblin.dev");
	});

	test("a legacy delegation.machine is translated to a machines entry, not dropped", () => {
		const dir = useHome();
		writeFileSync(
				join(dir, "goblin.json5"),
				`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7],delegation:{machine:{label:"g7",cwd:"/home/daniel/goblin/delegated"},harnesses:{pi:{kind:"pi"}}}}`,
		);
		const captured: string[] = [];
		setLogFile("config-legacy-machine-test.log");
		setLogWriter((_path, line) => {
			captured.push(line);
		});
		try {
			const c = loadConfig()!;
			// Under single-machine mode every delegation went to that
			// machine — booting local instead would misroute live rows.
			expect(c.delegation?.machines?.["g7"]).toEqual({
				machine: "g7",
				root: "/home/daniel/goblin/delegated",
			});
			const warns = captured
				.map((l) => JSON.parse(l) as Record<string, unknown>)
				.filter((l) => typeof l.msg === "string" && l.msg.includes("translated to a machines entry"));
			expect(warns).toHaveLength(1);
			// An explicit machines entry of the same label wins — the
			// file's newer form is the truth, the legacy block is noise.
			writeFileSync(
					join(dir, "goblin.json5"),
					`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7],delegation:{machine:{label:"g7",cwd:"/legacy/root"},machines:{g7:{machine:"g7",root:"~/build"}},harnesses:{pi:{kind:"pi"}}}}`,
			);
			const c2 = loadConfig()!;
			expect(c2.delegation?.machines?.["g7"]?.root).toBe("~/build");
		} finally {
			setLogFile(null);
			setLogWriter(null);
		}
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

	test("vision: absent by default, defaults + mode, \"\" clears, model provider-validated", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"},openrouter:{kind:"openrouter",auth:"openrouter"}},model:"zai/glm-4.6",allowedUsers:[7]`;
		writeFileSync(join(dir, "goblin.json5"), `${base}}`);
		expect(loadConfig()!.vision).toBeUndefined();
		writeFileSync(join(dir, "goblin.json5"), `${base},vision:{model:"openrouter/google/gemini-2.5-flash"}}`);
		expect(loadConfig()!.vision).toEqual({
			model: "openrouter/google/gemini-2.5-flash",
			maxTokens: 2000,
			mode: "auto",
		});
		writeFileSync(join(dir, "goblin.json5"), `${base},vision:{model:"zai/glm-4.6",maxTokens:512,mode:"always"}}`);
		expect(loadConfig()!.vision).toEqual({ model: "zai/glm-4.6", maxTokens: 512, mode: "always" });
		writeFileSync(join(dir, "goblin.json5"), `${base},vision:""}`);
		expect(loadConfig()!.vision).toBeUndefined();
		writeFileSync(join(dir, "goblin.json5"), `${base},vision:{model:"other/x"}}`);
		expect(() => loadConfig()).toThrow('provider "other"');
		writeFileSync(join(dir, "goblin.json5"), `${base},vision:{model:"zai/glm-4.6",maxTokens:0}}`);
		expect(() => loadConfig()).toThrow();
		writeFileSync(join(dir, "goblin.json5"), `${base},vision:{model:"zai/glm-4.6",mode:"sometimes"}}`);
		expect(() => loadConfig()).toThrow();
	});

	test("reviewer: threshold defaults, model is provider-validated, auth required", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7]`;
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
		writeFileSync(join(dir, "goblin.json5"), `${base},reviewer:{auth:"openrouter",model:"other/x"}}`);
		expect(() => loadConfig()).toThrow('provider "other"');
		writeFileSync(join(dir, "goblin.json5"), `${base},reviewer:{threshold:0.5}}`);
		expect(() => loadConfig()).toThrow();
	});

	test("system1: optional block, model/baseUrl free-form, reviewer stays the switch", () => {
		const dir = useHome();
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7]`;
		// Absent → undefined; system1 alone enables nothing (reviewer is the switch).
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
		// system1.model is a Jev model id, NOT a <provider>/<model-id> chat
		// ref — it is NOT provider-validated (unlike reviewer.model).
		writeFileSync(join(dir, "goblin.json5"), `${base},system1:{auth:"x",model:"other/x"}}`);
		expect(loadConfig()!.system1?.model).toBe("other/x");
		// auth stays required.
		writeFileSync(join(dir, "goblin.json5"), `${base},system1:{model:"jev-latest"}}`);
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
		const base = `{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",allowedUsers:[7]`;
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
		rmSync(mailShim);
		symlinkSync(join("somewhere-else", "goblin-mail"), mailShim);
		ensureHomeLayout();
		expect(readlinkSync(mailShim)).toBe(join(import.meta.dir, "..", "scripts", "goblin-mail"));
	});

	test("a real file at the shim path is never clobbered", () => {
		const dir = useHome();
		writeFileSync(join(dir, "mcp"), "operator's own");
		writeFileSync(join(dir, "goblin-mail"), "operator's own mail");
		ensureHomeLayout();
		expect(lstatSync(join(dir, "mcp")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(dir, "mcp"), "utf8")).toBe("operator's own");
		expect(lstatSync(join(dir, "goblin-mail")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(dir, "goblin-mail"), "utf8")).toBe("operator's own mail");
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
