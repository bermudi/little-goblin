import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { startupAction, withNameLock, type CheckoutIdentity } from "./coordination.ts";

describe("throwaway instance startup coordination", () => {
	test("a different recorded commit requires restart", () => {
		const recorded: CheckoutIdentity = {
			repo: "/work/goblin",
			commit: "old-commit",
			dirty: false,
		};
		const current: CheckoutIdentity = {
			repo: "/work/goblin",
			commit: "new-commit",
			dirty: false,
		};
		expect(startupAction(recorded, current)).toBe("restart");
	});

	test("two starts of one name never enter startup at the same time", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-try-lock-"));
		const lockPath = join(dir, "same-name.lock");
		let active = 0;
		let maximumActive = 0;
		let releases: Array<() => void> = [];
		let waits = 0;
		const start = (): Promise<void> =>
			withNameLock(
				lockPath,
				async () => {
					active += 1;
					maximumActive = Math.max(maximumActive, active);
					await new Promise<void>((resolve) => releases.push(resolve));
					active -= 1;
				},
				() => {
					waits += 1;
				},
			);

		const first = start();
		await Bun.sleep(20);
		const second = start();
		await Bun.sleep(20);
		expect(active).toBe(1);
		expect(waits).toBeGreaterThan(0);
		releases.shift()?.();
		for (let attempt = 0; releases.length === 0 && attempt < 300; attempt += 1) {
			await Bun.sleep(10);
		}
		expect(active).toBe(1);
		releases.shift()?.();
		await Promise.all([first, second]);
		expect(maximumActive).toBe(1);

		try {
			unlinkSync(lockPath);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		}
		expect(() => readFileSync(lockPath)).toThrow();
		rmdirSync(dir);
	});

	test("a lock owned by a dead PID is recovered", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-try-stale-lock-"));
		const lockPath = join(dir, "name.lock");
		writeFileSync(lockPath, "2147483647\n");
		let entered = false;
		await withNameLock(
			lockPath,
			async () => {
				entered = true;
			},
			() => {},
		);
		expect(entered).toBe(true);
		expect(() => readFileSync(lockPath)).toThrow();
		rmdirSync(dir);
	});

	test("an empty lock left by a crash is recovered after the grace period", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-try-empty-lock-"));
		const lockPath = join(dir, "name.lock");
		writeFileSync(lockPath, "");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lockPath, old, old);
		let entered = false;
		await withNameLock(
			lockPath,
			async () => {
				entered = true;
			},
			() => {},
		);
		expect(entered).toBe(true);
		expect(() => readFileSync(lockPath)).toThrow();
		rmdirSync(dir);
	});
});
