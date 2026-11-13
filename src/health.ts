import { closeSync, constants, existsSync, openSync, readdirSync, statSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "./config.ts";
import { sqliteProbeSchema } from "./health-sqlite.ts";
import { summarize, tally } from "./test-ratio.ts";
import { checkAppAssets } from "./health/app-assets.ts";
import { authCheck, cacheContracts, configCheck } from "./health/config-auth.ts";
import { http } from "./health/http.ts";
import { sqlite } from "./health/sqlite.ts";
import { herdrUnit, systemdShow } from "./health/systemd.ts";
import { workspace } from "./health/workspace.ts";
import {
	capacity,
	command,
	errno,
	failure,
	healthReportSchema,
	ProbeError,
	readBounded,
	result,
	type HealthReport,
	type HealthResult,
	type ProbeContext,
} from "./health/shared.ts";

async function installation(
	checkout: string,
	phase: HealthReport["phase"],
	probe: ProbeContext = {},
	delegationConfigured = false,
): Promise<HealthResult[]> {
	const start = performance.now(),
		scope = `diagnostic-revision:${checkout}`;
	if (phase === "preflight")
		return [
			result("service.goblin", scope, "skip", "Unit not required before installation", start),
			result("service.goblin-herdr", scope, "skip", "Unit not required before installation", start),
			result(
				"app.assets",
				`installed-checkout:${checkout}`,
				"skip",
				"Assets not required before build; caller must checkAppAssets after build",
				start,
			),
		];
	let installed: string | undefined;
	let finding: HealthResult;
	// The herdr probe shares the systemctl boundary and the same deadline
	// budget — run it beside the service probe, not after it.
	const herdr = herdrUnit(scope, delegationConfigured, probe);
	try {
		const properties = await systemdShow(
			"goblin.service",
			["LoadState", "ActiveState", "SubState", "WorkingDirectory"],
			probe,
		);
		const parsed = z
			.object({
				LoadState: z.enum(["loaded", "not-found", "error", "masked", "bad-setting"]),
				ActiveState: z.enum([
					"active",
					"inactive",
					"failed",
					"activating",
					"deactivating",
					"reloading",
					"refreshing",
					"maintenance",
				]),
				SubState: z.string().max(64),
				WorkingDirectory: z.string().max(4096),
			})
			.safeParse(properties);
		if (!parsed.success) throw new ProbeError("invalid-systemd-properties");
		const p = parsed.data;
		if (isAbsolute(p.WorkingDirectory)) installed = resolve(p.WorkingDirectory);
		const failed =
			p.LoadState !== "loaded" || p.ActiveState !== "active" || p.SubState !== "running";
		finding = result(
			"service.goblin",
			scope,
			failed ? "fail" : installed !== checkout ? "warn" : "pass",
			`${p.LoadState}/${p.ActiveState}; ${p.SubState === "running" ? "running substate" : "not in running substate"}; ${installed === checkout ? "WorkingDirectory matches diagnostic checkout" : "WorkingDirectory missing or differs; installed compatibility unverified"}; process-loaded config, readiness and revision identity unverified`,
			start,
		);
	} catch (error) {
		finding = failure("service.goblin", scope, error, start, "Inspect safe systemd properties");
	}
	const assets = checkAppAssets(installed ?? checkout);
	if (!installed) assets.detail += "; installed target unknown, diagnostic checkout inspected only";
	return [
		finding,
		await herdr,
		result(
			"installation.coverage",
			scope,
			"warn",
			"Git revision identity, launcher targets and running-process readiness unverified; no Environment or journal inspected",
		),
		assets,
	];
}

// Status has no JSON API. This grammar is pinned to resolve/local.go: only the
// first status line is consumed; failure diagnostics can contain arbitrary data.
function snapshotLine(
	raw: string,
	profile: string,
): { state: string; ageSeconds: number | null; names: Set<string> } {
	const first = raw.split("\n")[0] ?? "";
	const match =
		/^([a-z][a-z0-9_-]{0,63}): (READY|MISSING|LOCKED|BROKEN)  age=([^ ]+)  keys=(\d+)(?:  names=([A-Z0-9_]+(?: [A-Z0-9_]+)*))?$/.exec(
			first,
		);
	if (!match || match[1] !== profile) throw new ProbeError("unverified-status-contract");
	const names = new Set(match[5]?.split(" ") ?? []);
	if (Number(match[4]) !== names.size) throw new ProbeError("invalid-status-key-count");
	let ageSeconds: number | null = null;
	if (match[2] === "READY") {
		const duration = match[3] ?? "";
		if (!/^-?(?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?$/.test(duration) || !/\d/.test(duration))
			throw new ProbeError("unverified-status-age");
		ageSeconds = [...duration.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)].reduce(
			(sum, m) => sum + Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1),
			0,
		);
		if (duration.startsWith("-")) ageSeconds = -ageSeconds;
	} else if (match[3] !== "none" || names.size !== 0)
		throw new ProbeError("invalid-unavailable-status");
	return { state: match[2] ?? "BROKEN", ageSeconds, names };
}
async function snapshots(
	profiles: Map<string, Set<string>>,
	phase: HealthReport["phase"],
	probe: ProbeContext = {},
): Promise<HealthResult[]> {
	if (!profiles.size)
		return [
			result(
				"keys.snapshots",
				"caller-home",
				"skip",
				"No recognized referenced pass-keys profiles; other credential mechanisms unverified",
			),
		];
	const findings = await Promise.all(
		[...profiles]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(async ([profile, needed], index) => {
				const start = performance.now(),
					id = `keys.snapshot.${index + 1}`;
				let scope = "caller-home;operator-wallet";
				try {
					const raw = await command(["pass-keys", "status", profile], 3000, probe, true);
					const status = snapshotLine(raw, profile);
					scope += `;profile:${profile}`;
					const missing = [...needed].filter((name) => !status.names.has(name)).length;
					return result(
						id,
						scope,
						status.state !== "READY" || missing
							? "fail"
							: (status.ageSeconds ?? 0) < 0 || (status.ageSeconds ?? 0) > 86400
								? "warn"
								: "pass",
						`${status.state}; ${needed.size} needed key names checked, ${missing} missing; snapshot age ${status.ageSeconds ?? "unavailable"} seconds${(status.ageSeconds ?? 0) < 0 ? "; clock skew: snapshot timestamp is in the future" : ""}; status metadata only, no credential values in report; status interface pinned from source, wallet implementation not independently verified`,
						start,
					);
				} catch (error) {
					return failure(
						id,
						scope,
						error,
						start,
						"pass-keys status availability (missing/locked/broken cannot be distinguished without valid status metadata)",
					);
				}
			}),
	);
	if (phase === "preflight")
		return [
			...findings,
			result(
				"keys.refresh",
				"caller-home;operator-wallet",
				"skip",
				"Refresh units not required before installation; no warming or unlocking",
			),
		];
	const refresh = await Promise.all(
		["goblin-keys.service", "goblin-keys.timer"].map(async (unit) => {
			const start = performance.now(),
				id = `keys.refresh.${unit.endsWith("timer") ? "timer" : "service"}`,
				scope = "caller-home;operator-wallet";
			try {
				const raw = await command(
					["systemctl", "--user", "show", unit, "--property=LoadState,ActiveState"],
					2000,
					probe,
				);
				const lines = raw.trim().split("\n");
				if (
					lines.length !== 2 ||
					!lines.some((line) => line === "LoadState=loaded") ||
					!lines.some((line) =>
						/^ActiveState=(?:active|inactive|failed|activating|deactivating)$/.test(line),
					)
				)
					throw new ProbeError("refresh-unit-unavailable-or-unverified");
				const healthy = unit.endsWith("timer")
					? lines.includes("ActiveState=active")
					: !lines.includes("ActiveState=failed");
				return result(
					id,
					scope,
					healthy ? "pass" : "warn",
					`${unit}: ${healthy ? "expected current unit state" : "refresh state degraded"}; last sync success, unit configuration and wallet auto-unlock unverified`,
					start,
				);
			} catch (error) {
				return result(
					id,
					scope,
					"warn",
					`Refresh state unverified: ${errno(error)}; no warming or unlocking`,
					start,
				);
			}
		}),
	);
	return [...findings, ...refresh];
}

