// goblin.json5 — the one config file; no secrets (those live in auth.jsonl).

import {
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readlinkSync,
	statSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import JSON5 from "json5";
import { z } from "zod";
import { durableWriteFile } from "./durable.ts";
import { hindsightConnectionSchema } from "./hindsight.ts";
import { log } from "./log.ts";

// ---------- paths ----------

export function goblinHome(): string {
	return process.env.GOBLIN_HOME ?? join(homedir(), "goblin");
}

export const paths = {
	config: () => join(goblinHome(), "goblin.json5"),
	auth: () => join(goblinHome(), "auth.jsonl"),
	mcporter: () => join(goblinHome(), "mcporter.json"),
	mcpShim: () => join(goblinHome(), "mcp"),
	goblinMailShim: () => join(goblinHome(), "goblin-mail"),
	doctorShim: () => join(goblinHome(), "doctor"),
	workspace: () => join(goblinHome(), "workspace"),
	soul: () => join(goblinHome(), "workspace", "SOUL.md"),
	agents: () => join(goblinHome(), "workspace", "AGENTS.md"),
	user: () => join(goblinHome(), "workspace", "USER.md"),
	skills: () => join(goblinHome(), "workspace", "skills"),
	// The skill reviewer's parking area: validated auto-saves wait here
	// for the operator's yes — never in the catalog itself
	// (design/skills.md, "It proposes, then tells").
	skillsProposed: () => join(goblinHome(), "workspace", "skills-proposed"),
	attachments: () => join(goblinHome(), "workspace", "attachments"),
	state: () => join(goblinHome(), "state"),
	db: () => join(goblinHome(), "state", "goblin.sqlite"),
	logFile: () => join(goblinHome(), "state", "goblin.log"),
	delegations: () => join(goblinHome(), "state", "delegations"),
	modelsDevCache: () => join(goblinHome(), "state", "models.dev.json"),
	openrouterModelsCache: () => join(goblinHome(), "state", "openrouter-models.json"),
	webcache: () => join(goblinHome(), "state", "webcache"),
	scriptcache: () => join(goblinHome(), "state", "scriptcache"),
	// Project homes (design/projects.md) — lazy: created on the first
	// project create, not by ensureHomeLayout.
	projects: () => join(goblinHome(), "projects"),
	// Local speech-engine artifacts (digest-pinned auto-fetch —
	// design/asr.md → Whistle). Cache, not state: deletable at will.
	whistleCache: () => join(goblinHome(), "cache", "whistle"),
};

// One layout directory, durably: missing ancestors are created
// oldest-first, each parent fsynced — a WAL commit can't protect a
// file inside a directory that vanishes on first-boot power loss.
export function ensureDir(dir: string): void {
	const missing: string[] = [];
	for (let next = dir; ; next = dirname(next)) {
		try {
			if (!statSync(next).isDirectory())
				throw new Error(`layout directory is not a directory: ${next}`);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			missing.unshift(next);
			if (dirname(next) === next) throw new Error(`no existing parent for ${dir}`);
		}
	}
	for (const next of missing) {
		mkdirSync(next);
		const parent = openSync(dirname(next), constants.O_RDONLY);
		try {
			fsyncSync(parent);
		} finally {
			closeSync(parent);
		}
	}
}

export function ensureHomeLayout(): void {
	for (const dir of [
		goblinHome(),
		paths.workspace(),
		paths.skills(),
		paths.skillsProposed(),
		paths.attachments(),
		paths.state(),
	]) {
		ensureDir(dir);
	}
	seedFile(
		paths.soul(),
		[
			"# SOUL.md",
			"",
			"You are goblin, a personal AI agent living in Telegram. You serve one",
			"operator. You are direct, competent, and terse by default — this is a",
			"chat, not a report generator. You have a shell, a filesystem, and",
			"opinions. Use them.",
			"",
		].join("\n"),
	);
	seedFile(
		paths.agents(),
		[
			"# AGENTS.md",
			"",
			"Your operating notes. Each conversation starts from this file and",
			"nothing else — it is your only memory between them. Write things down:",
			"",
			'- Operator says "remember this" → it goes here.',
			"- You learn a deployment fact (a path, a host, a service, where",
			"  things live on this machine) → it goes here.",
			"- You make a mistake you could repeat → the lesson goes here.",
			"- A rule stops being true → replace it in place. Never keep two",
			"  rules that contradict.",
			"",
			"Facts, not plans. Short lines. No secrets. Read before writing —",
			"update what exists instead of stacking a new entry.",
			"",
		].join("\n"),
	);
	// Repo-shipped skills: a rebuilt box regains the capability without prompting.
	for (const skill of ["browser", "pass-cli", "mcp", "gws", "herdr"]) {
		mkdirSync(join(paths.skills(), skill), { recursive: true });
		const template = readFileSync(
			join(import.meta.dir, "..", "deploy", "skills", skill, "SKILL.md"),
			"utf8",
		);
		seedFile(join(paths.skills(), skill, "SKILL.md"), template);
	}
	// The seed's `"imports": []` is load-bearing: without it mcporter
	// merges the operator's editor servers.
	seedFile(
		paths.mcporter(),
		[
			"{",
			'\t// Goblin\'s own MCP servers (DESIGN.md, "Web access" → "MCP").',
			"\t// Secrets are ${VAR} placeholders only — values ride the",
			"\t// goblin-mcp-dev pass-keys profile into mcporter's child env,",
			'\t// never this file. "imports" MUST stay []: without it',
			"\t// mcporter merges the operator's editor servers, and the",
			"\t// call-time gate refuses anything else.",
			'\t"mcpServers": {},',
			'\t"imports": []',
			"}",
			"",
		].join("\n"),
	);
	refreshMcpShim();
	refreshGoblinMailShim();
	refreshDoctorShim();
	seedFile(
		paths.user(),
		[
			"# USER.md",
			"",
			"Your model of the operator — stable preferences and facts they",
			"would endorse, one directive per entry:",
			"",
			"<!-- observed: YYYY-MM-DD | status: active -->",
			"- Always/Never/Prefer …",
			"",
			"When a preference changes, mark the old entry superseded and write",
			"the replacement — never two active directives that contradict.",
			"Date every entry. An empty file is correct until something real is",
			"learned; don't invent entries to fill it.",
			"",
		].join("\n"),
	);
}

// First-boot scaffolding: create iff absent — operator and agent edits
// are never clobbered. Stubs, not just standing instructions: a model
// edits a file in its prompt head but won't create one out of nothing.
function seedFile(path: string, content: string): void {
	if (existsSync(path)) return;
	durableWriteFile(path, content, 0o644);
}

// Workspace bash can't see the repo, so the `mcp` skill's entry point is
// a symlink — repo updates propagate, repointed every boot. A real file
// in the way refuses loud: a missing shim is degraded, not fatal.
function refreshMcpShim(): void {
	const shim = paths.mcpShim();
	const target = join(import.meta.dir, "..", "scripts", "mcp");
	let isLink: boolean | null = null;
	try {
		isLink = lstatSync(shim).isSymbolicLink();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (isLink === null) {
		symlinkSync(target, shim);
		return;
	}
	if (!isLink) {
		log.error("not clobbering the mcp shim: a real file is in the way", undefined, { path: shim });
		return;
	}
	if (readlinkSync(shim) !== target) {
		unlinkSync(shim);
		symlinkSync(target, shim);
	}
}

// The `goblin-mail` skill's entry point — same symlink-not-copy contract
// as the mcp shim above.
function refreshGoblinMailShim(): void {
	const shim = paths.goblinMailShim();
	const target = join(import.meta.dir, "..", "scripts", "goblin-mail");
	let isLink: boolean | null = null;
	try {
		isLink = lstatSync(shim).isSymbolicLink();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (isLink === null) {
		symlinkSync(target, shim);
		return;
	}
	if (!isLink) {
		log.error("not clobbering the goblin-mail shim: a real file is in the way", undefined, {
			path: shim,
		});
		return;
	}
	if (readlinkSync(shim) !== target) {
		unlinkSync(shim);
		symlinkSync(target, shim);
	}
}

function refreshDoctorShim(): void {
	const shim = paths.doctorShim();
	const target = join(import.meta.dir, "..", "scripts", "doctor");
	let isLink: boolean | null = null;
	try {
		isLink = lstatSync(shim).isSymbolicLink();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (isLink === null) {
		symlinkSync(target, shim);
		return;
	}
	if (!isLink) {
		log.error("not clobbering the doctor shim: a real file is in the way", undefined, {
			path: shim,
		});
		return;
	}
	if (readlinkSync(shim) !== target) {
		unlinkSync(shim);
		symlinkSync(target, shim);
	}
}

// ---------- schema ----------

// The auth.jsonl record a keyed kind uses when the config omits auth —
// the kind's own record name, materialized into the file on the next
// save (writeConfig re-parses through the schema). Blank therefore means
// "the kind's record", never "no key": jina is deliberately absent
// because it works keyless, so its blank must stay keyless. Served to
// both settings clients so placeholders and saves derive from one source.
export const authDefaults = {
	brave: "brave",
	exa: "exa",
	tavily: "tavily",
	firecrawl: "firecrawl",
	parallel: "parallel",
	openrouter: "openrouter",
} as const;

// Single source: config.test.ts pins this array against the schema
// literals below in both directions — schema-only kind → the settings UI
// can't offer it; array-only kind → the UI offers what the config rejects.
export const providerKinds = ["openai-compatible", "responses", "openrouter", "codex"] as const;
export const providerSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("openai-compatible"),
		baseUrl: z.url(),
		auth: z.string().min(1),
	}),
	// OpenAI Responses protocol — the one chat-family protocol whose tool
	// outputs carry documents (function_call_output content arrays).
	z.object({
		kind: z.literal("responses"),
		baseUrl: z.url(),
		auth: z.string().min(1),
	}),
	z.object({
		kind: z.literal("openrouter"),
		auth: z.string().min(1).default(authDefaults.openrouter),
	}),
	z.object({
		kind: z.literal("codex"),
		// Codex CLI OAuth file (~/.codex/auth.json when unset) — read and
		// refreshed in-process; it is not an auth.jsonl record.
		authFile: z.string().min(1).optional(),
	}),
]);

