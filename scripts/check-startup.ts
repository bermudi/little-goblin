import { z } from "zod";
import { boundedRun } from "../src/proc.ts";
import { startupCategory } from "./startup-categories.ts";

const identitySchema = z.object({
	InvocationID: z.string().regex(/^(?:[a-f0-9]{32})?$/),
	ExecMainStartTimestampMonotonic: z.coerce.number().int().nonnegative(),
	NRestarts: z.coerce.number().int().nonnegative(),
	ActiveState: z.enum(["inactive", "activating", "active", "failed", "deactivating", "reloading"]),
});
type Identity = z.infer<typeof identitySchema>;
const journalSchema = z.object({
	_SYSTEMD_INVOCATION_ID: z.string(),
	__MONOTONIC_TIMESTAMP: z.string().regex(/^\d+$/),
	__REALTIME_TIMESTAMP: z.string().regex(/^\d+$/),
	MESSAGE: z.string(),
});
const lifecycleSchema = z.object({ msg: z.string() });
const readySchema = z.object({ port: z.number().int().min(1).max(65535).optional() });
const events = new Set(["goblin up", "long polling started", "boot failed", "long polling failed"]);
// The brief's journal projection: MESSAGE is private input, so nothing
// required beyond shape — systemd's own lines carry no invocation id.
const briefSchema = z.object({
	SYSLOG_IDENTIFIER: z.string().optional(),
	_SYSTEMD_INVOCATION_ID: z.string().optional(),
	__REALTIME_TIMESTAMP: z.string().regex(/^\d+$/).optional(),
	MESSAGE: z.string(),
});

// The pre-restart identity a watched invocation must postdate — deploy
// measures it BEFORE `systemctl restart`, so a crash/restart between the
// restart and this process booting can never be adopted as the watched
// one. Both fields come from `systemctl show --value`.
export interface WatchFloor {
	invocationId: string; // "" when the unit was inactive
	monotonic: number; // ExecMainStartTimestampMonotonic
}

// One probe with an absolute deadline — nested commands get at most 5s
// and never outlast the caller's budget. The enable/start commands
// return instantly; the poll loop below, not any command, owns the
// wait behind the ordered network-online stub.
async function run(argv: string[], label: string, deadline: number): Promise<string> {
	const time = deadline - performance.now();
	if (time <= 0) throw new Error("startup deadline expired");
	// A command killed by its deadline-clamped timeout is a deadline expiry,
	// not a command failure — the budget is the verdict.
	const expired = () => {
		if (performance.now() >= deadline) throw new Error("startup deadline expired");
	};
	let result;
	try {
		const proc = Bun.spawn(argv, {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: false,
			env: process.env,
		});
		result = await boundedRun(proc, {
			timeoutMs: Math.min(5000, time),
			maxOutput: 1024 * 1024,
		});
	} catch (error) {
		expired();
		throw new Error(`${label}: inspection failed`, { cause: error });
	}
	if (result.exitCode !== 0 || result.timedOut || result.truncated) {
		expired();
		throw new Error(`${label}: command failed/timeout/output limit`);
	}
	return result.stdout;
}

async function identity(deadline: number): Promise<Identity> {
	const fields = ["InvocationID", "ExecMainStartTimestampMonotonic", "NRestarts", "ActiveState"];
	const raw = await run(
		[
			"systemctl",
			"--user",
			"show",
			"goblin.service",
			...fields.map((field) => `--property=${field}`),
		],
		"service identity",
		deadline,
	);
	const parsed = identitySchema.safeParse(
		Object.fromEntries(
			raw
				.trim()
				.split("\n")
				.map((line) => {
					const split = line.indexOf("=");
					return [line.slice(0, split), line.slice(split + 1)];
				}),
		),
	);
	if (!parsed.success) throw new Error("service identity: invalid response");
	return parsed.data;
}