function narrowEnv(path: string, allowed: readonly string[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const [index, line] of readBounded(path, 64 * 1024)
		.text.split("\n")
		.entries()) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
		if (!match?.[1] || match[2] === undefined)
			throw new ProbeError(`invalid-env-shape:line:${index + 1}`);
		if (!allowed.includes(match[1])) continue;
		if (out.has(match[1])) throw new ProbeError(`duplicate-allowed-env-field:line:${index + 1}`);
		out.set(match[1], match[2]);
	}
	return out;
}

async function localMemory(config: Config, probe: ProbeContext = {}): Promise<HealthResult[]> {
	const start = performance.now(),
		scope = "caller-home;local-memory-installation",
		id = "memory.local-association";
	const url = new URL(config.memory?.baseUrl ?? "https://invalid.invalid");
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "localhost"].includes(url.hostname) ||
		url.port !== "8888" ||
		!["", "/"].includes(url.pathname)
	)
		return [
			result(
				id,
				scope,
				"skip",
				"Configured API is not the supported local installation; caller-local containers, embedding and memory-volume capacity unverified",
				start,
			),
		];
	let embedding: { address: string; model: string } | undefined;
	try {
		const cfg = join(homedir(), ".config/goblin-memory");
		const unitsDir = join(homedir(), ".config/containers/systemd");
		const unit = readBounded(join(unitsDir, "goblin-memory-api.container"), 64 * 1024).text;
		const pod = readBounded(join(unitsDir, "goblin-memory.pod"), 64 * 1024).text;
		if (
			!/^ContainerName=goblin-memory-api$/m.test(unit) ||
			!/^Pod=goblin-memory\.pod$/m.test(unit) ||
			!/^EnvironmentFile=%h\/\.config\/goblin-memory\/hindsight\.env$/m.test(unit) ||
			!/^PodName=goblin-memory$/m.test(pod) ||
			!/^PublishPort=127\.0\.0\.1:8888:8888$/m.test(pod)
		)
			throw new ProbeError("unverified-installed-API-association");
		// Only running flag and mount sources are requested — in a pod the
		// port lives on the infra container, never on the API itself.
		const raw = await command(
			[
				"podman",
				"inspect",
				"--format",
				'{"running":{{json .State.Running}},"mounts":{{json .Mounts}}}',
				"goblin-memory-api",
			],
			2000,
			probe,
		);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new ProbeError("invalid-container-metadata");
		}
		const meta = z
			.object({
				running: z.boolean(),
				mounts: z.array(z.object({ Source: z.string(), Destination: z.string() })).max(64),
			})
			.safeParse(parsed);
		if (
			!meta.success ||
			!meta.data.running ||
			!meta.data.mounts.some(
				(mount) =>
					mount.Source === join(cfg, "start.py") &&
					mount.Destination === "/opt/goblin-memory-start.py",
			)
		)
			throw new ProbeError("unverified-running-API-association");
		// The published binding belongs to the pod's infra container; the
		// pod roster proves api+db share its loopback.
		const podRaw = await command(
			["podman", "pod", "inspect", "--format", "{{json .}}", "goblin-memory"],
			2000,
			probe,
		);
		let podParsed: unknown;
		try {
			podParsed = JSON.parse(podRaw);
		} catch {
			throw new ProbeError("invalid-pod-metadata");
		}
		const podMeta = z
			.object({
				InfraConfig: z
					.object({
						PortBindings: z
							.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() })))
							.nullish(),
					})
					.nullish(),
				Containers: z.array(z.object({ Name: z.string() })).nullish(),
			})
			.safeParse(podParsed);
		const podInfo = podMeta.success ? podMeta.data : undefined;
		const roster = new Set((podInfo?.Containers ?? []).map((c) => c.Name));
		if (
			!podInfo?.InfraConfig?.PortBindings?.["8888/tcp"]?.some(
				(port) => port.HostIp === "127.0.0.1" && port.HostPort === "8888",
			) ||
			!roster.has("goblin-memory-api") ||
			!roster.has("goblin-memory-db")
		)
			throw new ProbeError("unverified-pod-API-association");
		const api = narrowEnv(join(cfg, "hindsight.env"), [
			"HINDSIGHT_API_EMBEDDINGS_PROVIDER",
			"HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL",
			"HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL",
		]);
		if (api.get("HINDSIGHT_API_EMBEDDINGS_PROVIDER") !== "openai")
			return [
				result(
					id,
					scope,
					"pass",
					"Local API container/port/mount associated; installed nonlocal embedding provider not probed; runtime-loaded env unverified",
					start,
				),
				await memoryVolume(probe),
				result(
					"memory.embedding",
					scope,
					"skip",
					"Installed embedding provider is not the supported local OpenAI-to-Ollama relay; no provider calls made",
				),
			];
		const relay = narrowEnv(join(cfg, "embed-relay.env"), [
			"GOBLIN_EMBED_RELAY_ADDR",
			"GOBLIN_EMBED_MODEL",
		]);
		const address = relay.get("GOBLIN_EMBED_RELAY_ADDR"),
			model = relay.get("GOBLIN_EMBED_MODEL");
		const base = api.get("HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL");
		if (
			!address ||
			!model ||
			!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) ||
			!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model) ||
			!Object.values(networkInterfaces())
				.flat()
				.some((iface) => iface?.address === address && iface.family === "IPv4")
		)
			throw new ProbeError("unverified-host-local-relay");
		if (
			api.get("HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL") !== model ||
			![`http://${address}:11435/v1`, `http://${address}:11435/v1/`].includes(base ?? "")
		)
			throw new ProbeError("relay-provider-baseURL-model-mismatch");
		embedding = { address, model };
	} catch (error) {
		return [
			result(
				id,
				scope,
				"warn",
				`Local API/embedding association unverified: ${errno(error)}; no embedding requested`,
				start,
			),
			result("memory.embedding", scope, "skip", "Blocked by memory.local-association"),
			result(
				"storage.memory-volume",
				scope,
				"warn",
				"Memory PostgreSQL filesystem unverified; home capacity does not cover it",
			),
		];
	}
	const findings = [
		result(
			id,
			scope,
			"pass",
			"Running local API binding/mount and installed provider/baseURL/model match host-local relay; runtime-loaded embedding settings remain unverified",
			start,
		),
		await memoryVolume(probe),
	];
	const embedStart = performance.now();
	try {
		const response = await http(
			`http://${embedding.address}:11435/api/embed`,
			15000,
			probe.signal,
			JSON.stringify({ model: embedding.model, input: "Goblin diagnostic embedding probe." }),
		);
		if (response.status < 200 || response.status >= 300)
			throw new ProbeError(`HTTP:${response.status}`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(response.text);
		} catch {
			throw new ProbeError("invalid-embedding-JSON");
		}
		const vector = z
			.object({ embeddings: z.array(z.array(z.number().finite()).min(1).max(8192)).length(1) })
			.safeParse(parsed);
		if (!vector.success) throw new ProbeError("invalid-embedding-schema");
		findings.push(
			result(
				"memory.embedding",
				scope,
				"pass",
				"Synthetic public text embedded through associated local relay; no retention or keep_alive override; vectors omitted",
				embedStart,
			),
		);
	} catch (error) {
		findings.push(
			failure("memory.embedding", scope, error, embedStart, "Synthetic local embedding"),
		);
	}
	return findings;
}
async function memoryVolume(probe: ProbeContext = {}): Promise<HealthResult> {
	const start = performance.now(),
		scope = "caller-home;local-memory-volume";
	let checked: HealthResult | undefined;
	try {
		const raw = await command(
			["podman", "volume", "inspect", "--format", "{{json .Mountpoint}}", "goblin-memory-db"],
			2000,
			probe,
		);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new ProbeError("invalid-volume-metadata");
		}
		const point = z.string().max(4096).refine(isAbsolute).safeParse(parsed);
		if (!point.success) throw new ProbeError("invalid-volume-mountpoint");
		checked = capacity(point.data, "storage.memory-volume", scope);
		// Do not emit external metadata paths, even through filesystem failures.
		if (checked.status === "fail")
			checked.detail = `Memory volume statfs/capacity failed; ${checked.detail.startsWith("Available") ? checked.detail : "filesystem inspection unavailable"}`;
		const mountRaw = await command(
			["podman", "inspect", "--format", "{{json .Mounts}}", "goblin-memory-db"],
			2000,
			probe,
		);
		let mountParsed: unknown;
		try {
			mountParsed = JSON.parse(mountRaw);
		} catch {
			throw new ProbeError("invalid-db-mount-metadata");
		}
		const mounts = z
			.array(z.object({ Source: z.string(), Destination: z.string() }))
			.max(64)
			.safeParse(mountParsed);
		if (
			!mounts.success ||
			!mounts.data.some(
				(mount) => mount.Source === point.data && mount.Destination === "/var/lib/postgresql/data",
			)
		) {
			checked.detail += "; named volume only, PostgreSQL mount identity unverified";
			if (checked.status === "pass") checked.status = "warn";
		} else checked.detail += "; PostgreSQL data mount matched narrow volume metadata";
		return result(checked.id, checked.scope, checked.status, checked.detail, start);
	} catch (error) {
		if (checked) {
			checked.detail += `; PostgreSQL mount identity unverified: ${errno(error)}`;
			if (checked.status === "pass") checked.status = "warn";
			return result(checked.id, checked.scope, checked.status, checked.detail, start);
		}
		return result(
			"storage.memory-volume",
			scope,
			"warn",
			`PostgreSQL filesystem coverage unverified: ${errno(error)}; home capacity does not cover it`,
			start,
		);
	}
}
// Installed memory-stack unit files vs their deploy/memory sources: the
// manual runbook installs by copy and quadlets are operator-editable, so
// the box drifts from the repo silently (#158's two-week EnvironmentFile=
// relic). Pure file comparison — no podman/systemd calls, no env files,
// no values — and the API quadlet's installer-managed secrets region is
// excluded on both sides, so a correctly reconfigured install is not drift.
const SECRETS_MARKER_BEGIN = "# goblin:secrets-begin";
const SECRETS_MARKER_END = "# goblin:secrets-end";