export const thinkingLevels = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

// Optional long-term memory. auth names an auth.jsonl record (loopback
// needs none); recall bounds are tight — turns must not wait on memory.
export const memoryConfigSchema = z.object({
	baseUrl: hindsightConnectionSchema.shape.baseUrl,
	bankId: hindsightConnectionSchema.shape.bankId,
	auth: z.string().min(1).optional(),
	recallTimeoutMs: z.number().int().min(100).max(10_000).default(5000),
	maxTokens: z.number().int().min(1).max(8192).default(1024),
	budget: z.enum(["low", "mid", "high"]).default("low"),
});
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;

// Image Q&A behind the vision tool — absent = off. mode "auto" adds the
// tool only while the chat model can't consume images; a file on disk is
// invisible either way (tool results carry no image bytes).
export const visionConfigSchema = z.object({
	model: z.string().min(1),
	maxTokens: z.number().int().min(1).max(32_768).default(2000),
	mode: z.enum(["auto", "always"]).default("auto"),
});
export type VisionConfig = z.infer<typeof visionConfigSchema>;

// In-process tool composition behind the script tool — absent = off
// (design/tools.md → Scripting). maxCalls bounds nested tool calls per
// script; absent falls back to the default at the wiring site.
export const scriptingConfigSchema = z.object({
	maxCalls: z.number().int().min(1).max(500).optional(),
});
export type ScriptingConfig = z.infer<typeof scriptingConfigSchema>;

