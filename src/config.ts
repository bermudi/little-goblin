// goblin.json5 — the only config file. Providers, models, defaults.
// No secrets here; those live in auth.jsonl. The mini app is the
// operator-facing editing surface; hand-editing always works.

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
	workspace: () => join(goblinHome(), "workspace"),
	soul: () => join(goblinHome(), "workspace", "SOUL.md"),
	agents: () => join(goblinHome(), "workspace", "AGENTS.md"),
	user: () => join(goblinHome(), "workspace", "USER.md"),
	skills: () => join(goblinHome(), "workspace", "skills"),
	attachments: () => join(goblinHome(), "workspace", "attachments"),
	state: () => join(goblinHome(), "state"),
	db: () => join(goblinHome(), "state", "goblin.sqlite"),
	logFile: () => join(goblinHome(), "state", "goblin.log"),
	delegations: () => join(goblinHome(), "state", "delegations"),
	modelsDevCache: () => join(goblinHome(), "state", "models.dev.json"),
	openrouterModelsCache: () => join(goblinHome(), "state", "openrouter-models.json"),
	webcache: () => join(goblinHome(), "state", "webcache"),
	mailcache: () => join(goblinHome(), "state", "mail"),
};

export function ensureHomeLayout(): void {
	for (const dir of [goblinHome(), paths.workspace(), paths.skills(), paths.attachments(), paths.state()]) {
		mkdirSync(dir, { recursive: true });
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
			"- Operator says \"remember this\" → it goes here.",
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
	// Repo-shipped skills (DESIGN.md, "Web access" and "Auth → Proton
	// Pass"): their compatibility lines carry the dependency + recovery
	// command into the system prompt's catalog, and a rebuilt box
	// regains the whole capability — stub, modes, recovery — without
	// operator prompting or agent memory. Write-if-absent: once seeded,
	// each workspace copy is goblin's to evolve.
	for (const skill of ["browser", "pass-cli", "mcp"]) {
		mkdirSync(join(paths.skills(), skill), { recursive: true });
		const template = readFileSync(
			join(import.meta.dir, "..", "deploy", "skills", skill, "SKILL.md"),
			"utf8",
		);
		seedFile(join(paths.skills(), skill, "SKILL.md"), template);
	}
	// Goblin's own MCP servers (DESIGN.md, "Web access" → "MCP"): the
	// server set is config, not code, so a fresh home starts empty. The
	// seed carries `"imports": []` — without it mcporter merges the
	// operator's editor servers, and the call-time gate refuses anything
	// else. Write-if-absent like the skills: the operator's (and
	// goblin's) server set is never clobbered.
	seedFile(
		paths.mcporter(),
		[
			"{",
			'\t// Goblin\'s own MCP servers (DESIGN.md, "Web access" → "MCP").',
			"\t// Secrets are ${VAR} placeholders only — values ride the",
			"\t// goblin-mcp-dev pass-keys profile into mcporter's child env,",
			"\t// never this file. \"imports\" MUST stay []: without it",
			"\t// mcporter merges the operator's editor servers, and the",
			"\t// call-time gate refuses anything else.",
			'\t"mcpServers": {},',
			'\t"imports": []',
			"}",
			"",
		].join("\n"),
	);
	refreshMcpShim();
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

// First-boot scaffolding: create if (and only if) absent — an operator's
// hand or the agent's own edits are never clobbered. The AGENTS.md stub
// exists because a standing instruction ("you own AGENTS.md") is not a
// mechanism: a model edits a file it can see in its prompt head every
// turn, but won't create one out of nothing — the stub carries the
// growth rule where it's read every turn.
function seedFile(path: string, content: string): void {
	if (existsSync(path)) return;
	durableWriteFile(path, content, 0o644);
}

// The `mcp` entry point (DESIGN.md, "Web access" → "MCP"): goblin's bash
// runs in the workspace, which can't see the repo — so scripts/mcp is
// reachable as $GOBLIN_HOME/mcp. A symlink, not a copy, so repo updates
// propagate: repointed every boot when it already is a link (a repo move
// heals itself), never clobbering a real file — that refuses loud and
// leaves boot running, since the skill without its shim is a degraded
// capability, not a crash loop.
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

// ---------- schema ----------

// The kinds the mini app's provider form may offer, in schema order.
// Single source: the schema literals below are what actually parses —
// config.test.ts pins this array against them in both directions
// (schema-only kind → settings UI can't render/save it; array-only
// kind → the UI offers what the config rejects). The config GET
// serves it to the page (http/mod.ts, ConfigResponse).
export const providerKinds = ["openai-compatible", "responses", "openrouter", "codex"] as const;

export const providerSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("openai-compatible"),
		baseUrl: z.url(),
		auth: z.string().min(1),
	}),
	// OpenAI Responses protocol — the one chat-family protocol whose
	// tool outputs carry documents (function_call_output content arrays).
	// z.ai serves it at https://api.z.ai/api/v1 (devpack endpoint table);
	// probe-verified 2026-09-27: input_file in user messages AND in tool
	// outputs both parse (glm-5.3-flash read a marker PDF through each).
	z.object({
		kind: z.literal("responses"),
		baseUrl: z.url(),
		auth: z.string().min(1),
	}),
	z.object({
		kind: z.literal("openrouter"),
		auth: z.string().min(1),
	}),
	z.object({
		kind: z.literal("codex"),
		// Codex CLI OAuth file (~/.codex/auth.json when unset) — read and
		// refreshed in-process; it is not an auth.jsonl record.
		authFile: z.string().min(1).optional(),
	}),
]);