function withoutManagedSecretRegion(text: string): string {
	const lines = text.split("\n");
	const begin = lines.indexOf(SECRETS_MARKER_BEGIN);
	const end = lines.indexOf(SECRETS_MARKER_END);
	// Mismatched or absent markers compare literally: a deleted marker
	// region is real drift, not noise to normalize away.
	if (begin === -1 || end === -1 || end < begin) return text;
	return [...lines.slice(0, begin + 1), ...lines.slice(end)].join("\n");
}

function memoryUnitDrift(
	checkout: string,
	config: Config | undefined,
	phase: HealthReport["phase"],
): HealthResult {
	const start = performance.now(),
		scope = "caller-home;local-memory-installation",
		id = "memory.units-drift";
	if (phase === "preflight")
		return result(
			id,
			scope,
			"skip",
			"Unit files not yet installed at preflight; the install runbook owns first placement",
			start,
		);
	const url = new URL(config?.memory?.baseUrl ?? "https://invalid.invalid");
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "localhost"].includes(url.hostname) ||
		url.port !== "8888" ||
		!["", "/"].includes(url.pathname)
	)
		return result(
			id,
			scope,
			"skip",
			"Configured API is not the supported local installation; installed unit drift not checked",
			start,
		);
	try {
		const sources = join(checkout, "deploy", "memory");
		const names = readdirSync(sources)
			.filter((name) => /\.(?:container|network|volume|pod|service|timer)$/.test(name))
			.sort();
		if (names.length === 0) throw new ProbeError("no-deploy-memory-unit-sources");
		// The goblin-embed-* units are opt-in: installed only when the
		// operator wrote the relay switch. Existence is the whole check —
		// the env file's contents are never read here.
		const embedOptIn = existsSync(join(homedir(), ".config/goblin-memory/embed-relay.env"));
		const quadletDir = join(homedir(), ".config/containers/systemd");
		const unitDir = join(homedir(), ".config/systemd/user");
		const differs: string[] = [],
			missing: string[] = [],
			unreadable: string[] = [];
		let checked = 0;
		for (const name of names) {
			if (name.startsWith("goblin-embed-") && !embedOptIn) continue;
			const dir = /\.(?:service|timer)$/.test(name) ? unitDir : quadletDir;
			let installed: string;
			try {
				installed = readBounded(join(dir, name), 64 * 1024).text;
			} catch (error) {
				const code = errno(error);
				if (code === "ENOENT") missing.push(name);
				else unreadable.push(`${name}:${code}`);
				continue;
			}
			const source = readBounded(join(sources, name), 64 * 1024).text;
			if (withoutManagedSecretRegion(installed) !== withoutManagedSecretRegion(source))
				differs.push(name);
			else checked++;
		}
		const problems = [
			...(differs.length > 0 ? [`differs: ${differs.join(", ")}`] : []),
			...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
			...(unreadable.length > 0 ? [`unreadable: ${unreadable.join(", ")}`] : []),
		];
		if (problems.length > 0)
			return result(
				id,
				scope,
				"warn",
				`Installed memory unit files drift from deploy/memory (${problems.join("; ")}); installed Quadlets are operator-editable — confirm edits before reconciling`,
				start,
			);
		const optOut = names.length - checked - missing.length - unreadable.length - differs.length;
		return result(
			id,
			scope,
			"pass",
			`All ${checked} installed unit files match deploy/memory (installer-managed Secret= region excluded)` +
				(optOut > 0
					? `; ${optOut} opt-in goblin-embed-* units unchecked (no embed-relay.env switch)`
					: "") +
				"; runtime unit state unverified",
			start,
		);
	} catch (error) {
		return failure(id, scope, error, start, "Compare installed memory units with deploy/memory");
	}
}