// Edge read-aloud: no auth, unofficial, can break — ffmpeg is the only dependency.
export const DEFAULT_TTS_VOICE = "en-US-AriaNeural";

// Delegation to external harnesses via herdr — absent = no delegate
// tool. Harness names double as herdr agent-name prefixes (hence the
// charset); the LOCAL session is the implicit default, never a knob.
const harnessNameRe = /^[a-z][a-z0-9_-]{0,15}$/;
const harnessNameSchema = z.string().regex(harnessNameRe);
export const harnessMapSchema = z
	.record(
		harnessNameSchema,
		z.object({
			kind: z.string().min(1),
			args: z.array(z.string()).optional(),
		}),
	)
	.refine((h) => Object.keys(h).length > 0, {
		message: "delegation.harnesses must name at least one harness",
	});

// One delegation target — exactly one of machine|session, mirroring the
// herdr CLI's own mutual exclusion. Session names stay stricter than
// herdr's own contract because they become socket-dir names.
const sessionNameSchema = z
	.string()
	.regex(
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
		"session name must start alphanumeric and contain only [A-Za-z0-9._-]",
	);

// root must be `~`, `~/...`, or absolute (server-expanded) — rejected here,
// not at launch. `~user` is shell user-expansion we do NOT perform
// (delegate.ts isHomePath): treating it as home-relative would
// stat/resolve it under the operator's home while the literal path
// reaches herdr, so it fails loud at this boundary. machine labels
// are not checked against herdr's registry at parse time: a wrong
// label fails loud at the first herdr call.
export const delegationTargetSchema = z
	.object({
		machine: harnessNameSchema.optional(),
		session: sessionNameSchema.optional(),
		root: z
			.string()
			.regex(
				/^(?:\/|~(?:\/|$))/,
				"delegation target root must be absolute, ~, or ~/... (bare ~user is not expanded)",
			)
			.optional(),
		harnesses: harnessMapSchema.optional(),
	})
	.refine((t) => (t.machine !== undefined) !== (t.session !== undefined), {
		message:
			"a delegation target needs exactly one of machine (saved-machine label) or session (another local session)",
	});