export const thinkingLevels = [
	"off",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

// Optional long-term memory (DESIGN.md, Slice 2 rulings). Absent =
// disabled, exact current behavior. baseUrl/bankId reuse the Hindsight
// connection validation as the single source; auth names an auth.jsonl
// secret for the Bearer token (loopback needs none). Recall bounds are
// tight by default — turns must not wait on memory.
export const memoryConfigSchema = z.object({
	baseUrl: hindsightConnectionSchema.shape.baseUrl,
	bankId: hindsightConnectionSchema.shape.bankId,
	auth: z.string().min(1).optional(),
	recallTimeoutMs: z.number().int().min(100).max(10_000).default(2000),
	maxTokens: z.number().int().min(1).max(8192).default(1024),
	budget: z.enum(["low", "mid", "high"]).default("low"),
});
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;

// Edge read-aloud (DESIGN.md, Delivery/TTS) — no auth, unofficial, can
// break. Default-on: the only dependency is ffmpeg, probed at boot.
export const DEFAULT_TTS_VOICE = "en-US-AriaNeural";

// Delegation to external coding harnesses via herdr (DESIGN.md,
// "Delegation"). Absent = the delegate tool is not in the set. Harnesses
// are named operator choices — a herdr agent kind plus native args;
// goblin never picks a model or flags for one. Harness names double as
// herdr agent-name prefixes, so they live in herdr's name charset.
export const delegationConfigSchema = z.object({
	// No `session` knob: the herdr session name is fixed by the unit
	// (deploy/goblin-herdr.service: `herdr --session goblin server`) — the
	// single source of truth. A config override could target a session
	// the unit does not host, so consumers use the literal "goblin".
	maxRunning: z.number().int().min(1).default(3),
	harnesses: z
		.record(
			z.string().regex(/^[a-z][a-z0-9_-]{0,15}$/),
			z.object({
				kind: z.string().min(1),
				args: z.array(z.string()).optional(),
			}),
		)
		.refine((h) => Object.keys(h).length > 0, {
			message: "delegation.harnesses must name at least one harness",
		}),
});
export type DelegationConfig = z.infer<typeof delegationConfigSchema>;

// Gmail (DESIGN.md, "Email"). Absent = no mail tool, no mail watcher.
// clientId is the Google Cloud OAuth client ID — a public identifier,
// not a secret. The client secret and both refresh tokens live in
// auth.jsonl under these names: split scopes, so the read credential
// cannot send and the send credential never reaches the model.
export const mailConfigSchema = z.object({
	clientId: z.string().min(1),
	clientSecretAuth: z.string().min(1),
	readAuth: z.string().min(1),
	sendAuth: z.string().min(1),
});
export type MailConfig = z.infer<typeof mailConfigSchema>;

// Automatic skill saving (DESIGN.md, "Skill reviewer"). Absent = off.
// auth names the auth.jsonl record holding the OpenRouter key behind
// the Jev gate; model overrides the review model (default: the
// conversation's own model); threshold is the gate's shared review
// cutoff, overridable per question by thresholds; queueCap bounds the
// queued (not running) reviews — a full queue drops the incoming;
// evidence bounds the tool-call digest the review sees.
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

export const ttsConfigSchema = z.object({
	kind: z.literal("edge"),
	voice: z.string().min(1),
	rate: z.string().regex(/^[+-]\d+%$/).optional(),
	// The cast beyond the default voice — language follows the voice
	// name. The speak tool picks per call; /voice mode and the 🔊 button
	// sniff each reply's language and cast the matching voice, falling
	// back to `voice` when nothing matches.
	voices: z.array(z.string().min(1)).optional(),
});
export type TtsConfig = z.infer<typeof ttsConfigSchema>;

// One web provider selection. Search and fetch each accept one of
// these or an ordered list of them (DESIGN.md, "Web access") — the
// list is the fallback chain, config order, first entry primary.
// The chain-entry kinds the mini app's search/fetch builders may offer,
// in schema order. Same single-source contract as providerKinds —
// config.test.ts pins both against the unions below.
export const searchKinds = ["brave", "exa", "jina", "tavily", "firecrawl", "parallel", "ddg"] as const;

export const searchEntrySchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("brave"), auth: z.string().min(1) }),
	z.object({ kind: z.literal("exa"), auth: z.string().min(1) }),
	z.object({ kind: z.literal("jina"), auth: z.string().min(1).optional() }),
	z.object({ kind: z.literal("tavily"), auth: z.string().min(1) }),
	z.object({ kind: z.literal("firecrawl"), auth: z.string().min(1) }),
	z.object({ kind: z.literal("parallel"), auth: z.string().min(1) }),
	z.object({ kind: z.literal("ddg") }),
]);
export const fetchKinds = ["local", "jina", "tavily", "firecrawl", "parallel"] as const;

