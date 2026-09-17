// goblin.json5 — the only config file. Providers, models, defaults.
// No secrets here; those live in auth.jsonl. The mini app is the
// operator-facing editing surface; hand-editing always works.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import { z } from "zod";
import { durableWriteFile } from "./durable.ts";

// ---------- paths ----------

export function goblinHome(): string {
	return process.env.GOBLIN_HOME ?? join(homedir(), "goblin");
}

export const paths = {
	config: () => join(goblinHome(), "goblin.json5"),
	auth: () => join(goblinHome(), "auth.jsonl"),
	workspace: () => join(goblinHome(), "workspace"),
	soul: () => join(goblinHome(), "workspace", "SOUL.md"),
	agents: () => join(goblinHome(), "workspace", "AGENTS.md"),
	attachments: () => join(goblinHome(), "workspace", "attachments"),
	state: () => join(goblinHome(), "state"),
	db: () => join(goblinHome(), "state", "goblin.sqlite"),
	modelsDevCache: () => join(goblinHome(), "state", "models.dev.json"),
};

export function ensureHomeLayout(): void {
	for (const dir of [goblinHome(), paths.workspace(), paths.attachments(), paths.state()]) {
		mkdirSync(dir, { recursive: true });
	}
	// SOUL.md is required — template-created on first boot.
	if (!existsSync(paths.soul())) {
		durableWriteFile(
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
			0o644,
		);
	}
}

// ---------- schema ----------

const providerSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("openai-compatible"),
		baseUrl: z.url(),
		auth: z.string().min(1),
	}),
	z.object({
		kind: z.literal("openrouter"),
		auth: z.string().min(1),
	}),
]);

export const thinkingLevels = ["off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

const configSchema = z
	.object({
		providers: z.record(z.string(), providerSchema),
		// "<provider>/<model-id>" — provider must exist in `providers`.
		model: z.string().min(1),
		favorites: z.array(z.string()).default([]),
		thinking: z.enum(thinkingLevels).default("medium"),
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
	})
	// Cross-field: the model ref must parse and name a configured provider.
	.superRefine((cfg, ctx) => {
		let provider: string;
		try {
			provider = splitModelRef(cfg.model).provider;
		} catch (err) {
			ctx.addIssue({ code: "custom", path: ["model"], message: (err as Error).message });
			return;
		}
		if (!(provider in cfg.providers)) {
			ctx.addIssue({
				code: "custom",
				path: ["model"],
				message: `model "${cfg.model}" names provider "${provider}", which is not in providers`,
			});
		}
	});

export type ProviderConfig = z.infer<typeof providerSchema>;
export type Config = z.infer<typeof configSchema>;

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
	const result = configSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(`${paths.config()}: ${z.prettifyError(result.error)}`);
	}
	return result.data;
}

// Validate a candidate config — the mini app parses before writing so it
// can inspect the result (e.g. refuse a self-lockout) without touching
// the file first.
export function parseConfig(raw: unknown): Config {
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
