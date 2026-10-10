import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectDoctorReport,
	formatDoctorReport,
	parseDoctorArgs,
	reportExitCode,
} from "./doctor.ts";
import type { HealthReport } from "./health.ts";

const report: HealthReport = {
	version: 1,
	checkedAt: new Date(0).toISOString(),
	phase: "installed",
	target: { home: "/fixture/home", checkout: "/fixture/checkout" },
	results: [
		{
			id: "fixture",
			status: "pass",
			scope: "caller",
			detail: "checked",
			durationMs: 0,
		},
	],
};

describe("doctor report contract", () => {
	test("phase defaults and invalid arguments", () => {
		expect(parseDoctorArgs([])).toEqual({
			json: false,
			strict: false,
			phase: "installed",
			worker: false,
			help: false,
		});
		expect(parseDoctorArgs(["--json", "--strict", "--phase", "preflight"]).phase).toBe("preflight");
		for (const args of [["--phase", "repair"], ["--unknown"], ["unexpected"]]) {
			expect(() => parseDoctorArgs(args)).toThrow();
		}
	});
	test("warnings fail only in strict mode; skips never conceal recorded failures", () => {
		expect(reportExitCode(report)).toBe(0);
		const warning: HealthReport = {
			...report,
			results: [{ ...report.results[0]!, status: "warn" }],
		};
		expect(reportExitCode(warning)).toBe(0);
		expect(reportExitCode(warning, true)).toBe(1);
		expect(
			reportExitCode({ ...report, results: [{ ...report.results[0]!, status: "fail" }] }),
		).toBe(1);
		expect(formatDoctorReport(warning)).toContain("1 warnings");
	});
	test("text output does not permit control-character injection", () => {
		expect(
			formatDoctorReport({ ...report, target: { ...report.target, home: "/x\nFAIL forged" } }),
		).not.toContain("/x\nFAIL");
	});
});

