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

export async function acceptStartup(port: number, budgetMs = 60_000): Promise<void> {
	if (!Number.isInteger(port) || port < 0 || port > 65535 || budgetMs < 1)
		throw new Error("invalid startup arguments");
	const deadline = performance.now() + budgetMs;
	const remaining = (): number => {
		const time = deadline - performance.now();
		if (time <= 0) throw new Error("startup deadline expired");
		return time;
	};
	async function run(argv: string[], label: string): Promise<string> {
		let result;
		try {
			// Share the acceptance worker group so the installer's outer timeout reaches nested probes.
			const proc = Bun.spawn(argv, {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				detached: false,
				env: process.env,
			});
			result = await boundedRun(proc, {
				timeoutMs: Math.min(5000, remaining()),
				maxOutput: 1024 * 1024,
			});
		} catch {
			throw new Error(`${label}: inspection failed`);
		}
		if (result.exitCode !== 0 || result.timedOut || result.truncated)
			throw new Error(`${label}: command failed/timeout/output limit`);
		return result.stdout;
	}
	async function identity(): Promise<Identity> {
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
	const baseline = await identity();
	if (baseline.ActiveState !== "inactive" || baseline.InvocationID !== "")
		throw new Error("startup refuses existing invocation");
	// Linux uptime includes suspend; it is not systemd's monotonic start clock.
	const attemptedAt = Date.now() * 1000;
	await run(["systemctl", "--user", "enable", "--now", "goblin.service"], "start service");
	let current: Identity | undefined;
	let boundPort = port === 0 ? undefined : port;
	const seen = new Set<string>();
	while (true) {
		remaining();
		const observed = await identity();
		if (
			observed.NRestarts !== baseline.NRestarts ||
			observed.ActiveState === "failed" ||
			observed.ActiveState === "deactivating"
		)
			throw new Error("startup failed or restarted");
		if (observed.InvocationID !== "") {
			if (observed.ExecMainStartTimestampMonotonic <= baseline.ExecMainStartTimestampMonotonic)
				throw new Error("startup identity predates attempted start");
			current ??= observed;
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
					const final = await identity();
					if (
						final.InvocationID !== current.InvocationID ||
						final.ExecMainStartTimestampMonotonic !== current.ExecMainStartTimestampMonotonic ||
						final.NRestarts !== baseline.NRestarts ||
						final.ActiveState !== "active"
					)
						throw new Error("startup changed during HTTP acceptance");
					return;
				}
			}
		}
		await Bun.sleep(Math.min(250, remaining()));
	}
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
	try {
		await acceptStartup(Number(process.argv[2]));
		process.stderr.write("install: current invocation boot/polling/HTTP accepted\n");
	} catch (error) {
		// Only locally constructed categories escape this process.
		const category =
			error instanceof Error
				? (startupCategory(error.message) ?? "startup inspection failed")
				: "startup inspection failed";
		process.stderr.write(`install: ${category}\n`);
		process.exitCode = 1;
	}
}