export const fetchEntrySchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("local") }),
	z.object({ kind: z.literal("jina"), auth: z.string().min(1).optional() }),
	z.object({ kind: z.literal("tavily"), auth: z.string().min(1) }),
	z.object({ kind: z.literal("firecrawl"), auth: z.string().min(1) }),
	z.object({ kind: z.literal("parallel"), auth: z.string().min(1) }),
]);

const configSchema = z
	.object({
		providers: z.record(z.string(), providerSchema),
		// "<provider>/<model-id>" — provider must exist in `providers`.
		model: z.string().min(1),
		// Optional model for auto-titling implicitly-named topics. "" means
		// unset (mini-app clearing convention); absent/"" = placeholders stay.
		titleModel: z
			.union([z.string().min(1), z.literal("")])
			.transform((v) => v || undefined)
			.optional(),
		favorites: z.array(z.string()).default([]),
		thinking: z.enum(thinkingLevels).default("medium"),
		// Default-on (no keys — the only dependency is ffmpeg): absent →
		// edge with the default voice. `""` is the explicit off and
		// parses to `false` so it survives the mini app's whole-file
		// rewrite — an undefined key would be dropped and reload as on.
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
		// Speech → text: voice/video notes at intake, other audio on
		// demand via the transcribe tool. "" means unset (mini-app
		// clearing convention).
		transcription: z
			.union([
				z.object({
					kind: z.literal("groq"),
					model: z.string().min(1).default("whisper-large-v3-turbo"),
					auth: z.string().min(1),
				}),
				z.literal(""),
			])
			.transform((v) => (v === "" ? undefined : v))
			.optional(),
		// Web search providers (DESIGN.md, "Web access"). Absent or "" →
		// the search tool is not in the set. One entry or an ordered list:
		// first is primary, the rest are explicit fallbacks (transport/
		// HTTP/auth failures advance; an empty result set is an answer).
		// ddg is keyless; jina tolerates keyless (rate-limited); every
		// other kind requires an auth ref.
		search: z
			.union([searchEntrySchema, z.array(searchEntrySchema).min(1), z.literal("")])
			.transform((v) => (v === "" ? undefined : Array.isArray(v) ? v : [v]))
			.optional(),
		// Fetch/extract providers (DESIGN.md, "Web access"). Same shape
		// rule as search: one entry or an ordered chain. Absent or "" →
		// local (direct HTTP + in-process readability extraction).
		fetch: z
			.union([fetchEntrySchema, z.array(fetchEntrySchema).min(1), z.literal("")])
			.transform((v) => (v === "" ? undefined : Array.isArray(v) ? v : [v]))
			.optional(),
		allowedUsers: z.array(z.number().int().positive()).min(1),
		// Self-hosted telegram-bot-api in --local mode, e.g. http://127.0.0.1:8081.
		// Absent = default api.telegram.org.
		telegram: z.object({ apiRoot: z.url().optional() }).default({}),
		// External HTTPS door for mini apps (tailscale serve/funnel, reverse
		// proxy). Nothing in-process assumes a public IP. "" means unset —
		// the settings form can't express undefined over JSON.
		publicUrl: z
			.union([z.url(), z.literal("")])
			.transform((v) => v || undefined)
			.optional(),
		http: z
			.object({ port: z.number().int().min(0).max(65535).default(8787) })
			.default({ port: 8787 }),
		logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
		// Optional long-term memory — "" clears to unset (mini-app
		// clearing convention, like tts/transcription).
		memory: z
			.union([memoryConfigSchema, z.literal("")])
			.transform((v) => (v === "" ? undefined : v))
			.optional(),
		// Optional delegation to external harnesses — no mini-app
		// surface, hand-edited only; a mini-app save round-trips it
		// through the merge untouched.
		delegation: delegationConfigSchema.optional(),
		// Optional Gmail — same hand-edited-only rule as delegation.
		mail: mailConfigSchema.optional(),
		// Optional automatic skill saving — same hand-edited-only rule.
		reviewer: reviewerConfigSchema.optional(),
	})
	// Cross-field: every model ref must parse and name a configured provider.
	.superRefine((cfg, ctx) => {
		for (const [path, ref] of [
			["model", cfg.model],
			["titleModel", cfg.titleModel],
			["reviewer.model", cfg.reviewer?.model],
		] as const) {
			if (ref === undefined) continue;
			let provider: string;
			try {
				provider = splitModelRef(ref).provider;
			} catch (err) {
				ctx.addIssue({ code: "custom", path: [path], message: (err as Error).message });
				continue;
			}
			if (!(provider in cfg.providers)) {
				ctx.addIssue({
					code: "custom",
					path: [path],
					message: `model "${ref}" names provider "${provider}", which is not in providers`,
				});
			}
		}
	});

