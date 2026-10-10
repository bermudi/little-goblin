import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
	statfsSync,
} from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import JSON5 from "json5";
import { z } from "zod";
import { invokesPassCliDirectly, parseAuthFile, type AuthRecord } from "./auth.ts";
import { parseConfig, type Config } from "./config.ts";
import { boundedRun, spawnProc } from "./proc.ts";
import { sqliteProbeSchema } from "./health-sqlite.ts";

export const healthResultSchema = z.object({
	id: z.string(),
	status: z.enum(["pass", "warn", "fail", "skip"]),
	scope: z.string(),
	detail: z.string(),
	durationMs: z.number().finite().nonnegative(),
	next: z.string().optional(),
});
export type HealthResult = z.infer<typeof healthResultSchema>;
export const healthReportSchema = z.object({
	version: z.literal(1),
	checkedAt: z.iso.datetime(),
	phase: z.enum(["preflight", "installed"]),
	target: z.object({ home: z.string(), checkout: z.string() }),
	results: z.array(healthResultSchema),
});
export type HealthReport = z.infer<typeof healthReportSchema>;

class ProbeError extends Error {
	constructor(readonly category: string) {
		super(category);
	}
}
function errno(error: unknown): string {
	const parsed = z.object({ code: z.string().regex(/^E[A-Z0-9]+$/) }).safeParse(error);
	return error instanceof ProbeError
		? error.category
		: parsed.success
			? parsed.data.code
			: "inspection-error";
}
function result(
	id: string,
	scope: string,
	status: HealthResult["status"],
	detail: string,
	start = performance.now(),
	next?: string,
): HealthResult {
	return {
		id,
		scope,
		status,
		detail,
		durationMs: Math.max(0, Math.round(performance.now() - start)),
		...(next ? { next } : {}),
	};
}
function failure(
	id: string,
	scope: string,
	error: unknown,
	start: number,
	operation: string,
): HealthResult {
	return result(id, scope, "fail", `${operation}: ${errno(error)}`, start);
}