export type DelegationTargetConfig = z.infer<typeof delegationTargetSchema>;

export const delegationConfigSchema = z.object({
	// No cap by design — volume is goblin's judgment, not a knob.
	machines: z.record(harnessNameSchema, delegationTargetSchema).optional(),
	harnesses: harnessMapSchema,
});
export type DelegationConfig = z.infer<typeof delegationConfigSchema>;

// A container image ref: no leading '-' and a conservative charset —
// the tool's podman argv boundary means a ref can never become a flag.
export const imageRefSchema = z
	.string()
	.min(1)
	.max(255)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/, "invalid image ref");

// Sandboxed execution (design/sandbox.md) — absent or "" = no sandbox
// tool. Goblin never pulls: `image` must already be in the local store.
export const sandboxConfigSchema = z.object({
	image: imageRefSchema.default("docker.io/library/alpine:latest"),
	// Hours of idleness before a sandbox is reaped on the next sandbox
	// call; 0 = never reap.
	idleHours: z.number().int().min(0).default(24),
	memory: z.string().min(1).default("2g"),
	cpus: z.number().positive().default(2),
	pids: z.number().int().min(16).default(512),
});
export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

// Gmail — absent = no mail tool or watcher. clientId is a public
// identifier, not a secret; the client secret and SEND token live in
// auth.jsonl; reads ride gws's auth — the send credential never reaches the model.
export const mailConfigSchema = z.object({
	clientId: z.string().min(1),
	clientSecretAuth: z.string().min(1),
	sendAuth: z.string().min(1),
});
export type MailConfig = z.infer<typeof mailConfigSchema>;

// Guest answering in third-party chats — absent = intake off entirely; hand-edited only.
export const guestConfigSchema = z.object({
	// One message per reply: the final edit truncates past this, pointing at the bot DM.
	outputChars: z.number().int().min(500).max(4000).default(3500),
});
export type GuestConfig = z.infer<typeof guestConfigSchema>;

// Automatic skill saving — absent = off. auth names the auth.jsonl
// record holding the OpenRouter key behind the System One gate.
export const reviewerEvidenceSchema = z.object({
	calls: z.number().int().min(1).max(32).default(8),
	argChars: z.number().int().min(50).max(4000).default(300),
	outChars: z.number().int().min(50).max(4000).default(300),
});
export const reviewerConfigSchema = z.object({
	threshold: z.number().min(0).max(1).default(0.8),
	thresholds: z
		.object({
			correction: z.number().min(0).max(1).optional(),
			procedure: z.number().min(0).max(1).optional(),
		})
		.optional(),
	queueCap: z.number().int().min(1).max(10).default(3),
	evidence: reviewerEvidenceSchema.prefault({}),
	model: z.string().min(1).optional(),
	auth: z.string().min(1),
});
export type ReviewerConfig = z.infer<typeof reviewerConfigSchema>;

