import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireHomeLock } from "./home-lock.ts";
import { log } from "./log.ts";
import { tmpDir } from "./testkit.ts";

afterEach(() => {
	mock.restore();
});

function home(): string {
	const dir = join(tmpDir(), `home-lock-${crypto.randomUUID()}`);
	mkdirSync(join(dir, "state"), { recursive: true });
	return dir;
}

function lockPath(dir: string): string {
	return join(dir, "state", "goblin.pid");
}

function bootId(): string {
	return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

function startTicks(pid: number): string {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const closeParen = stat.lastIndexOf(")");
	if (closeParen === -1) throw new Error(`malformed /proc/${pid}/stat`);
	const field = stat.slice(closeParen + 1).trim().split(/\s+/)[19];
	if (field === undefined) throw new Error(`missing start time in /proc/${pid}/stat`);
	return field;
}

function writeIdentity(
	dir: string,
	pid: number | string,
	ownerBootId = bootId(),
	ownerStartTicks = startTicks(Number(pid)),
): void {
	writeFileSync(lockPath(dir), `${pid} ${ownerBootId} ${ownerStartTicks}\n`);
}

describe("home lock", () => {
	test("creates a PID file and release removes it", () => {
		const dir = home();
		const lock = acquireHomeLock(dir);
		expect(readFileSync(lockPath(dir), "utf8")).toBe(
			`${process.pid} ${bootId()} ${startTicks(process.pid)}\n`,
		);
		lock.release();
		expect(() => readFileSync(lockPath(dir), "utf8")).toThrow();
	});

	test("refuses a live foreign process", async () => {
		const dir = home();
		const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		try {
			writeIdentity(dir, child.pid);
			expect(() => acquireHomeLock(dir)).toThrow(
				`another goblin process (pid ${child.pid}) owns ${dir} — stop it first`,
			);
		} finally {
			child.kill("SIGTERM");
			await child.exited;
		}
	});

	test("takes over a dead PID and logs the takeover", async () => {
		const dir = home();
		const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		const childStartTicks = startTicks(child.pid);
		child.kill("SIGTERM");
		await child.exited;
		writeIdentity(dir, child.pid, bootId(), childStartTicks);
		const warn = spyOn(log, "warn");
		const lock = acquireHomeLock(dir);
		try {
			expect(readFileSync(lockPath(dir), "utf8")).toBe(
				`${process.pid} ${bootId()} ${startTicks(process.pid)}\n`,
			);
			expect(warn).toHaveBeenCalledWith("home lock stale — taking over", {
				pid: child.pid,
				home: dir,
			});
		} finally {
			lock.release();
		}
	});

	test("takes over malformed contents", () => {
		const dir = home();
		writeFileSync(lockPath(dir), "not-a-pid\n");
		const warn = spyOn(log, "warn");
		const lock = acquireHomeLock(dir);
		try {
			expect(readFileSync(lockPath(dir), "utf8")).toBe(
				`${process.pid} ${bootId()} ${startTicks(process.pid)}\n`,
			);
			expect(warn).toHaveBeenCalledWith("home lock stale — taking over", {
				pid: null,
				home: dir,
			});
		} finally {
			lock.release();
		}
	});

	test("takes over a legacy PID-only lock", () => {
		const dir = home();
		writeFileSync(lockPath(dir), `${process.pid}\n`);
		const lock = acquireHomeLock(dir);
		try {
			expect(readFileSync(lockPath(dir), "utf8")).toBe(
				`${process.pid} ${bootId()} ${startTicks(process.pid)}\n`,
			);
		} finally {
			lock.release();
		}
	});

	test("takes over a live PID with a different start time", async () => {
		const dir = home();
		const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		try {
			const actualStartTicks = startTicks(child.pid);
			writeIdentity(dir, child.pid, bootId(), String(Number(actualStartTicks) + 1));
			const lock = acquireHomeLock(dir);
			try {
				expect(readFileSync(lockPath(dir), "utf8")).toBe(
					`${process.pid} ${bootId()} ${startTicks(process.pid)}\n`,
				);
			} finally {
				lock.release();
			}
		} finally {
			child.kill("SIGTERM");
			await child.exited;
		}
	});

	test("takes over a live PID from a different boot", async () => {
		const dir = home();
		const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		try {
			writeIdentity(dir, child.pid, "00000000-0000-0000-0000-000000000000");
			const lock = acquireHomeLock(dir);
			try {
				expect(readFileSync(lockPath(dir), "utf8")).toBe(
					`${process.pid} ${bootId()} ${startTicks(process.pid)}\n`,
				);
			} finally {
				lock.release();
			}
		} finally {
			child.kill("SIGTERM");
			await child.exited;
		}
	});

	test("a second acquire in this process is a bug", () => {
		const dir = home();
		const lock = acquireHomeLock(dir);
		try {
			expect(() => acquireHomeLock(dir)).toThrow(
				`goblin process (pid ${process.pid}) already owns ${dir}`,
			);
		} finally {
			lock.release();
		}
	});

	test("release leaves a lock owned by another PID alone", () => {
		const dir = home();
		const lock = acquireHomeLock(dir);
		const other = `${process.pid + 1} ${bootId()} ${startTicks(process.pid)}\n`;
		writeFileSync(lockPath(dir), other);
		lock.release();
		expect(readFileSync(lockPath(dir), "utf8")).toBe(other);
	});
});
