import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";
import type { ContainerInspect, Podman } from "./podman.ts";
import { leaseLive, type DesktopStore } from "./desktops-store.ts";

// Retention and reaping moved from makeDesktops (#461). Parent-owned state
// is supplied through ctx; lane is the parent's live serialized operation.
export interface ReaperCtx {
	store: DesktopStore;
	podman: Podman;
	cfg(): { idleHours: number };
	shotsRoot: string;
	lane<T>(name: string, fn: () => Promise<T>): Promise<T>;
	requireOurs(name: string, ins: ContainerInspect): void;
	refuse(desktop: string, op: string, reason: string): Error;
	containerNameForDesktop(name: string): string;
	namePattern: RegExp;
}

export function makeReaper(ctx: ReaperCtx): {
	pruneShots(name: string): void;
	reapLocked(name: string, cutoff: number): Promise<void>;
	sweepOnce(name: string, op: string): void;
} {
	const { store, podman, shotsRoot } = ctx;
	const SHOTS_RETENTION = 200;

	function pruneShots(name: string): void {
		const dir = join(shotsRoot, name, "shots");
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
			throw err;
		}
		const over = names.length - SHOTS_RETENTION;
		if (over <= 0) return;
		const byAge: Array<{ file: string; mtime: number }> = [];
		for (const file of names) {
			try {
				byAge.push({ file, mtime: statSync(join(dir, file)).mtimeMs });
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw err;
			}
		}
		byAge.sort((a, b) => a.mtime - b.mtime);
		for (const { file } of byAge.slice(0, over)) {
			// Best-effort — a failed unlink must not fail the call
			// riding this prune; the log line says so.
			try {
				rmSync(join(dir, file));
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
				log.warn("desktop shot prune failed", err, { desktop: name, file });
			}
		}
		log.info("desktop shots pruned", { desktop: name, removed: over, kept: SHOTS_RETENTION });
	}

	// Re-read inside the victim's lane — a claim, observation, or pin
	// landing between the stale listing and the rm must win the race.
	// Same label guard as destroy/adopt: never touch a container the
	// labels don't claim.
	async function reapLocked(name: string, cutoff: number): Promise<void> {
		const fresh = store.get(name);
		if (
			fresh === null ||
			fresh.lastUsedAt >= cutoff ||
			fresh.reserved ||
			leaseLive(fresh, Date.now())
		) {
			return;
		}
		const ins = await podman.inspect(fresh.container);
		if (ins.state !== "missing") ctx.requireOurs(name, ins);
		await podman.rm(fresh.container);
		store.delete(name);
		pruneShots(name);
		log.info("desktop reaped", { desktop: name, container: fresh.container });
	}

	// Reaps ride one detached chain — the listing is synchronous in
	// the caller (its desktop exempt); reaping B never blocks acting
	// on A. Candidates coalesce into one set, single-flight.
	const reapQueue = new Map<string, number>();
	let reapTail: Promise<void> = Promise.resolve();
	let reapQueued = false;
	function enqueueReap(name: string, cutoff: number): void {
		reapQueue.set(name, cutoff);
		if (reapQueued) return;
		reapQueued = true;
		const run = reapTail.then(async () => {
			// Cleared at run start — arrivals during the run schedule
			// the follow-up instead of being dropped.
			reapQueued = false;
			while (reapQueue.size > 0) {
				const batch = [...reapQueue];
				reapQueue.clear();
				for (const [victim, cutoff] of batch) {
					try {
						await ctx.lane(victim, () => reapLocked(victim, cutoff));
					} catch (err) {
						// Keep the row — the next call retries.
						log.warn("desktop reap failed — row kept", err, {
							desktop: victim,
							container: ctx.containerNameForDesktop(victim),
						});
					}
				}
			}
		});
		run.catch((err) => {
			log.warn("desktop reap chain failed", err, { desktop: name });
		});
		reapTail = run.then(
			() => undefined,
			() => undefined,
		);
	}

	// Top of every entry point: the name check must precede pruneShots
	// — an unvalidated "../" name would prune outside shotsRoot.
	// Synchronous, so no call blocks behind another desktop's lane.
	function sweepOnce(name: string, op: string): void {
		if (!ctx.namePattern.test(name)) {
			throw ctx.refuse(
				name,
				op,
				`invalid desktop name ${JSON.stringify(name)} — must match ${ctx.namePattern.source}`,
			);
		}
		pruneShots(name);
		const idle = ctx.cfg().idleHours;
		if (idle === 0) return;
		const cutoff = Date.now() - idle * 3_600_000;
		for (const row of store.staleBefore(cutoff, name)) enqueueReap(row.name, cutoff);
	}

	return { pruneShots, reapLocked, sweepOnce };
}