// System One decisions — the switch and tuning for the shared client
// feeding the mail injection checker, the loop watchdog, and the DM
// follow-up check (the skill-review gate rides it too, but only
// `reviewer` enables that consumer). Set on its own it enables the
// client; absent, reviewer still implies it. Fields fall back to
// reviewer.auth/DEFAULT_MODEL.
// model is a bare decision-model id, NOT a "<provider>/<model-id>" chat
// ref — deliberately outside superRefine's provider validation.
export const system1ConfigSchema = z.object({
	auth: z.string().min(1),
	model: z.string().min(1).optional(),
	// z.url(), not a bare string: a typo must fail at load, not surface
	// later as a mislabeled transport failure riding the injection
	// checker's fail-open.
	baseUrl: z.url().optional(),
});
export type System1Config = z.infer<typeof system1ConfigSchema>;

export const ttsConfigSchema = z.object({
	kind: z.literal("edge"),
	voice: z.string().min(1),
	rate: z
		.string()
		.regex(/^[+-]\d+%$/)
		.optional(),
	// Language-cast voices: /voice and the 🔊 button pick by each
	// reply's language, falling back to `voice`.
	voices: z.array(z.string().min(1)).optional(),
});
export type TtsConfig = z.infer<typeof ttsConfigSchema>;

// Speech kinds — whistle (local) first, then the cloud menu
// (design/asr.md). config.test.ts pins this array against the union
// below in both directions, like providerKinds.
export const transcriptionKinds = [
	"whistle",
	"groq",
	"openai",
	"openrouter",
	"mistral",
	"elevenlabs",
	"gemini",
	"mimo",
] as const;

// Cloud-kind defaults — model is the UI's placeholder, auth defaults to
// the kind's own auth.jsonl record name. mimo rides openrouter because
// Xiaomi serves MiMo through OpenRouter; there is no first-party API.
export const transcriptionDefaults = {
	groq: { model: "whisper-large-v3-turbo", auth: "groq" },
	openai: { model: "gpt-4o-mini-transcribe", auth: "openai" },
	openrouter: { model: "openai/whisper-large-v3", auth: "openrouter" },
	mistral: { model: "mistralai/voxtral-mini-3b-2507", auth: "mistral" },
	elevenlabs: { model: "scribe_v2", auth: "elevenlabs" },
	gemini: { model: "gemini-flash-latest", auth: "gemini" },
	mimo: { model: "xiaomi/mimo-v2.6-flash", auth: "openrouter" },
} as const;

const transcriptionLanguage = z
	.string()
	.regex(/^[a-z]{2}$/, 'language must be an ISO-639-1 code like "es"');

const cloudTranscriptionSchema = (
	kind: "groq" | "openai" | "openrouter" | "mistral" | "elevenlabs" | "gemini" | "mimo",
) =>
	z.object({
		kind: z.literal(kind),
		model: z.string().min(1).default(transcriptionDefaults[kind].model),
		auth: z.string().min(1).default(transcriptionDefaults[kind].auth),
		language: transcriptionLanguage.optional(),
	});

export const transcriptionSchema = z.union([
	// Local engine — no model, no auth. engine/weights bypass the
	// digest-pinned auto-fetch for managed installs; keywords bias the
	// decoder toward names (the personal-assistant failure mode).
	z.object({
		kind: z.literal("whistle"),
		engine: z.string().min(1).optional(),
		weights: z.string().min(1).optional(),
		keywords: z.array(z.string().min(1)).max(100).optional(),
		language: z.enum(["en", "de", "fr", "es", "it", "nl", "pl"]).optional(),
	}),
	cloudTranscriptionSchema("groq"),
	cloudTranscriptionSchema("openai"),
	cloudTranscriptionSchema("openrouter"),
	cloudTranscriptionSchema("mistral"),
	cloudTranscriptionSchema("elevenlabs"),
	cloudTranscriptionSchema("gemini"),
	cloudTranscriptionSchema("mimo"),
]);