describe("doctor process boundary", () => {
	test("validates the actual worker's JSON boundary", async () => {
		const returned = await collectDoctorReport({
			phase: "installed",
			workerCommand: [
				process.execPath,
				"-e",
				`process.stdout.write(${JSON.stringify(JSON.stringify(report))})`,
			],
		});
		expect(returned).toEqual(report);
	});
	test("invalid output and process errors never expose arbitrary stdout/stderr", async () => {
		const marker = "DOCTOR_FAKE_SECRET_SENTINEL";
		for (const code of [
			`process.stdout.write("${marker}")`,
			`process.stdout.write(JSON.stringify({extra:"${marker}"}))`,
			`process.stderr.write("${marker}");process.exit(1)`,
		]) {
			try {
				await collectDoctorReport({
					phase: "installed",
					workerCommand: [process.execPath, "-e", code],
				});
				throw new Error("expected protocol failure");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).not.toContain(marker);
				expect((error as Error).message).toMatch(/diagnostic worker/);
			}
		}
	});
	test("a stalled worker is killed by the real deadline", async () => {
		const start = performance.now();
		await expect(
			collectDoctorReport({
				phase: "installed",
				timeoutMs: 100,
				workerCommand: [process.execPath, "-e", "setInterval(()=>{}, 1000)"],
			}),
		).rejects.toThrow("diagnostic deadline exceeded");
		expect(performance.now() - start).toBeLessThan(2500);
	});
	for (const outcome of ["timeout", "cancel", "complete"] as const)
		test(`${outcome} cleans inherited descendants even without a responsive worker`, async () => {
			const directory = mkdtempSync(join(tmpdir(), "doctor-group-"));
			const pids = join(directory, "pids");
			const descendants = join(directory, "descendants");
			const signal = new AbortController();
			const worker = `
				import { spawnProc } from ${JSON.stringify(join(import.meta.dir, "proc.ts"))};
				import { writeFileSync, readFileSync, existsSync } from "node:fs";
				const helper = spawnProc(["/bin/sh", "-c", ${JSON.stringify(`trap '' TERM; /bin/sleep 60 & printf '%s %s' "$$" "$!" > '${descendants}'; wait`)}], undefined, undefined, "inherit");
				while (!existsSync(${JSON.stringify(descendants)})) await Bun.sleep(1);
				writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, ...readFileSync(${JSON.stringify(descendants)}, "utf8").split(" ").map(Number)]));
				${
					outcome === "complete"
						? `process.stdout.write(${JSON.stringify(JSON.stringify(report))}); process.exit(0);`
						: 'process.on("SIGTERM", () => {}); while (true) {}'
				}
			`;
			let ids: number[] = [];
			try {
				const pending = collectDoctorReport({
					phase: "installed",
					timeoutMs: 400,
					signal: signal.signal,
					workerCommand: [process.execPath, "-e", worker],
				});
				// Attach rejection before polling so the deadline cannot be unhandled.
				const settled = pending.then(
					(value) => ({ value, error: "" }),
					(error: unknown) => ({
						value: null,
						error: error instanceof Error ? error.message : "unknown",
					}),
				);
				for (let i = 0; i < 100 && !existsSync(pids); i++) await Bun.sleep(5);
				expect(existsSync(pids)).toBe(true);
				ids = JSON.parse(readFileSync(pids, "utf8")) as number[];
				if (outcome === "cancel") signal.abort();
				const returned = await settled;
				if (outcome === "complete") expect(returned.value).toEqual(report);
				else
					expect(returned.error).toBe(
						outcome === "cancel" ? "diagnostics cancelled" : "diagnostic deadline exceeded",
					);
				for (let i = 0; i < 100; i++) {
					const alive = ids.filter((pid) => {
						try {
							return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] !== "Z";
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
							throw error;
						}
					});
					if (!alive.length) break;
					await Bun.sleep(5);
				}
				for (const pid of ids) {
					if (existsSync(`/proc/${pid}/stat`))
						expect(readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2]).toBe("Z");
				}
			} finally {
				for (const pid of ids) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						/* Already gone. */
					}
				}
				rmSync(directory, { recursive: true, force: true });
			}
		}, 5000);
	test("the shipped command returns one JSON report without bootstrapping or executing auth refs", async () => {
		const directory = mkdtempSync(join(tmpdir(), "goblin-doctor-cli-"));
		const home = join(directory, "goblin");
		mkdirSync(home);
		const marker = "CLI_FAKE_SECRET_SENTINEL";
		try {
			writeFileSync(
				join(home, "goblin.json5"),
				JSON.stringify({
					providers: {
						fixture: {
							kind: "openai-compatible",
							baseUrl: "https://provider.invalid/v1",
							auth: "fixture",
						},
					},
					model: "fixture/test",
					allowedUsers: [1],
					tts: "",
				}),
			);
			const auth = join(home, "auth.jsonl");
			writeFileSync(
				auth,
				[
					JSON.stringify({ name: "telegram", value: marker }),
					JSON.stringify({ name: "fixture", value: `!printf ${marker}` }),
				].join("\n"),
			);
			chmodSync(auth, 0o600);
			const before = readFileSync(auth, "utf8");
			const proc = Bun.spawn(
				[process.execPath, join(import.meta.dir, "doctor.ts"), "--phase", "preflight", "--json"],
				{
					env: { ...process.env, GOBLIN_HOME: home, HOME: directory, PATH: home },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(code).toBe(0);
			expect(stdout.trim().split("\n")).toHaveLength(1);
			expect(stdout + stderr).not.toContain(marker);
			const parsed = JSON.parse(stdout) as HealthReport;
			expect(parsed.phase).toBe("preflight");
			expect(parsed.target.home).toBe(home);
			expect(parsed.results.some((r) => r.id === "config" && r.status === "pass")).toBe(true);
			expect(readFileSync(auth, "utf8")).toBe(before);
			expect(readdirSync(home).sort()).toEqual(["auth.jsonl", "goblin.json5"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