// One grammar, two entries: install starts a confirmed-inactive unit, deploy
// watches the invocation its restart just created — pinned by a floor the
// caller measured before restarting, so an invocation predating the
// restart can never be accepted.
async function watchInvocation(
	entry: "accept" | "watch",
	port: number,
	budgetMs: number,
	floor?: WatchFloor,
): Promise<void> {
	// NaN budget must fail validation, not become a deadline that never expires.
	if (
		!Number.isInteger(port) ||
		port < 0 ||
		port > 65535 ||
		!(budgetMs >= 1) ||
		(floor !== undefined &&
			(!/^(?:[a-f0-9]{32})?$/.test(floor.invocationId) ||
				!Number.isInteger(floor.monotonic) ||
				floor.monotonic < 0))
	)
		throw new Error("invalid startup arguments");
	const deadline = performance.now() + budgetMs;
	const remaining = (): number => {
		const time = deadline - performance.now();
		if (time <= 0) throw new Error("startup deadline expired");
		return time;
	};
	const baseline = await identity(deadline);
	// What an accepted invocation must postdate. accept's floor is the
	// confirmed-inactive unit: an empty id plus the last invocation's
	// monotonic — a fresh start is strictly newer. A floored watch trusts
	// the caller's pre-restart measurement; an unfloored watch trusts the
	// first observation (ad-hoc use only — deploy always floors).
	let floorId: string | undefined;
	let floorMono = 0;
	// A manual restart resets NRestarts to 0; the watched invocation must
	// arrive clean.
	let expectedRestarts = baseline.NRestarts;
	// accept floors journal evidence at the attempted start; watch's
	// invocation began before the watch, so its floor is 0 (no realtime
	// filter).
	let attemptedAt = 0;
	if (entry === "accept") {
		if (baseline.ActiveState !== "inactive" || baseline.InvocationID !== "")
			throw new Error("startup refuses existing invocation");
		floorId = "";
		floorMono = baseline.ExecMainStartTimestampMonotonic;
		expectedRestarts = 0;
		// Linux uptime includes suspend; it is not systemd's monotonic start clock.
		attemptedAt = Date.now() * 1000;
		// enable is instant bookkeeping and --no-block returns while the
		// start job queues — the unit can sit activating behind the
		// ordered network wait (podman-user-wait-network-online can hold
		// it 90s) while this loop owns acceptance to the outer budget.
		await run(["systemctl", "--user", "enable", "goblin.service"], "enable service", deadline);
		await run(
			["systemctl", "--user", "start", "--no-block", "goblin.service"],
			"start service",
			deadline,
		);
	} else if (floor !== undefined) {
		floorId = floor.invocationId;
		floorMono = floor.monotonic;
		expectedRestarts = 0;
	} else if (baseline.ActiveState !== "active" || baseline.InvocationID === "") {
		throw new Error("startup watch refuses missing invocation");
	}
	let current: Identity | undefined;
	let boundPort = port === 0 ? undefined : port;
	const seen = new Set<string>();
	while (true) {
		remaining();
		const observed = await identity(deadline);
		if (current === undefined) {
			// Between invocations — or, for a floored watch, still the
			// pre-restart one draining. Nothing to judge yet except a
			// failed unit, which is already a verdict.
			if (observed.InvocationID === "" || observed.InvocationID === floorId) {
				if (observed.ActiveState === "failed") throw new Error("startup failed or restarted");
				await Bun.sleep(Math.min(250, remaining()));
				continue;
			}
			if (floorId !== undefined && observed.ExecMainStartTimestampMonotonic <= floorMono)
				throw new Error("startup identity predates attempted start");
			current = observed;
		}
		if (
			observed.NRestarts !== expectedRestarts ||
			observed.ActiveState === "failed" ||
			observed.ActiveState === "deactivating"
		)
			throw new Error("startup failed or restarted");
		if (
			observed.InvocationID !== current.InvocationID ||
			observed.ExecMainStartTimestampMonotonic !== current.ExecMainStartTimestampMonotonic
		)
			throw new Error("startup invocation changed");
		if (observed.ActiveState === "inactive") throw new Error("startup exited");
		const raw = await run(
			[
				"journalctl",
				"--user",
				"--unit=goblin.service",
				"--no-pager",
				"--quiet",
				"--output=json",
				"--output-fields=_SYSTEMD_INVOCATION_ID,__MONOTONIC_TIMESTAMP,__REALTIME_TIMESTAMP,MESSAGE",
				`_SYSTEMD_INVOCATION_ID=${current.InvocationID}`,
			],
			"startup evidence",
			deadline,
		);
		for (const line of raw.split("\n").filter(Boolean)) {
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				throw new Error("startup evidence: invalid JSON");
			}
			const record = journalSchema.safeParse(value);
			if (!record.success) throw new Error("startup evidence: invalid record");
			if (
				record.data._SYSTEMD_INVOCATION_ID !== current.InvocationID ||
				Number(record.data.__MONOTONIC_TIMESTAMP) < current.ExecMainStartTimestampMonotonic ||
				Number(record.data.__REALTIME_TIMESTAMP) < attemptedAt
			)
				continue;
			// MESSAGE is private input: project only known lifecycle names, never exceptions/bodies.
			try {
				value = JSON.parse(record.data.MESSAGE);
			} catch {
				continue;
			}
			const event = lifecycleSchema.safeParse(value);
			if (!event.success || !events.has(event.data.msg)) continue;
			if (event.data.msg === "boot failed" || event.data.msg === "long polling failed")
				throw new Error("startup lifecycle failure");
			if (event.data.msg === "goblin up") {
				const ready = readySchema.safeParse(value);
				if (!ready.success) throw new Error("startup ready port invalid");
				if (ready.data.port !== undefined) {
					if (boundPort !== undefined && boundPort !== ready.data.port)
						throw new Error("startup ready port mismatch");
					boundPort = ready.data.port;
				}
			}
			seen.add(event.data.msg);
		}
		if (
			seen.has("goblin up") &&
			seen.has("long polling started") &&
			observed.ActiveState === "active" &&
			boundPort !== undefined
		) {
			if (await servedAssets(boundPort, deadline)) {
				const final = await identity(deadline);
				if (
					final.InvocationID !== current.InvocationID ||
					final.ExecMainStartTimestampMonotonic !== current.ExecMainStartTimestampMonotonic ||
					final.NRestarts !== expectedRestarts ||
					final.ActiveState !== "active"
				)
					throw new Error("startup changed during HTTP acceptance");
				return;
			}
		}
		await Bun.sleep(Math.min(250, remaining()));
	}
}

