import { join } from "node:path";
import JSON5 from "json5";
import { z } from "zod";
import {
	invokesPassCliDirectly,
	parseAuthFile,
	parsePassKeysGet,
	type AuthRecord,
} from "../auth.ts";
import {
	cacheContractFor,
	cacheContractFresh,
	type CacheContract,
} from "../agent/cache-contracts.ts";
import { authReferences, EXAMPLE_OPERATOR_ID, parseConfigValue } from "../config.ts";
import { type Config } from "../config-schema.ts";
import { failure, ProbeError, readBounded, result, type HealthResult } from "./shared.ts";

export function configCheck(home: string): { finding: HealthResult; config?: Config } {
	const start = performance.now(),
		scope = `caller-home:${home}`;
	try {
		const raw = readBounded(join(home, "goblin.json5")).text;
		let parsed: unknown;
		try {
			parsed = JSON5.parse(raw);
		} catch (error) {
			const location = z.object({ lineNumber: z.number().int().positive() }).safeParse(error);
			throw new ProbeError(
				`invalid-JSON5${location.success ? `:line:${location.data.lineNumber}` : ""}`,
			);
		}
		let config: Config;
		try {
			// Same disk-load semantics as the runtime: retired delegation
			// keys are the named compatibility exception, stripped before
			// strict validation (silently here — the doctor has no log sink).
			config = parseConfigValue(parsed);
		} catch {
			throw new ProbeError("invalid-config-schema-or-model-reference");
		}
		return {
			config,
			finding: result(
				"config",
				scope,
				"pass",
				"Config shape and configured model/provider references valid; provider access unverified",
				start,
			),
		};
	} catch (error) {
		return { finding: failure("config", scope, error, start, "Read/validate goblin.json5") };
	}
}
export function operatorIds(config: Config | undefined, home: string): HealthResult {
	const start = performance.now(),
		scope = `caller-home:${home}`;
	if (config === undefined) {
		return result("config.operators", scope, "skip", "Blocked by config", start);
	}
	return result(
		"config.operators",
		scope,
		config.operators.includes(EXAMPLE_OPERATOR_ID) ? "warn" : "pass",
		config.operators.includes(EXAMPLE_OPERATOR_ID)
			? "operators still holds the shipped example Telegram id — set your real id in Settings → operators"
			: "no shipped example operator id in operators",
		start,
	);
}
export function cacheContracts(config: Config | undefined, home: string): HealthResult {
	const start = performance.now(),
		scope = `caller-home:${home}`;
	if (config === undefined) {
		return result(
			"cache.contracts",
			scope,
			"skip",
			"no parsed config — contract coverage not listed",
			start,
		);
	}
	const refs: [string, string | undefined][] = [
		["model", config.model],
		["telegram.model", config.telegram.model],
		["titleModel", config.titleModel],
		["reviewer.model", config.reviewer?.model],
	];
	for (const ref of config.favorites) refs.push(["favorites", ref]);
	// Fallbacks serve chat turns — their cache contracts count too.
	for (const ref of config.modelFallbacks) refs.push(["modelFallbacks", ref]);
	const groups = new Map<CacheContract["id"], { contract: CacheContract; refs: string[] }>();
	// favorites isn't model-ref validated — one malformed entry must not
	// take the whole report down, so an unresolvable ref degrades to a
	// named unmappable entry instead of propagating.
	const unmappable: string[] = [];
	for (const [slot, ref] of refs) {
		if (ref === undefined) continue;
		let contract: CacheContract;
		try {
			contract = cacheContractFor(config, ref);
		} catch {
			unmappable.push(`${slot}=${ref}`);
			continue;
		}
		let group = groups.get(contract.id);
		if (group === undefined) {
			group = { contract, refs: [] };
			groups.set(contract.id, group);
		}
		group.refs.push(`${slot}=${ref}`);
	}
	const stale = !cacheContractFresh(Date.now());
	const undocumented = [...groups.values()].filter(
		(g) => g.contract.lifetime === "unpublished" || g.contract.lifetime === "unknown",
	);
	const parts: string[] = [];
	const mapped = [...groups.values()]
		.map(
			(g) => `${g.contract.id} (${g.contract.mode}, ${g.contract.lifetime}): ${g.refs.join(", ")}`,
		)
		.join("; ");
	if (mapped !== "") parts.push(mapped);
	if (unmappable.length > 0) {
		parts.push(`unmappable model refs: ${unmappable.join(", ")}`);
	}
	if (undocumented.length > 0) {
		parts.push(
			`unpublished/unknown cache duration for ${undocumented.map((g) => g.contract.id).join(", ")}`,
		);
	}
	if (stale) parts.push("lead contract metadata review is overdue");
	parts.push(
		"cache warmth and expiry are not verified — raw counters and route telemetry in model_cache_calls are needed for empirical policies",
	);
	return result(
		"cache.contracts",
		scope,
		stale || undocumented.length > 0 || unmappable.length > 0 ? "warn" : "pass",
		parts.join(". "),
		start,
	);
}
export function authCheck(
	home: string,
	config?: Config,
): { findings: HealthResult[]; profiles: Map<string, Set<string>>; names: Set<string> } {
	const start = performance.now(),
		scope = `caller-home:${home}`,
		profiles = new Map<string, Set<string>>(),
		names = new Set<string>();
	try {
		const raw = readBounded(join(home, "auth.jsonl"));
		if ((raw.mode & 0o077) !== 0) throw new ProbeError("insecure-mode:clear-group-world-bits");
		let records: AuthRecord[];
		try {
			records = parseAuthFile(raw.text);
		} catch (error) {
			// Parser paths depend on GOBLIN_HOME, so keep only its numeric line.
			const line = error instanceof Error ? /:(\d+):/.exec(error.message)?.[1] : undefined;
			throw new ProbeError(`invalid-auth-record${line ? `:line:${line}` : ""}`);
		}
		// The lint folds last-wins like the runtime loader: a clean override
		// un-poisons an earlier same-name pass-cli record, so raw-record
		// scanning would fail a live-clean file.
		const effective = new Map(records.map((r) => [r.name, r]));
		for (const name of effective.keys()) names.add(name);
		const poisoned = [...effective.values()].find(
			(r) => r.value.startsWith("!") && invokesPassCliDirectly(r.value.slice(1)),
		);
		if (poisoned) throw new ProbeError(`prohibited-owner-session-command:line:${poisoned.line}`);
		const refs = config ? authReferences(config) : new Set<string>();
		let missing = 0,
			general = 0,
			literals = 0;
		for (const ref of refs) {
			const record = effective.get(ref);
			if (!record) {
				missing++;
				continue;
			}
			if (!record.value.startsWith("!")) {
				literals++;
				continue;
			}
			// Grammar shared with the installer: only a single direct
			// `!pass-keys get` is a recognized profile reference. The
			// record's executable is never invoked — the probe runs
			// `pass-keys status <profile>` on PATH.
			const parsed = parsePassKeysGet(record.value);
			if (parsed === null) {
				general++;
				continue;
			}
			const needed = profiles.get(parsed.profile) ?? new Set<string>();
			needed.add(parsed.key);
			profiles.set(parsed.profile, needed);
		}
		if (profiles.size > 8) {
			profiles.clear();
			throw new ProbeError("too-many-required-profiles");
		}
		return {
			profiles,
			names,
			findings: [
				result(
					"auth.metadata",
					scope,
					missing ? "fail" : "pass",
					missing
						? `${missing} referenced auth records missing; no resolution attempted`
						: `Secure mode, record shapes and all-record poison lint valid; ${records.length} records inspected`,
					start,
				),
				result(
					"auth.coverage",
					scope,
					"warn",
					config
						? `${general} general commands and ${literals} literal credentials unverified; no auth values resolved; boot-memoized credentials and OAuth unverified`
						: "Referenced records unverified: blocked by config; no auth values resolved",
					start,
				),
			],
		};
	} catch (error) {
		return {
			profiles,
			names,
			findings: [
				failure("auth.metadata", scope, error, start, "Inspect auth.jsonl"),
				result("auth.coverage", scope, "skip", "Blocked by auth.metadata; no auth values resolved"),
			],
		};
	}
}