// O_NONBLOCK prevents a FIFO from hanging before fstat can reject it. The outer
// doctor worker watchdog also covers filesystems whose regular-file reads stall.
function readBounded(path: string, cap = 256 * 1024): { text: string; mode: number } {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new ProbeError("not-regular-file");
		if (stat.size > cap) throw new ProbeError("oversized-file");
		const buffer = Buffer.alloc(cap + 1);
		let size = 0;
		while (size <= cap) {
			const n = readSync(fd, buffer, size, buffer.length - size, null);
			if (n === 0) break;
			size += n;
		}
		if (size > cap) throw new ProbeError("oversized-file");
		return { text: buffer.subarray(0, size).toString("utf8"), mode: stat.mode & 0o777 };
	} finally {
		closeSync(fd);
	}
}
function contained(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function checkAppAssets(checkout: string): HealthResult {
	const start = performance.now();
	const scope = `installed-checkout:${resolve(checkout)}`;
	try {
		const root = resolve(checkout, "app/dist");
		const realRoot = realpathSync(root);
		if (!contained(realpathSync(resolve(checkout)), realRoot)) throw new ProbeError("path-escape");
		const index = join(root, "index.html");
		if (!contained(realRoot, realpathSync(index))) throw new ProbeError("path-escape");
		const html = readBounded(index).text;
		const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)];
		if (refs.length > 128) throw new ProbeError("too-many-asset-references");
		let files = 0;
		for (const ref of refs) {
			const value = ref[1];
			if (!value || value.startsWith("#") || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) continue;
			let name: string;
			try {
				name = decodeURIComponent(value.split(/[?#]/)[0] ?? "");
			} catch {
				throw new ProbeError("invalid-asset-reference");
			}
			if (name.includes("\0") || name.includes("\\"))
				throw new ProbeError("invalid-asset-reference");
			if (name.startsWith("/app/")) name = name.slice(5);
			else if (name.startsWith("/")) throw new ProbeError("path-escape");
			const asset = resolve(root, name);
			if (!contained(root, asset) || !contained(realRoot, realpathSync(asset)))
				throw new ProbeError("path-escape");
			// Only presence/readability is needed, not buffering bundle contents.
			const fd = openSync(asset, constants.O_RDONLY | constants.O_NONBLOCK);
			try {
				if (!fstatSync(fd).isFile()) throw new ProbeError("not-regular-file");
				readSync(fd, Buffer.alloc(1), 0, 1, 0);
			} finally {
				closeSync(fd);
			}
			files++;
		}
		if (files === 0 || !/<(?:html|!doctype)\b/i.test(html))
			throw new ProbeError("invalid-asset-index");
		return result(
			"app.assets",
			scope,
			"pass",
			`Index and ${files} referenced local files readable; runtime serving unverified`,
			start,
		);
	} catch (error) {
		return failure("app.assets", scope, error, start, "Read app/dist assets");
	}
}

async function command(
	argv: string[],
	timeoutMs: number,
	signal?: AbortSignal,
	statusMetadata = false,
): Promise<string> {
	if (signal?.aborted) throw new ProbeError("cancelled");
	let proc: Bun.ReadableSubprocess;
	try {
		proc = spawnProc(argv);
	} catch (error) {
		throw new ProbeError(`spawn:${errno(error)}`);
	}
	// The outer worker may itself be killed immediately after abort. Its children
	// must be killed NOW, not after boundedRun's ordinary TERM grace period.
	const kill = () => {
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* Already reaped. */
			}
		}
	};
	const controller = new AbortController();
	let timedOut = false;
	const abort = () => {
		kill();
		controller.abort();
	};
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	const timer = setTimeout(() => {
		timedOut = true;
		abort();
	}, timeoutMs);
	try {
		const out = await boundedRun(proc, {
			timeoutMs: timeoutMs + 500,
			maxOutput: 64 * 1024,
			abortSignal: controller.signal,
		});
		if (signal?.aborted) throw new ProbeError("cancelled");
		if (timedOut || out.timedOut) throw new ProbeError("deadline");
		if (out.truncated) {
			kill();
			throw new ProbeError("oversized-or-cut-output");
		}
		if (
			out.exitCode !== 0 &&
			!(
				statusMetadata &&
				/^[a-z][a-z0-9_-]{0,63}: (?:MISSING|LOCKED|BROKEN)  age=none  keys=0\n/.test(out.stdout)
			)
		)
			throw new ProbeError(`exit:${out.exitCode ?? "unreaped"}`);
		return out.stdout;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		kill();
	}
}

function configCheck(home: string): { finding: HealthResult; config?: Config } {
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
			config = parseConfig(parsed);
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
function authReferences(config: Config): Set<string> {
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
	return refs;
}
function authCheck(
	home: string,
	config?: Config,
): { findings: HealthResult[]; profiles: Map<string, Set<string>> } {
	const start = performance.now(),
		scope = `caller-home:${home}`,
		profiles = new Map<string, Set<string>>();
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
		const poisoned = records.find(
			(r) => r.value.startsWith("!") && invokesPassCliDirectly(r.value.slice(1)),
		);
		if (poisoned) throw new ProbeError(`prohibited-owner-session-command:line:${poisoned.line}`);
		const effective = new Map(records.map((r) => [r.name, r]));
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
			const match = /^!pass-keys get ([a-z][a-z0-9_-]{0,63}) ([A-Za-z_][A-Za-z0-9_]{0,127})$/.exec(
				record.value,
			);
			if (!match?.[1] || !match[2]) {
				general++;
				continue;
			}
			const needed = profiles.get(match[1]) ?? new Set<string>();
			needed.add(match[2]);
			profiles.set(match[1], needed);
		}
		if (profiles.size > 8) {
			profiles.clear();
			throw new ProbeError("too-many-required-profiles");
		}
		return {
			profiles,
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
			findings: [
				failure("auth.metadata", scope, error, start, "Inspect auth.jsonl"),
				result("auth.coverage", scope, "skip", "Blocked by auth.metadata; no auth values resolved"),
			],
		};
	}
}

