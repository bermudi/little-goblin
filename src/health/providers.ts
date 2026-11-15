// Provider readiness — presence only, per the diagnosis contract: an
// auth.jsonl record or codex auth file exists, and every configured
// model ref resolves in a cached catalog. No credential is resolved,
// no catalog refreshed, no provider constructed — a cold cache is
// "unverified", never a fetch.

import { existsSync } from "node:fs";
import type { Config } from "../config-schema.ts";
import { splitModelRef } from "../config-schema.ts";
import { resolveCodexAuthFile } from "../agent/codex/auth.ts";
import { codexModelsCached } from "../agent/codex/models.ts";
import { modelOptionsCached, readOpenRouterCache } from "../agent/models-dev.ts";
import { result, type HealthResult } from "./shared.ts";

// The slots that resolve through config.providers — the same set
// cache.contracts maps, so the two checks name the same coverage.
function providerModelRefs(config: Config): [slot: string, ref: string][] {
	const refs: [string, string | undefined][] = [
		["model", config.model],
		["telegram.model", config.telegram.model],
		["titleModel", config.titleModel],
		["reviewer.model", config.reviewer?.model],
	];
	for (const ref of config.favorites) refs.push(["favorites", ref]);
	for (const ref of config.modelFallbacks) refs.push(["modelFallbacks", ref]);
	return refs.filter((p): p is [string, string] => p[1] !== undefined);
}

export function providerReadiness(
	config: Config | undefined,
	authNames: Set<string>,
): HealthResult[] {
	const start = performance.now(),
		scope = "caller-home:config";
	if (config === undefined) {
		return [
			result(
				"provider.readiness",
				scope,
				"skip",
				"no parsed config — provider access unverified",
				start,
			),
		];
	}
	const byProvider = new Map<string, string[]>();
	for (const [slot, ref] of providerModelRefs(config)) {
		let provider: string;
		try {
			provider = splitModelRef(ref).provider;
		} catch {
			continue; // schema-validated refs can't land here; favorites stay unlisted
		}
		const list = byProvider.get(provider) ?? [];
		list.push(`${slot}=${ref}`);
		byProvider.set(provider, list);
	}
	const results: HealthResult[] = [];
	for (const [name, p] of Object.entries(config.providers)) {
		const refs = byProvider.get(name) ?? [];
		if (refs.length === 0) {
			results.push(
				result(
					`provider.${name}`,
					scope,
					"skip",
					"configured but no model ref uses it — readiness unmeasured",
					start,
				),
			);
			continue;
		}
		const failures: string[] = [];
		const unverified: string[] = [];
		// Credential presence only — a record name in auth.jsonl or the
		// resolved codex auth file on disk; values stay unresolved.
		if (p.kind === "codex") {
			const auth = resolveCodexAuthFile(p.authFile);
			if (!existsSync(auth.path)) {
				failures.push(`no codex auth file (${auth.source})`);
			}
		} else if (!authNames.has(p.auth)) {
			failures.push(`auth record "${p.auth}" missing`);
		}
		// Model resolvability against cached catalogs only — cold caches
		// degrade to unverified, never a refresh.
		let catalog: Set<string> | null;
		if (p.kind === "codex") {
			const models = codexModelsCached(p.authFile);
			catalog = models === null ? null : new Set(models.map((m) => m.id));
		} else if (p.kind === "openrouter") {
			const routes = readOpenRouterCache();
			catalog = routes === null ? null : new Set(routes.keys());
		} else {
			const options = modelOptionsCached(
				name,
				p.kind,
				"baseUrl" in p ? p.baseUrl : undefined,
			);
			catalog = options.length === 0 ? null : new Set(options.map((o) => o.id));
		}
		for (const slotRef of refs) {
			const ref = slotRef.split("=", 2)[1]!;
			const modelId = splitModelRef(ref).modelId;
			if (catalog === null) {
				unverified.push(`${slotRef} (model catalog uncached)`);
			} else if (!catalog.has(modelId)) {
				failures.push(`${slotRef} not in cached catalog`);
			}
		}
		const detail = [
			`${refs.length} ref${refs.length === 1 ? "" : "s"}: ${refs.join(", ")}`,
			...failures,
			...unverified.map((u) => `unverified: ${u}`),
		].join(". ");
		results.push(
			result(
				`provider.${name}`,
				scope,
				failures.length > 0 ? "fail" : unverified.length > 0 ? "warn" : "pass",
				detail,
				start,
			),
		);
	}
	return results;
}