// The 90s ordered network wait (podman-user-wait-network-online) is a
// lower bound on how long the start job can take to even spawn goblin —
// the budget has to clear it plus boot, poll, and HTTP acceptance.
export async function acceptStartup(port: number, budgetMs = 120_000): Promise<void> {
	return watchInvocation("accept", port, budgetMs);
}

export async function watchStartup(
	port: number,
	budgetMs = 75_000,
	floor?: WatchFloor,
): Promise<void> {
	return watchInvocation("watch", port, budgetMs, floor);
}

// Optional trailing args of the --watch form: the pre-restart identity
// deploy measured — <invocation id> <start monotonic>. Both or neither.
function floorFromArgv(id: string | undefined, mono: string | undefined): WatchFloor | undefined {
	if (id === undefined && mono === undefined) return undefined;
	if (id === undefined || mono === undefined || !/^\d+$/.test(mono))
		throw new Error("invalid startup arguments");
	return { invocationId: id, monotonic: Number(mono) };
}

// --brief N: the deploy failure fallback under the same contract the
// watcher enforces — the journal MESSAGE is private input. Only systemd
// manager lines print verbatim (Started/Stopped/exit-status notices
// carry no user content); goblin's own entries project to their
// lifecycle event names; everything else is counted, never printed.
async function journalBrief(limit: number): Promise<string[]> {
	if (!Number.isInteger(limit) || limit < 1) throw new Error("invalid startup arguments");
	const deadline = performance.now() + 15_000;
	// Scope the projection to the current invocation when there is one —
	// a dead unit's brief falls back to unscoped diagnostics; the watch
	// already reported the real failure, this must not fail too.
	let currentId = "";
	try {
		currentId = (await identity(deadline)).InvocationID;
	} catch {
		currentId = "";
	}
	const raw = await run(
		[
			"journalctl",
			"--user",
			"--unit=goblin.service",
			"--no-pager",
			"--quiet",
			"--output=json",
			"--output-fields=SYSLOG_IDENTIFIER,_SYSTEMD_INVOCATION_ID,__REALTIME_TIMESTAMP,MESSAGE",
			"-n",
			"300",
		],
		"startup evidence",
		deadline,
	);
	const lines: string[] = [];
	let withheld = 0;
	for (const line of raw.split("\n").filter(Boolean)) {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error("startup evidence: invalid JSON");
		}
		const record = briefSchema.safeParse(value);
		if (!record.success) throw new Error("startup evidence: invalid record");
		const stamp =
			record.data.__REALTIME_TIMESTAMP === undefined
				? ""
				: `${new Date(Number(record.data.__REALTIME_TIMESTAMP) / 1000).toISOString()} `;
		if (record.data.SYSLOG_IDENTIFIER === "systemd") {
			lines.push(`${stamp}systemd: ${record.data.MESSAGE.slice(0, 240)}`);
			continue;
		}
		if (currentId !== "" && record.data._SYSTEMD_INVOCATION_ID !== currentId) {
			withheld++;
			continue;
		}
		// goblin's own JSONL — lifecycle event names only, never the
		// structured fields (they carry private runtime values).
		try {
			value = JSON.parse(record.data.MESSAGE);
		} catch {
			withheld++;
			continue;
		}
		const event = lifecycleSchema.safeParse(value);
		if (!event.success || !events.has(event.data.msg)) {
			withheld++;
			continue;
		}
		lines.push(`${stamp}goblin: ${event.data.msg}`);
	}
	if (withheld > 0) lines.push(`…and ${withheld} journal entries withheld — runtime fields stay private`);
	return lines.slice(-limit);
}