// Chain-entry kinds for search/fetch builders — config.test.ts pins
// both arrays against the unions below, like providerKinds.
export const searchKinds = [
	"brave",
	"exa",
	"jina",
	"tavily",
	"firecrawl",
	"parallel",
	"ddg",
] as const;

export const searchEntrySchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("brave"), auth: z.string().min(1).default(authDefaults.brave) }),
	z.object({ kind: z.literal("exa"), auth: z.string().min(1).default(authDefaults.exa) }),
	z.object({ kind: z.literal("jina"), auth: z.string().min(1).optional() }),
	z.object({ kind: z.literal("tavily"), auth: z.string().min(1).default(authDefaults.tavily) }),
	z.object({
		kind: z.literal("firecrawl"),
		auth: z.string().min(1).default(authDefaults.firecrawl),
	}),
	z.object({
		kind: z.literal("parallel"),
		auth: z.string().min(1).default(authDefaults.parallel),
	}),
	z.object({ kind: z.literal("ddg") }),
]);
export const fetchKinds = ["local", "jina", "tavily", "firecrawl", "parallel"] as const;

export const fetchEntrySchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("local") }),
	z.object({ kind: z.literal("jina"), auth: z.string().min(1).optional() }),
	z.object({ kind: z.literal("tavily"), auth: z.string().min(1).default(authDefaults.tavily) }),
	z.object({
		kind: z.literal("firecrawl"),
		auth: z.string().min(1).default(authDefaults.firecrawl),
	}),
	z.object({
		kind: z.literal("parallel"),
		auth: z.string().min(1).default(authDefaults.parallel),
	}),
]);

