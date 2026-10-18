// Boot-pinned config keys (DESIGN.md → config writes): these blocks
// bind at boot — adapters, endpoints, auth refs and pool limits are
// one snapshot — so a mid-run change is a warn + restart, never a
// hot-apply. One comparison serves the config-write log warns and the
// operator status card's restart hints; callers map the bare key to
// their own label.

import type { Config } from "./config.ts";

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