async function memory(
	config: Config | undefined,
	checkout: string,
	phase: HealthReport["phase"],
	probe: ProbeContext = {},
): Promise<HealthResult[]> {
	const scope = "caller-home;configured-memory-endpoint";
	if (!config?.memory)
		return [
			result("memory.ready", scope, "skip", config ? "Memory disabled" : "Blocked by config"),
			result("memory.access", scope, "skip", config ? "Memory disabled" : "Blocked by config"),
			result("memory.embedding", scope, "skip", config ? "Memory disabled" : "Blocked by config"),
			result(
				"storage.memory-volume",
				scope,
				"skip",
				config ? "Memory disabled" : "Blocked by config",
			),
			result("memory.units-drift", scope, "skip", config ? "Memory disabled" : "Blocked by config"),
		];
	const start = performance.now();
	let ready: HealthResult;
	try {
		const response = await http(
			`${config.memory.baseUrl.replace(/\/$/, "")}/health/ready`,
			5000,
			probe.signal,
		);
		if (response.status < 200 || response.status >= 300)
			throw new ProbeError(`HTTP:${response.status}`);
		ready = result(
			"memory.ready",
			scope,
			"pass",
			"Configured /health/ready returned 2xx; response body not interpreted or emitted; not proof of bank/auth access",
			start,
		);
	} catch (error) {
		ready = failure("memory.ready", scope, error, start, "Configured Hindsight readiness");
	}
	return [
		ready,
		result(
			"memory.access",
			scope,
			"warn",
			"Application credentials, bank existence/access and running Goblin memory queues unverified; no auth resolution or memory writes",
		),
		...(await localMemory(config, probe)),
		memoryUnitDrift(checkout, config, phase),
	];
}