async function servedAssets(port: number, deadline: number): Promise<boolean> {
	const base = new URL(`http://127.0.0.1:${port}/app/`);
	async function request(url: URL): Promise<string | null> {
		const remaining = deadline - performance.now();
		if (remaining <= 0) throw new Error("startup deadline expired");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.min(4000, remaining));
		try {
			const response = await fetch(url, { signal: controller.signal, redirect: "error" });
			if (response.status !== 200 || !response.body) {
				process.stderr.write(
					`install: startup loopback ${url.pathname === "/app/" ? "HTML" : "asset"} unavailable (HTTP ${response.status})\n`,
				);
				await response.body?.cancel();
				return null;
			}
			if (
				url.pathname === "/app/" &&
				!response.headers.get("content-type")?.includes("text/html")
			) {
				await response.body.cancel();
				return null;
			}
			if (url.pathname !== "/app/" && response.headers.get("content-type")?.includes("text/html")) {
				await response.body.cancel();
				throw new Error("startup asset returned HTML instead of a local asset");
			}
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let total = 0;
			try {
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					total += chunk.value.byteLength;
					if (total > 8 * 1024 * 1024) throw new Error("startup asset output limit");
					chunks.push(chunk.value);
				}
			} finally {
				await reader.cancel();
			}
			return Buffer.concat(chunks).toString("utf8");
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("startup asset ")) throw error;
			process.stderr.write("install: startup loopback request failed or timed out\n");
			return null;
		} finally {
			clearTimeout(timer);
		}
	}
	const html = await request(base);
	if (html === null || !/<!doctype html/i.test(html) || !/id=["']root["']/.test(html)) return false;
	const assets: URL[] = [];
	for (const tag of html.matchAll(/<(?:script|link|img)\b[^>]*>/gi)) {
		for (const attribute of tag[0].matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
			const asset = new URL(attribute[1]!, base);
			if (asset.origin !== base.origin || !asset.pathname.startsWith("/app/"))
				throw new Error("startup HTML references unexpected asset origin/path");
			assets.push(asset);
		}
	}
	if (!assets.some((asset) => /\.js$/.test(asset.pathname))) return false;
	for (const asset of assets) if ((await request(asset)) === null) return false;
	return true;
}

if (import.meta.main) {
	const watch = process.argv[2] === "--watch";
	const brief = process.argv[2] === "--brief";
	try {
		if (watch)
			await watchStartup(
				Number(process.argv[3]),
				process.argv[4] === undefined ? undefined : Number(process.argv[4]),
				floorFromArgv(process.argv[5], process.argv[6]),
			);
		else if (brief) {
			const lines = await journalBrief(
				process.argv[3] === undefined ? 40 : Number(process.argv[3]),
			);
			for (const line of lines) process.stdout.write(`${line}\n`);
		} else await acceptStartup(Number(process.argv[2]));
		process.stderr.write(
			watch
				? "watch: startup accepted\n"
				: brief
					? ""
					: "install: current invocation boot/polling/HTTP accepted\n",
		);
	} catch (error) {
		// Only locally constructed categories escape this process.
		const category =
			error instanceof Error
				? (startupCategory(error.message) ?? "startup inspection failed")
				: "startup inspection failed";
		process.stderr.write(`${watch ? "watch" : brief ? "deploy" : "install"}: ${category}\n`);
		process.exitCode = 1;
	}
}