const configSchema = z
	.object({
		providers: z.record(z.string(), providerSchema),
		// Default for new app conversations only — Telegram owns its own selection.
		model: z.string().min(1),
		// Auto-titling model for implicitly-named topics; "" = unset
		// (mini-app clearing convention).
		titleModel: z
			.union([z.string().min(1), z.literal("")])
			.transform((v) => v || undefined)
			.optional(),
		favorites: z.array(z.string()).default([]),
		thinking: z.enum(thinkingLevels).default("medium"),
		// Absent → edge with the default voice. "" is explicit off and
		// parses to `false`, not undefined — an undefined key would be
		// dropped by the mini app's whole-file rewrite and reload as on.
		tts: z
			.union([ttsConfigSchema, z.literal(""), z.literal(false)])
			.optional()
			.transform((v) =>
				v === undefined
					? { kind: "edge" as const, voice: DEFAULT_TTS_VOICE }
					: v === "" || v === false
						? false
						: v,
			),
		// Speech → text: voice/video notes at intake, other audio via the
		// transcribe tool. The kinds and their defaults live above
		// (design/asr.md).
		transcription: z
			.union([transcriptionSchema, z.literal("")])
			.transform((v) => (v === "" ? undefined : v))
			.optional(),
		// Live-read per turn — changes apply without a restart.
		vision: z
			.union([visionConfigSchema, z.literal("")])
			.transform((v) => (v === "" ? undefined : v))
			.optional(),
		// One entry or an ordered fallback chain (first is primary). Only
		// transport/HTTP/auth failures advance the chain — an empty result
		// set is an answer.
		search: z
			.union([searchEntrySchema, z.array(searchEntrySchema).min(1), z.literal("")])
			.transform((v) => (v === "" ? undefined : Array.isArray(v) ? v : [v]))
			.optional(),
		// Same one-or-chain shape as search; absent or "" → local fetch.
		fetch: z
			.union([fetchEntrySchema, z.array(fetchEntrySchema).min(1), z.literal("")])
			.transform((v) => (v === "" ? undefined : Array.isArray(v) ? v : [v]))
			.optional(),
		// Two-list trust (design/telegram.md → Roles and permissions):
		// operators get the personal agent on every surface; allowedUsers
		// get the sandbox class. Anyone on neither list is a stranger —
		// one refusal line per summons, nothing else.
		operators: z.array(z.number().int().positive()).min(1),
		allowedUsers: z.array(z.number().int().positive()).default([]),
		// apiRoot: self-hosted telegram-bot-api in --local mode. dmGapMinutes:
		// the Rolling DM quiet gap — read live, applies immediately.
		telegram: z
			.object({
				// Absent here → pinned to the top-level model/thinking below.
				model: z.string().min(1).optional(),
				thinking: z.enum(thinkingLevels).optional(),
				// "" = the form's explicit clear (publicUrl's convention). A body
				// key that is absent keeps the saved root, so only "" can clear.
				apiRoot: z
					.union([z.url(), z.literal("")])
					.transform((v) => v || undefined)
					.optional(),
				dmGapMinutes: z.number().int().min(1).default(45),
				// Rich replies (Bot API 10.3): draft streaming and one markdown
				// render per DM turn. A kill switch, not a feature flag — a
				// phone-only operator needs config off, not a redeploy
				// (design/telegram.md, "Formatted replies & draft streaming").
				richReplies: z.boolean().default(true),
				// Reasoning as a collapsed block above the reply. DMs only;
				// guests never see it regardless.
				showReasoning: z.boolean().default(false),
			})
			.default({ dmGapMinutes: 45, richReplies: true, showReasoning: false }),
		// External HTTPS door for mini apps — nothing in-process assumes
		// a public IP. "" = unset (the form can't express undefined).
		publicUrl: z
			.union([
				z
					.url()
					.refine(
						(url) => URL.canParse(url) && new URL(url).protocol === "https:",
						"Public URL must use HTTPS for Telegram Web Apps",
					),
				z.literal(""),
			])
			.transform((v) => v || undefined)
			.optional(),
		http: z
			.object({ port: z.number().int().min(0).max(65535).default(8787) })
			.default({ port: 8787 }),
		logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
		memory: z
			.union([memoryConfigSchema, z.literal("")])
			.transform((v) => (v === "" ? undefined : v))
			.optional(),
		// Hand-edited only; a mini-app save round-trips it through the merge untouched.
		delegation: delegationConfigSchema.optional(),
		// Hand-edited only, like delegation.
		mail: mailConfigSchema.optional(),
		// Sandboxed execution — hand-edited only; live-read per turn so a
		// save mounts/unmounts the tool on the next turn.
		sandbox: z
			.union([sandboxConfigSchema, z.literal("")])
			.transform((v) => (v === "" ? undefined : v))
			.optional(),
		guest: guestConfigSchema.optional(),
		reviewer: reviewerConfigSchema.optional(),
		system1: system1ConfigSchema.optional(),
		// Live-read per turn like vision; "" clears (hand-edited only — the
		// mini app round-trips it through the merge untouched).
		scripting: z
			.union([scriptingConfigSchema, z.literal("")])
			.transform((v) => (v === "" ? undefined : v))
			.optional(),
		// auth.jsonl record NAME — the token value never sits in this
		// file. Absent = trust mode: /api/app/* unauthenticated, the
		// tailnet is the only lock. Boot-pinned; a flip needs a restart.
		appToken: z.string().min(1).optional(),
	})
	.transform((cfg) => {
		// Normalize before merging/writing: changing app defaults must not
		// silently change Telegram on a legacy config's first save.
		cfg.telegram.model ??= cfg.model;
		cfg.telegram.thinking ??= cfg.thinking;
		return cfg;
	})
	.superRefine((cfg, ctx) => {
		for (const [path, ref] of [
			["model", cfg.model],
			["telegram.model", cfg.telegram.model],
			["titleModel", cfg.titleModel],
			["reviewer.model", cfg.reviewer?.model],
			["vision.model", cfg.vision?.model],
		] as const) {
			if (ref === undefined) continue;
			let provider: string;
			try {
				provider = splitModelRef(ref).provider;
			} catch {
				ctx.addIssue({
					code: "custom",
					path: path.split("."),
					message: 'model ref must be "<provider>/<model-id>"',
				});
				continue;
			}
			if (!(provider in cfg.providers)) {
				ctx.addIssue({
					code: "custom",
					path: path.split("."),
					message: "model names a provider which is not in providers",
				});
			}
		}
	});