// The configured sandbox block's engine readiness: podman must answer
// and the pinned image must already be local (goblin never pulls). Both
// probes are read-only — no create, no pull, no socket writes.
async function sandbox(
	config: Config | undefined,
	probe: ProbeContext = {},
): Promise<HealthResult[]> {
	const scope = "caller-home;configured-sandbox";
	if (config?.sandbox === undefined)
		return [
			result(
				"sandbox.engine",
				scope,
				"skip",
				config === undefined
					? "Blocked by config"
					: "No sandbox block configured — the tool is absent",
			),
		];
	const start = performance.now();
	try {
		await command(["podman", "info"], 5000, probe);
	} catch (error) {
		return [
			result(
				"sandbox.engine",
				scope,
				"fail",
				`podman engine unresponsive: ${errno(error)}; configured sandbox calls cannot run`,
				start,
			),
			result("sandbox.image", scope, "skip", "Blocked by sandbox.engine"),
		];
	}
	const engine = result(
		"sandbox.engine",
		scope,
		"pass",
		"podman info answered — rootless engine responsive",
		start,
	);
	const imageStart = performance.now();
	try {
		await command(["podman", "image", "exists", config.sandbox.image], 5000, probe);
		return [
			engine,
			result(
				"sandbox.image",
				scope,
				"pass",
				`Configured image ${config.sandbox.image} is in the local store`,
				imageStart,
			),
		];
	} catch (error) {
		const category = errno(error);
		return [
			engine,
			result(
				"sandbox.image",
				scope,
				"fail",
				category === "exit:1"
					? `Configured image ${config.sandbox.image} not in the local store; pulls need operator approval: podman pull ${config.sandbox.image}`
					: `Image presence unverified: ${category}`,
				imageStart,
			),
		];
	}
}

