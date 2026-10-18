// Boot-pinned config keys (DESIGN.md → config writes): these blocks
// bind at boot — adapters, endpoints, auth refs and pool limits are
// one snapshot — so a mid-run change is a warn + restart, never a
// hot-apply. One comparison serves the config-write log warns and the
// operator status card's restart hints; callers map the bare key to
// their own label.

import type { Config, ConfigRef } from "./config.ts";
import { log, setLogLevel } from "./log.ts";

export interface BootPins {
	memory: Config["memory"];
	/** Resolved auth name — the appToken name, not the secret. */
	appToken: string | undefined;
	apiRoot: Config["telegram"]["apiRoot"];
	delegation: Config["delegation"];
	subagents: Config["subagents"];
}

const eq = (a: unknown, b: unknown): boolean =>
	JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function bootPinnedDiffs(pins: BootPins, cur: Config): string[] {
	const diffs: string[] = [];
	if (!eq(cur.memory, pins.memory)) diffs.push("memory");
	if (cur.appToken !== pins.appToken) diffs.push("appToken");
	if (cur.telegram.apiRoot !== pins.apiRoot) diffs.push("telegram.apiRoot");
	if (!eq(cur.delegation, pins.delegation)) diffs.push("delegation");
	if (!eq(cur.subagents, pins.subagents)) diffs.push("subagents");
	return diffs;
}

// Warn-line labels for the diff keys — the diff returns bare keys; the
// log line names the block.
const PIN_LABEL: Record<string, string> = {
	memory: "memory config",
	delegation: "delegation config",
	subagents: "subagents config",
};

/** The sandbox block counts as configured only as an object — a bare
 *  `false` disables without counting. */
export const sandboxConfigured = (c: Config): boolean => typeof c.sandbox === "object";

// ---------- the post-write reconcile ----------

// One post-write path for every config door: hot-apply what's live,
// warn on what's boot-pinned. Search/transcription flips redraw the
// registered tool set — a cache boundary (DESIGN.md → Web access) — so
// each flip gets its own log line; the sandbox flip warns about
// stranded containers (a removed block can't reap them).
export interface ConfigWriteDeps {
	configRef: ConfigRef;
	/** Boot snapshot — the flip baselines and the pin diffs read against it. */
	boot: Config;
	pins: BootPins;
	/** Re-render the Telegram menu button — operator-editable publicUrl
	 *  hot-applies without a restart. tg-owned, injected. */
	syncMenuButton(): void;
	warnStrandedSandboxes(): void;
}

export interface ConfigWrite {
	/** The one post-write reconcile: hot-apply + flip logs + pin warns. */
	onConfigWritten(): void;
	/** The same pin diffs as bare keys — the status card's restart hints. */
	restartHints(): string[];
}

export function wireConfigWrite(deps: ConfigWriteDeps): ConfigWrite {
	const { configRef, boot, pins } = deps;
	let searchInSet = boot.search !== undefined;
	let transcribeInSet = boot.transcription !== undefined;
	let sandboxInSet = sandboxConfigured(boot);
	return {
		onConfigWritten() {
			const cur = configRef.current;
			setLogLevel(cur.logLevel);
			deps.syncMenuButton();
			const searchNow = cur.search !== undefined;
			if (searchNow !== searchInSet) {
				log.info(
					searchNow
						? "search tool enabled — joins the set next turn"
						: "search tool disabled — leaves the set next turn",
				);
				searchInSet = searchNow;
			}
			const transcribeNow = cur.transcription !== undefined;
			if (transcribeNow !== transcribeInSet) {
				log.info(
					transcribeNow
						? "transcribe tool enabled — joins the set next turn"
						: "transcribe tool disabled — leaves the set next turn",
				);
				transcribeInSet = transcribeNow;
			}
			const sandboxNow = sandboxConfigured(cur);
			if (sandboxInSet && !sandboxNow) deps.warnStrandedSandboxes();
			sandboxInSet = sandboxNow;
			// Memory is a boot-time snapshot (queue rows bind to the
			// endpoint+bank hash); delegation and subagents are boot-frozen
			// adapters and pool limits — all warned by the shared pin diff.
			for (const key of bootPinnedDiffs(pins, cur)) {
				log.warn(`${PIN_LABEL[key] ?? key} changed — restart to apply`);
			}
		},
		restartHints: () => bootPinnedDiffs(pins, configRef.current),
	};
}