function workspace(home: string, phase: HealthReport["phase"]): HealthResult[] {
	return [
		["workspace", "directory", true],
		["state", "directory", true],
		["workspace/skills", "directory", true],
		["workspace/attachments", "directory", true],
		["workspace/SOUL.md", "file", true],
		["workspace/AGENTS.md", "file", true],
		["workspace/USER.md", "file", false],
	].map(([name, kind, required]) => {
		const start = performance.now(),
			path = join(home, String(name)),
			scope = `caller-home:${home}`,
			id = `workspace.${String(name).replaceAll("/", ".")}`;
		try {
			if (kind === "file") readBounded(path, 128 * 1024);
			else {
				if (!statSync(path).isDirectory()) throw new ProbeError("not-directory");
				const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
				closeSync(fd);
			}
			return result(id, scope, "pass", `Readable expected ${kind}: ${name}`, start);
		} catch (error) {
			if (errno(error) === "ENOENT")
				return result(
					id,
					scope,
					!required || phase === "preflight" ? "skip" : "fail",
					`${name}: ENOENT; ${!required ? "optional prompt" : phase === "preflight" ? "boot-created layout not yet required" : "required installed layout missing"}`,
					start,
				);
			return failure(id, scope, error, start, `Inspect ${name}`);
		}
	});
}
function capacity(path: string, id: string, scope: string): HealthResult {
	const start = performance.now();
	try {
		const fs = statfsSync(path, { bigint: true });
		const bytes = fs.bavail * fs.bsize;
		const freePercent = fs.files > 0n ? Number((fs.ffree * 10000n) / fs.files) / 100 : null;
		const status =
			bytes < 1024n ** 3n || (freePercent !== null && freePercent < 1)
				? "fail"
				: bytes < 5n * 1024n ** 3n ||
						(freePercent !== null && freePercent < 10) ||
						freePercent === null
					? "warn"
					: "pass";
		return result(
			id,
			scope,
			status,
			`Available ${bytes} bytes; free inodes ${freePercent === null ? "unreported" : `${freePercent}%`}; capacity is not a write/fsync guarantee`,
			start,
		);
	} catch (error) {
		return failure(id, scope, error, start, `statfs ${path}`);
	}
}

async function sqlite(
	home: string,
	phase: HealthReport["phase"],
	signal?: AbortSignal,
): Promise<HealthResult> {
	const start = performance.now(),
		scope = `caller-home:${home};diagnostic-revision`,
		id = "sqlite";
	if (phase === "preflight")
		return result(
			id,
			scope,
			"skip",
			"Database and additive schema initialized at first boot; not required preflight",
			start,
		);
	try {
		const path = join(home, "state/goblin.sqlite");
		if (!statSync(path).isFile()) throw new ProbeError("not-regular-file");
		const raw = await command(
			[process.execPath, "--no-install", join(import.meta.dir, "health-sqlite.ts"), path],
			5000,
			signal,
		);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new ProbeError("invalid-worker-JSON");
		}
		const report = sqliteProbeSchema.safeParse(parsed);
		if (!report.success) throw new ProbeError("invalid-worker-schema");
		return result(
			id,
			scope,
			report.data.status,
			report.data.category === "compatible"
				? "Read-only WAL-aware quick_check and required base structure compatible with diagnostic revision; optional subsystem schemas and installed revision unverified; SHM bookkeeping permitted"
				: `Diagnostic-revision compatibility/integrity: ${report.data.category}; not a claim of installed-schema corruption`,
			start,
		);
	} catch (error) {
		return failure(id, scope, error, start, "Read-only SQLite worker");
	}
}