// Repo health, not installation health: informational (warn, never fail). A
// release built by `git archive` has no git metadata, so the ratio is skipped
// there rather than guessed from the filesystem or silently passed. The reads
// go through readBounded like every probe: an over-cap tracked file refuses
// the measurement (a silently truncated read would corrupt the counts) rather
// than shrink it.
export async function testRatio(checkout: string, probe: ProbeContext = {}): Promise<HealthResult> {
	const start = performance.now();
	const scope = `diagnostic-checkout:${checkout}`;
	if (!existsSync(join(checkout, ".git")))
		return result(
			"repo.test-ratio",
			scope,
			"skip",
			"No git metadata in this checkout (release archive); ratio unmeasured",
			start,
		);
	try {
		const paths = (await command(["git", "-C", checkout, "ls-files", "src/"], 5_000, probe))
			.split("\n")
			.filter((p) => /\.tsx?$/.test(p));
		const s = summarize(
			tally(
				paths.map((path) => ({
					path,
					lines: readBounded(join(checkout, path)).text.split("\n").length - 1,
				})),
			),
		);
		const top = s.excess
			.slice(0, 3)
			.map((d) => `${d.dir} +${d.excess}`)
			.join(", ");
		return result(
			"repo.test-ratio",
			scope,
			s.ratio > 1 ? "warn" : "pass",
			`tests ${s.test} / src ${s.prod} lines = ${s.ratio.toFixed(2)}x${s.ratio > 1 ? `; top excess: ${top}` : ""}`,
			start,
		);
	} catch (error) {
		return result("repo.test-ratio", scope, "warn", `Ratio unmeasured: ${errno(error)}`, start);
	}
}

