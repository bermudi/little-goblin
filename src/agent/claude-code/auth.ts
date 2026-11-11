// The SDK child's environment. The OAuth token resolves from the
// auth.jsonl record and enters ONLY the child's env (Options.env
// replaces the child environment entirely — vendor-verified in the
// Phase 0 spike); it never lands in goblin's own process env, where
// the script tool and every spawned tool would inherit it.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuthStore } from "../../auth.ts";
import { paths } from "../../config.ts";
import { log } from "../../log.ts";

export interface ClaudeChildEnv {
	env: Record<string, string>;
	configDir: string;
	/**
	 * The child's cwd, stable across releases: the SDK files sessions
	 * under `<config>/projects/<sanitized-cwd>/` and prod's
	 * WorkingDirectory changes per deploy — a cwd keyed to it would
	 * orphan every recorded session on release (#418). Built-in CLI
	 * tools are off (`tools: []`, `settingSources: []`), so cwd has no
	 * other effect.
	 */
	workdir: string;
}

export async function claudeChildEnv(
	auth: AuthStore,
	record: string,
	configDir = paths.claudeCodeState(),
): Promise<ClaudeChildEnv> {
	// Rejects loud when the record is missing or its !command fails —
	// buildStep's contract (a configured model must resolve or the turn
	// fails with the cause, never a silent fallback).
	const token = await auth.resolve(record);
	// The session workdir lives beside the config dir so both derive
	// from the one base — engine.configDir overrides move them together.
	const workdir = join(configDir, "workdir");
	try {
		mkdirSync(configDir, { recursive: true });
		mkdirSync(workdir, { recursive: true });
	} catch (err) {
		log.error("claude-code config dir unavailable", err, { configDir });
		throw err;
	}
	return {
		workdir,
		env: {
			PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/bin",
			HOME: process.env.HOME ?? "/root",
			// All child state (config, session scratch, telemetry ids) lands
			// under goblin's state tree — nothing touches ~/.claude. Verified
			// by the Phase 0 spike: with this set, the child wrote only inside
			// the config dir.
			CLAUDE_CONFIG_DIR: configDir,
			CLAUDE_CODE_OAUTH_TOKEN: token,
			// Releases are immutable and this box is headless — no updater,
			// no nonessential phone-home traffic.
			DISABLE_AUTOUPDATER: "1",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		},
		configDir,
	};
}