export type ProviderConfig = z.infer<typeof providerSchema>;
export type Config = z.infer<typeof configSchema>;
export type TranscriptionConfig = NonNullable<Config["transcription"]>;

// The shared config handle plus boot-time liveness gates. ttsDown is
// decided once, at boot (ffmpeg probe): a config mutation instead would
// leak into the mini app's round-trip as an explicit operator "off".
// Install ffmpeg and restart to re-enable.
export interface ConfigRef {
	current: Config;
	ttsDown: boolean;
}
export type SearchConfig = NonNullable<Config["search"]>;
export type FetchConfig = NonNullable<Config["fetch"]>;

// ---------- load / write ----------

// ENOENT → null (caller decides; index.ts exits with a pointer to the
// example). Parse/validation failures propagate with the file path attached.
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
		throw new Error(`${paths.config()}: invalid JSON5 — ${(err as Error).message}`);
	}
	warnLegacyDelegationSession(parsed);
	const result = configSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(`${paths.config()}: ${z.prettifyError(result.error)}`);
	}
	return result.data;
}

// Validate a candidate config — the mini app parses before writing so it
// can inspect the result (e.g. refuse a self-lockout) without touching
// the file first.
// A legacy `delegation.session` strips silently under zod — a box that
// relied on the knob must learn where the session lives now (the unit
// file), not discover delegation broken by surprise. Both load paths
// (parseConfig and loadConfig) check it before validation.
function warnLegacyDelegationSession(raw: unknown): void {
	if (typeof raw === "object" && raw !== null) {
		const delegation = (raw as Record<string, unknown>).delegation;
		if (typeof delegation === "object" && delegation !== null && "session" in delegation) {
			log.warn(
				"delegation.session is gone — the herdr session is fixed by deploy/goblin-herdr.service (--session goblin); the key is ignored",
			);
		}
	}
}

export function parseConfig(raw: unknown): Config {
	warnLegacyDelegationSession(raw);
	return configSchema.parse(raw);
}

// The mini app writes through here. Whole-file durable write; a hardened
// mode on the existing file survives the rewrite.
export function writeConfig(config: Config): void {
	durableWriteFile(paths.config(), JSON5.stringify(parseConfig(config), null, 2) + "\n");
}

// Split "<provider>/<model-id>" — model IDs themselves contain slashes
// (openrouter's "anthropic/claude-sonnet-4.5"), so split on the first only.
export function splitModelRef(ref: string): { provider: string; modelId: string } {
	const idx = ref.indexOf("/");
	if (idx <= 0 || idx === ref.length - 1) {
		throw new Error(`model ref must be "<provider>/<model-id>", got "${ref}"`);
	}
	return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}