export async function runHealth(options: {
	home: string;
	checkout: string;
	phase: "preflight" | "installed";
	signal?: AbortSignal;
	probe?: Pick<ProbeContext, "processGroup">;
}): Promise<HealthReport> {
	const home = resolve(options.home),
		checkout = resolve(options.checkout);
	const checkedAt = new Date().toISOString();
	const config = configCheck(home);
	const auth = authCheck(home, config.config);
	const local = [
		config.finding,
		cacheContracts(config.config, home),
		...auth.findings,
		...workspace(home, options.phase),
		capacity(home, "storage.home", `caller-home:${home}`),
	];
	const probe: ProbeContext = {
		...options.probe,
		...(options.signal ? { signal: options.signal } : {}),
	};
	const [db, install, keys, mem, sbx, ratio] = await Promise.all([
		sqlite(home, options.phase, probe, config.config),
		installation(checkout, options.phase, probe, config.config?.delegation !== undefined),
		snapshots(auth.profiles, options.phase, probe),
		memory(config.config, checkout, options.phase, probe),
		sandbox(config.config, probe),
		testRatio(checkout, probe),
	]);
	return healthReportSchema.parse({
		version: 1,
		checkedAt,
		phase: options.phase,
		target: { home, checkout },
		results: [...local, ...db, ...install, ...keys, ...mem, ...sbx, ratio],
	});
}