async function installation(
	checkout: string,
	phase: HealthReport["phase"],
	signal?: AbortSignal,
): Promise<HealthResult[]> {
	const start = performance.now(),
		scope = `diagnostic-revision:${checkout}`;
	if (phase === "preflight")
		return [
			result("service.goblin", scope, "skip", "Unit not required before installation", start),
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
	try {
		const raw = await command(
			[
				"systemctl",
				"--user",
				"show",
				"goblin.service",
				"--property=LoadState,ActiveState,SubState,WorkingDirectory",
			],
			2000,
			signal,
		);
		const properties: Record<string, string> = {};
		for (const line of raw.trim().split("\n")) {
			const match = /^(LoadState|ActiveState|SubState|WorkingDirectory)=(.*)$/.exec(line);
			if (!match?.[1] || match[2] === undefined || Object.hasOwn(properties, match[1]))
				throw new ProbeError("invalid-systemd-properties");
			properties[match[1]] = match[2];
		}
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
		/^([a-z][a-z0-9_-]{0,63}): (READY|MISSING|LOCKED|BROKEN)  age=([^ ]+)  keys=(\d+)(?:  names=([A-Za-z_][A-Za-z0-9_]*(?: [A-Za-z_][A-Za-z0-9_]*)*))?$/.exec(
			first,
		);
	if (!match || match[1] !== profile) throw new ProbeError("unverified-status-contract");
	const names = new Set(match[5]?.split(" ") ?? []);
	if (Number(match[4]) !== names.size) throw new ProbeError("invalid-status-key-count");
	let ageSeconds: number | null = null;
	if (match[2] === "READY") {
		const duration = match[3] ?? "";
		if (!/^(?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?$/.test(duration) || !duration)
			throw new ProbeError("unverified-status-age");
		ageSeconds = [...duration.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)].reduce(
			(sum, m) => sum + Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1),
			0,
		);
	} else if (match[3] !== "none" || names.size !== 0)
		throw new ProbeError("invalid-unavailable-status");
	return { state: match[2] ?? "BROKEN", ageSeconds, names };
}
async function snapshots(
	profiles: Map<string, Set<string>>,
	phase: HealthReport["phase"],
	signal?: AbortSignal,
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
					id = `keys.snapshot.${index + 1}`,
					scope = "caller-home;operator-wallet";
				try {
					const raw = await command(["pass-keys", "status", profile], 3000, signal, true);
					const status = snapshotLine(raw, profile);
					const missing = [...needed].filter((name) => !status.names.has(name)).length;
					return result(
						id,
						scope,
						status.state !== "READY" || missing
							? "fail"
							: (status.ageSeconds ?? 0) > 86400
								? "warn"
								: "pass",
						`${status.state}; ${needed.size} needed key names checked, ${missing} missing; snapshot age ${status.ageSeconds ?? "unavailable"} seconds; values never read; status interface pinned from source, wallet implementation not independently verified`,
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
					signal,
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

async function http(
	url: string,
	timeoutMs: number,
	signal?: AbortSignal,
	body?: string,
): Promise<{ status: number; text: string }> {
	if (signal?.aborted) throw new ProbeError("cancelled");
	const controller = new AbortController();
	let expired = false;
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => {
		expired = true;
		abort();
	}, timeoutMs);
	let reader:
		| {
				read(): Promise<{ done?: boolean; value?: Uint8Array }>;
				cancel(): Promise<void>;
				releaseLock(): void;
		  }
		| undefined;
	try {
		const response = await fetch(url, {
			method: body ? "POST" : "GET",
			...(body ? { body, headers: { "Content-Type": "application/json" } } : {}),
			signal: controller.signal,
			redirect: "error",
		});
		const chunks: Uint8Array[] = [];
		let size = 0;
		reader = response.body?.getReader();
		if (reader)
			for (;;) {
				const item = await reader.read();
				if (item.done) break;
				if (!item.value) throw new ProbeError("invalid-HTTP-stream");
				size += item.value.byteLength;
				if (size > 64 * 1024) {
					controller.abort();
					throw new ProbeError("oversized-HTTP-body");
				}
				chunks.push(item.value);
			}
		return { status: response.status, text: Buffer.concat(chunks).toString("utf8") };
	} catch (error) {
		throw new ProbeError(
			signal?.aborted
				? "cancelled"
				: expired
					? "deadline"
					: error instanceof ProbeError
						? error.category
						: "HTTP-transport-or-body-error",
		);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		controller.abort();
		if (reader) {
			void reader.cancel().catch(() => {
				/* Aborted body is already closed. */
			});
			reader.releaseLock();
		}
	}
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

async function localMemory(config: Config, signal?: AbortSignal): Promise<HealthResult[]> {
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
		const unit = readBounded(
			join(homedir(), ".config/containers/systemd/goblin-memory-api.container"),
			64 * 1024,
		).text;
		if (
			!/^ContainerName=goblin-memory-api$/m.test(unit) ||
			!/^PublishPort=127\.0\.0\.1:8888:8888$/m.test(unit) ||
			!/^EnvironmentFile=%h\/\.config\/goblin-memory\/hindsight\.env$/m.test(unit)
		)
			throw new ProbeError("unverified-installed-API-association");
		// Only running flag, published bindings and mount sources are requested.
		const raw = await command(
			[
				"podman",
				"inspect",
				"--format",
				'{"running":{{json .State.Running}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}}}',
				"goblin-memory-api",
			],
			2000,
			signal,
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
				ports: z.record(
					z.string(),
					z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable(),
				),
				mounts: z.array(z.object({ Source: z.string(), Destination: z.string() })).max(64),
			})
			.safeParse(parsed);
		if (
			!meta.success ||
			!meta.data.running ||
			!meta.data.ports["8888/tcp"]?.some(
				(port) => port.HostIp === "127.0.0.1" && port.HostPort === "8888",
			) ||
			!meta.data.mounts.some(
				(mount) =>
					mount.Source === join(cfg, "start.py") &&
					mount.Destination === "/opt/goblin-memory-start.py",
			)
		)
			throw new ProbeError("unverified-running-API-association");
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
				await memoryVolume(signal),
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
		await memoryVolume(signal),
	];
	const embedStart = performance.now();
	try {
		const response = await http(
			`http://${embedding.address}:11435/api/embed`,
			15000,
			signal,
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
async function memoryVolume(signal?: AbortSignal): Promise<HealthResult> {
	const start = performance.now(),
		scope = "caller-home;local-memory-volume";
	try {
		const raw = await command(
			["podman", "volume", "inspect", "--format", "{{json .Mountpoint}}", "goblin-memory-db"],
			2000,
			signal,
		);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new ProbeError("invalid-volume-metadata");
		}
		const point = z.string().max(4096).refine(isAbsolute).safeParse(parsed);
		if (!point.success) throw new ProbeError("invalid-volume-mountpoint");
		const checked = capacity(point.data, "storage.memory-volume", scope);
		// Do not emit external metadata paths, even through filesystem failures.
		if (checked.status === "fail")
			checked.detail = `Memory volume statfs/capacity failed; ${checked.detail.startsWith("Available") ? checked.detail : "filesystem inspection unavailable"}`;
		const mountRaw = await command(
			["podman", "inspect", "--format", "{{json .Mounts}}", "goblin-memory-db"],
			2000,
			signal,
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
		return checked;
	} catch (error) {
		return result(
			"storage.memory-volume",
			scope,
			"warn",
			`PostgreSQL filesystem coverage unverified: ${errno(error)}; home capacity does not cover it`,
			start,
		);
	}
}
async function memory(config: Config | undefined, signal?: AbortSignal): Promise<HealthResult[]> {
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
		];
	const start = performance.now();
	let ready: HealthResult;
	try {
		const response = await http(
			`${config.memory.baseUrl.replace(/\/$/, "")}/health/ready`,
			5000,
			signal,
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
		...(await localMemory(config, signal)),
	];
}

export async function runHealth(options: {
	home: string;
	checkout: string;
	phase: "preflight" | "installed";
	signal?: AbortSignal;
}): Promise<HealthReport> {
	const home = resolve(options.home),
		checkout = resolve(options.checkout);
	const checkedAt = new Date().toISOString();
	const config = configCheck(home);
	const auth = authCheck(home, config.config);
	const local = [
		config.finding,
		...auth.findings,
		...workspace(home, options.phase),
		capacity(home, "storage.home", `caller-home:${home}`),
	];
	const [db, install, keys, mem] = await Promise.all([
		sqlite(home, options.phase, options.signal),
		installation(checkout, options.phase, options.signal),
		snapshots(auth.profiles, options.phase, options.signal),
		memory(config.config, options.signal),
	]);
	return healthReportSchema.parse({
		version: 1,
		checkedAt,
		phase: options.phase,
		target: { home, checkout },
		results: [...local, db, ...install, ...keys, ...mem],
	});
}