export type ProviderConfig = z.infer<typeof providerSchema>;
export type Config = z.infer<typeof configSchema>;
export type TranscriptionConfig = NonNullable<Config["transcription"]>;

// ttsDown is decided once, at boot (ffmpeg probe) — a config mutation
// instead would leak into the mini app's round-trip as an operator "off".
export interface ConfigRef {
	current: Config;
	ttsDown: boolean;
}
export type SearchConfig = NonNullable<Config["search"]>;
export type FetchConfig = NonNullable<Config["fetch"]>;

// ---------- load / write ----------

// ENOENT → null; every other failure propagates with the path attached.
export function loadConfig(): Config | null {
	let raw: string;
	try {
		raw = readFileSync(paths.config(), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON5.parse(raw);
	} catch (err) {
		// JSON5 messages quote input. Only its numeric location is safe to retain.
		const line =
			typeof err === "object" && err !== null && "lineNumber" in err ? err.lineNumber : undefined;
		const location =
			typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? `:${line}` : "";
		throw new Error(`${paths.config()}${location}: invalid JSON5`);
	}
	let config: Config;
	try {
		config = parseConfig(parsed);
	} catch (error) {
		if (error instanceof ConfigValidationError) throw new Error(error.message);
		throw error;
	}
	const retired = z
		.object({ delegation: z.record(z.string(), z.unknown()).optional() })
		.parse(parsed);
	for (const [key, replacement] of Object.entries({
		machine: "delegation.machines.<label>.machine (and root for remote paths)",
		session: "delegation.machines.<label>.session; the own local session is fixed by the service",
		maxRunning: "no replacement — delegation concurrency is not capped by config",
	})) {
		if (retired.delegation !== undefined && Object.hasOwn(retired.delegation, key)) {
			log.warn("retired delegation config key ignored", {
				path: paths.config(),
				key: `delegation.${key}`,
				replacement,
			});
		}
	}
	return config;
}

// HTTP callers must distinguish invalid edits (422) from I/O failures (500)
// without retaining Zod's input-bearing payload.
export class ConfigValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigValidationError";
	}
}

// Retired delegation keys strip here; only disk loads warn.
export function parseConfig(raw: unknown): Config {
	const result = configSchema.safeParse(raw);
	if (!result.success) {
		// Nested record keys and issue messages may contain input. Report only
		// schema-owned top-level fields and categories, not the ZodError itself.
		const details = result.error.issues.map((issue) => {
			const field = issue.path[0];
			const safeField =
				typeof field === "string" && Object.hasOwn(configSchema.in.shape, field) ? field : "config";
			return `${safeField}: ${issue.code}`;
		});
		throw new ConfigValidationError(`${paths.config()}: invalid config — ${details.join("; ")}`);
	}
	return result.data;
}

// A hardened mode on the existing file survives this whole-file rewrite.
export function writeConfig(config: Config): void {
	durableWriteFile(paths.config(), JSON5.stringify(parseConfig(config), null, 2) + "\n");
}

// Split "<provider>/<model-id>" — model IDs themselves contain slashes
// (openrouter's "anthropic/claude-sonnet-4.5"), so split on the first only.
export function splitModelRef(ref: string): { provider: string; modelId: string } {
	const idx = ref.indexOf("/");
	if (idx <= 0 || idx === ref.length - 1) {
		throw new Error('model ref must be "<provider>/<model-id>"');
	}
	return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

// Auth record names goblin resolves at boot ("telegram" is implicit).
// Single source for the doctor's preflight gate and the installer's
// warm-target rendering — deriving the set twice is how they drift.
export function authReferences(config: Config): Set<string> {
	const refs = new Set<string>(["telegram"]);
	for (const provider of Object.values(config.providers))
		if ("auth" in provider) refs.add(provider.auth);
	for (const feature of [
		config.memory,
		config.transcription,
		config.reviewer,
		config.system1,
		...(config.search ?? []),
		...(config.fetch ?? []),
	])
		if (feature && "auth" in feature && feature.auth) refs.add(feature.auth);
	if (config.appToken) refs.add(config.appToken);
	if (config.mail) {
		refs.add(config.mail.clientSecretAuth);
		refs.add(config.mail.sendAuth);
	}
	return refs;
}
