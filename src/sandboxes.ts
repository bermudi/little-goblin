// Sandboxed execution — the sandboxes table plus the lifecycle owner
// (design/sandbox.md). One rootless-podman container per conversation;
// the row is intent, podman is truth, and every call reconciles the
// two: running → use (network re-applied from the row when drifted),
// stopped → start + re-apply, missing → recreate (prior state gone),
// labelled-but-rowless → adopt from inspect. Lifecycle ops are
// single-flight per conversation so parallel tool calls can't
// double-create; execs themselves run concurrently.
//
// Reaping is a sweep at the start of every sandbox call — rows idle
// longer than idleHours lose their container then their row (the
// caller's own row is exempt). No ticker, no boot hook, no shutdown
// hook: a goblin restart must never kill an experiment mid-flight.
// Network is fail-closed: an off state that can't be confirmed by
// inspect removes the container rather than use it.

import { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "./log.ts";
import { sandboxConfigSchema, type SandboxConfig } from "./config.ts";
import type { ContainerInspect, Podman } from "./podman.ts";
import type { BoundedProc } from "./proc.ts";

// Model/operator-actionable failures (missing image, bad path, a
// fail-closed removal) — the tool maps these to {error} results.
export class SandboxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxError";
	}
}

export interface SandboxRow {
	conversationId: string;
	container: string;
	image: string;
	/** Intended network state — the row is intent, podman is truth. */
	network: boolean;
	createdAt: number;
	lastUsedAt: number;
}

export interface SandboxStore {
	get(conversationId: string): SandboxRow | null;
	put(row: SandboxRow): void;
	setNetwork(conversationId: string, enabled: boolean): void;
	touch(conversationId: string, atMs: number): void;
	delete(conversationId: string): void;
	/** Rows idle since before cutoffMs, excluding one conversation. */
	staleBefore(cutoffMs: number, excludeConversationId: string): SandboxRow[];
	close(): void;
}

const rowSchema = z.object({
	conversation_id: z.string(),
	container: z.string(),
	image: z.string(),
	network: z.number(),
	created_at: z.number(),
	last_used_at: z.number(),
});

function toRow(row: unknown): SandboxRow {
	const r = rowSchema.parse(row);
	return {
		conversationId: r.conversation_id,
		container: r.container,
		image: r.image,
		network: r.network !== 0,
		createdAt: r.created_at,
		lastUsedAt: r.last_used_at,
	};
}

export function openSandboxes(dbPath: string): SandboxStore {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`CREATE TABLE IF NOT EXISTS sandboxes (
		conversation_id TEXT PRIMARY KEY,
		container TEXT NOT NULL,
		image TEXT NOT NULL,
		network INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER NOT NULL
	)`);
	const qGet = db.query("SELECT * FROM sandboxes WHERE conversation_id = ?");
	const qPut = db.query(
		`INSERT INTO sandboxes (conversation_id, container, image, network, created_at, last_used_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(conversation_id) DO UPDATE SET
			container = excluded.container, image = excluded.image,
			network = excluded.network, created_at = excluded.created_at,
			last_used_at = excluded.last_used_at`,
	);
	const qNetwork = db.query("UPDATE sandboxes SET network = ? WHERE conversation_id = ?");
	const qTouch = db.query("UPDATE sandboxes SET last_used_at = ? WHERE conversation_id = ?");
	const qDelete = db.query("DELETE FROM sandboxes WHERE conversation_id = ?");
	const qStale = db.query(
		"SELECT * FROM sandboxes WHERE last_used_at < ? AND conversation_id != ?",
	);
	return {
		get: (conv) => {
			const row = qGet.get(conv);
			return row === null ? null : toRow(row);
		},
		put: (row) =>
			void qPut.run(
				row.conversationId,
				row.container,
				row.image,
				row.network ? 1 : 0,
				row.createdAt,
				row.lastUsedAt,
			),
		setNetwork: (conv, enabled) => void qNetwork.run(enabled ? 1 : 0, conv),
		touch: (conv, atMs) => void qTouch.run(atMs, conv),
		delete: (conv) => void qDelete.run(conv),
		staleBefore: (cutoffMs, exclude) => qStale.all(cutoffMs, exclude).map(toRow),
		close: () => db.close(),
	};
}

const DEFAULT_CONFIG = sandboxConfigSchema.parse({});

export const EXPORT_MAX_BYTES = 100 * 1024 * 1024;
const EXPORT_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_MAX_OUTPUT = 64 * 1024;

// goblin-sbx-<16 hex of sha256(conversation id)> — deterministic, so a
// row-less labelled container finds its owner conversation on inspect.
export function containerNameFor(conversationId: string, prefix: string): string {
	const hex = new Bun.CryptoHasher("sha256").update(conversationId).digest("hex");
	return prefix + hex.slice(0, 16);
}

export interface SandboxesDeps {
	podman: Podman;
	store: SandboxStore;
	/** Live read — absent = the schema defaults (calls only happen while
	 *  the block is configured; the tool gate is the live check). */
	config(): SandboxConfig | undefined;
	/** Test seams — prod leaves both at their defaults. */
	containerPrefix?: string;
	networkName?: string;
}

export interface SandboxExecOutcome {
	result: BoundedProc;
	/** Set when this call created/started/recreated/adopted the sandbox,
	 *  or restarted it after a killed exec. */
	note?: string;
}

export interface Sandboxes {
	exec(
		conversationId: string,
		command: string,
		opts: { timeoutMs: number; maxOutput: number; abortSignal?: AbortSignal },
	): Promise<SandboxExecOutcome>;
	cpIn(conversationId: string, hostPath: string, containerPath: string): Promise<{ note?: string }>;
	/** The file's bytes, or SandboxError (not a regular file, over the
	 *  cap, unreadable). Nothing is written anywhere — the caller owns
	 *  the destination. An aborted read surfaces as AbortError, not
	 *  SandboxError. */
	catFile(
		conversationId: string,
		path: string,
		opts?: { abortSignal?: AbortSignal },
	): Promise<{ data: Uint8Array; note?: string }>;
	setNetwork(conversationId: string, enabled: boolean): Promise<{ note?: string }>;
	reset(conversationId: string, image?: string): Promise<{ note?: string }>;
}

export function makeSandboxes(deps: SandboxesDeps): Sandboxes {
	const podman = deps.podman;
	const store = deps.store;
	const prefix = deps.containerPrefix ?? "goblin-sbx-";
	const networkName = deps.networkName ?? "goblin-sandbox";
	const cfg = (): SandboxConfig => deps.config() ?? DEFAULT_CONFIG;

	const nameFor = (conv: string) => containerNameFor(conv, prefix);

	// The container's name is deterministic, so a replacement is
	// indistinguishable from the original by name alone. Each rm/create
	// bumps this conversation's generation; a killed exec captures it at
	// ensure time, and its queued restart skips when the generation
	// moved — restarting a newer container would reap work it never
	// shared.
	const generations = new Map<string, number>();
	const bumpGeneration = (conv: string): void => {
		generations.set(conv, (generations.get(conv) ?? 0) + 1);
	};
	const generationOf = (conv: string): number => generations.get(conv) ?? 0;

	function requireOurs(name: string, ins: ContainerInspect): void {
		if (ins.labels["goblin.sandbox"] !== "1") {
			throw new SandboxError(
				`container ${name} exists without the goblin.sandbox label — refusing to touch it`,
			);
		}
	}

	// Reconcile actual network state with intent. Off is fail-closed:
	// any step that cannot prove the off state — the inspects framing
	// the disconnect included — removes the container rather than use
	// it in an unknown state. A stranded connected container is worse
	// than a lost one: un-rowed, the next call would adopt its live
	// network as its recorded state.
	async function applyNetwork(name: string, want: boolean, conv: string): Promise<void> {
		const remove = async (): Promise<void> => {
			// Row outlives a failed rm on purpose: it carries the network
			// intent, so a later reconcile re-attempts the cleanup instead
			// of adopting a live container's actual state.
			await podman.rm(name, conv);
			bumpGeneration(conv);
			store.delete(conv);
		};
		const before = await podman.inspect(name, conv).catch(async (err: unknown) => {
			if (want) throw err;
			await remove();
			throw new SandboxError(
				`sandbox ${name} network state could not be inspected (${err instanceof Error ? err.message : String(err)}) — the container was removed`,
			);
		});
		const has = before.networks.includes(networkName);
		if (has === want) return;
		if (want) {
			await podman.networkConnect(networkName, name, conv);
			const after = await podman.inspect(name, conv);
			if (!after.networks.includes(networkName)) {
				throw new SandboxError(`sandbox ${name} would not confirm network connect`);
			}
			return;
		}
		try {
			await podman.networkDisconnect(networkName, name, conv);
		} catch (err) {
			// Same unconfirmed-off state as a lying disconnect.
			await remove();
			throw new SandboxError(
				`sandbox ${name} network disconnect failed (${err instanceof Error ? err.message : String(err)}) — the container was removed`,
			);
		}
		const after = await podman.inspect(name, conv).catch(async (err: unknown) => {
			await remove();
			throw new SandboxError(
				`sandbox ${name} network-off verify failed (${err instanceof Error ? err.message : String(err)}) — the container was removed`,
			);
		});
		if (after.networks.includes(networkName)) {
			await remove();
			throw new SandboxError(
				`sandbox ${name} would not confirm network off — the container was removed`,
			);
		}
	}

	// The image gate belongs to the caller's timing: reset must fail
	// before the rm, while the filesystem still stands. Callers check
	// once, at the point that ordering matters.
	async function requireImage(image: string, conv: string): Promise<void> {
		if (!(await podman.imageExists(image, conv))) {
			throw new SandboxError(
				`image ${image} is not in the local store; ask the operator to run: podman pull ${image}`,
			);
		}
	}

	async function createContainer(
		name: string,
		image: string,
		wantNetwork: boolean,
		conv: string,
	): Promise<void> {
		await podman.networkEnsure(networkName, conv);
		const c = cfg();
		await podman.create(
			{
				name,
				image,
				network: networkName,
				memory: c.memory,
				cpus: c.cpus,
				pids: c.pids,
				labels: { "goblin.sandbox": "1", "goblin.conversation": conv },
			},
			conv,
		);
		// Created ON the network — a --network none container can never
		// be connected later — then brought to the intended state. A
		// bring-to-state failure must not strand the connected container:
		// row-less, the next call's reconcile would adopt it live.
		try {
			await applyNetwork(name, wantNetwork, conv);
		} catch (err) {
			// applyNetwork's own failure paths may already have removed
			// the container — rm only what still exists (an unanswerable
			// inspect tries the rm anyway). The row stays: a recreate's
			// row carries the network intent the next call retries from.
			const ins = await podman.inspect(name, conv).catch(() => null);
			if (ins?.state !== "missing") {
				await podman.rm(name, conv);
				bumpGeneration(conv);
			}
			throw err;
		}
		bumpGeneration(conv);
	}

	// The reconcile, inside the conversation's lane.
	async function ensureLocked(conv: string): Promise<{ container: string; note?: string }> {
		const name = nameFor(conv);
		const now = Date.now();
		const row = store.get(conv);
		const ins = await podman.inspect(name, conv);
		if (ins.state !== "missing") {
			requireOurs(name, ins);
			if (row === null) {
				// A labelled container with no row (row lost): adopt — the
				// inspect tells us its image and actual network state.
				const adopted: SandboxRow = {
					conversationId: conv,
					container: name,
					image: ins.image,
					network: ins.networks.includes(networkName),
					createdAt: now,
					lastUsedAt: now,
				};
				store.put(adopted);
				// The tool contract says network is OFF until enabled — an
				// adopted container that happens to be attached must say so,
				// or the model would run code believing it is isolated.
				const net = adopted.network ? "; its network is ON" : "";
				if (ins.state === "stopped") {
					await podman.start(name, conv);
					await applyNetwork(name, adopted.network, conv);
					log.info("sandbox adopted and started", { conversation: conv, container: name });
					return {
						container: name,
						note: `adopted an existing sandbox container and restarted it${net}`,
					};
				}
				log.info("sandbox adopted", { conversation: conv, container: name });
				return {
					container: name,
					note: `adopted an existing sandbox container for this conversation${net}`,
				};
			}
			if (ins.state === "stopped") {
				// E.g. a host reboot — filesystem intact, network re-applied
				// from the row (the intent), not from whatever inspect saw.
				await podman.start(name, conv);
				await applyNetwork(name, row.network, conv);
				store.touch(conv, now);
				log.info("sandbox restarted", { conversation: conv, container: name });
				return {
					container: name,
					note: "sandbox was stopped — restarted it; files and network state restored",
				};
			}
			// Running: the row's network intent wins over a drifted actual
			// (a crash between connect and row update fails closed).
			await applyNetwork(name, row.network, conv);
			store.touch(conv, now);
			return { container: name };
		}
		if (row !== null) {
			// Missing with a row: recreate from the row — image and
			// intended network — and say the prior filesystem is gone.
			await requireImage(row.image, conv);
			await createContainer(name, row.image, row.network, conv);
			store.touch(conv, now);
			log.info("sandbox recreated", { conversation: conv, container: name });
			return {
				container: name,
				note: "sandbox container was gone — recreated fresh; its previous contents are lost",
			};
		}
		const image = cfg().image;
		await requireImage(image, conv);
		await createContainer(name, image, false, conv);
		store.put({
			conversationId: conv,
			container: name,
			image,
			network: false,
			createdAt: now,
			lastUsedAt: now,
		});
		log.info("sandbox created", { conversation: conv, container: name, image });
		return { container: name, note: "created a new sandbox (network off)" };
	}

	// The killed-exec recovery, inside the lane: podman exec does not
	// propagate the client kill (measured 2026-10-10 — the in-container
	// process outlives its client), so any killed exec — deadline,
	// abort, or the output cap — leaves work running. The restart reaps
	// it; the filesystem survives, and network intent is re-applied
	// from the row. Concurrent execs share the container, so one
	// restart reaps them all — the stamp lets siblings that were killed
	// by it skip queueing a restart of their own.
	const lastRestartedAt = new Map<string, number>();
	async function restartAfterKillLocked(name: string, conv: string): Promise<void> {
		await podman.restart(name, conv);
		const row = store.get(conv);
		await applyNetwork(name, row?.network ?? false, conv);
		lastRestartedAt.set(conv, Date.now());
		log.info("sandbox restarted after killed exec", {
			conversation: conv,
			container: name,
		});
	}

	async function sweep(conv: string): Promise<void> {
		const idle = cfg().idleHours;
		if (idle === 0) return;
		const cutoff = Date.now() - idle * 3_600_000;
		for (const row of store.staleBefore(cutoff, conv)) {
			// The snapshot is stale the moment it is read: a call that
			// landed meanwhile touches its row inside the row's lane, so
			// the reap takes that lane and re-reads before removing —
			// otherwise one conversation's sweep could destroy a
			// sandbox whose owner just came back.
			await lane(row.conversationId, async () => {
				const fresh = store.get(row.conversationId);
				if (fresh === null || fresh.lastUsedAt >= cutoff) return;
				try {
					// The row's owner, not the sweeping conversation — the
					// podman boundary line must name who the rm was for.
					await podman.rm(fresh.container, fresh.conversationId);
					bumpGeneration(row.conversationId);
				} catch (err) {
					// Keep the row — the next call retries the reap.
					log.warn("sandbox reap failed — row kept", err, {
						conversation: row.conversationId,
						container: fresh.container,
					});
					return;
				}
				store.delete(row.conversationId);
				log.info("sandbox reaped", {
					conversation: row.conversationId,
					container: fresh.container,
					idleHours: idle,
				});
			});
		}
	}

	// Sweeps serialize globally so parallel calls on different
	// conversations can't double-remove the same stale row.
	let sweepTail: Promise<void> = Promise.resolve();
	function sweepOnce(conv: string): Promise<void> {
		const run = sweepTail.then(() => sweep(conv));
		sweepTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	// Lifecycle ops are single-flight per conversation; exec joins the
	// lane only for ensure, then runs concurrently outside it.
	const lanes = new Map<string, Promise<void>>();
	function lane<T>(conv: string, fn: () => Promise<T>): Promise<T> {
		const prev = lanes.get(conv) ?? Promise.resolve();
		const run = prev.then(fn, fn);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		tail.finally(() => {
			if (lanes.get(conv) === tail) lanes.delete(conv);
		});
		lanes.set(conv, tail);
		return run;
	}

	// The returning-owner refresh: the row's liveness stamp must land
	// inside this conversation's lane BEFORE joining the global sweep —
	// a sweep that already selected this stale row re-reads it under
	// the same lane, so touching first makes its recheck skip us.
	// Touching only after sweepOnce could land after the rm.
	async function beginOp(conv: string): Promise<void> {
		await lane(conv, async () => {
			store.touch(conv, Date.now());
		});
		await sweepOnce(conv);
	}

	return {
		async exec(conv, command, opts) {
			await beginOp(conv);
			const ready = await lane(conv, async () => {
				// Inside the lane so a foreign sweep's recheck sees the
				// fresh row before it can remove this container.
				store.touch(conv, Date.now());
				const ensured = await ensureLocked(conv);
				return { ...ensured, generation: generationOf(conv) };
			});
			const execStartedAt = Date.now();
			const r = await podman.exec(ready.container, ["/bin/sh", "-c", command], opts, conv);
			let note = ready.note;
			if (r.killed) {
				const outcome = await lane(conv, async () => {
					// A reset/recreate replaced the container while this
					// exec was being torn down — its leftover work died
					// with the old container, and restarting the new one
					// would reap work the exec never shared.
					if (ready.generation !== generationOf(conv)) return "replaced";
					// A restart newer than this exec's start already reaped
					// its leftover work — a killed sibling's restart kills
					// every other in-flight exec, and each must not queue
					// another restart for its own death.
					if ((lastRestartedAt.get(conv) ?? 0) > execStartedAt) return "sibling";
					await restartAfterKillLocked(ready.container, conv);
					return "restarted";
				});
				const killed =
					outcome === "replaced"
						? "the command was stopped before it finished — the sandbox container was replaced meanwhile, so anything still running died with it; its files are gone"
						: "the command was stopped before it finished — the sandbox was restarted to stop anything still running; files were kept";
				note = note === undefined ? killed : `${note}; ${killed}`;
			}
			store.touch(conv, Date.now());
			return { result: r, ...(note !== undefined ? { note } : {}) };
		},

		async cpIn(conv, hostPath, containerPath) {
			await beginOp(conv);
			const ready = await lane(conv, () => {
				store.touch(conv, Date.now());
				return ensureLocked(conv);
			});
			await podman.cp(ready.container, hostPath, containerPath, conv);
			store.touch(conv, Date.now());
			return { ...(ready.note !== undefined ? { note: ready.note } : {}) };
		},

		async catFile(conv, path, opts) {
			opts?.abortSignal?.throwIfAborted();
			await beginOp(conv);
			const ready = await lane(conv, () => {
				store.touch(conv, Date.now());
				return ensureLocked(conv);
			});
			const probe = await podman.exec(
				ready.container,
				["/bin/sh", "-c", 'test -f "$1"', "sb-check", path],
				{
					timeoutMs: PROBE_TIMEOUT_MS,
					maxOutput: PROBE_MAX_OUTPUT,
					...(opts?.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
				},
				conv,
			);
			if (probe.exitCode !== 0) {
				throw new SandboxError(`${path} is not a regular file in the sandbox`);
			}
			const r = await podman.execBytes(
				ready.container,
				["cat", "--", path],
				{
					timeoutMs: EXPORT_TIMEOUT_MS,
					maxOutput: EXPORT_MAX_BYTES,
					...(opts?.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
				},
				conv,
			);
			// A cancelled read is the caller's AbortError, not a read
			// failure — and it must surface before any write decision.
			opts?.abortSignal?.throwIfAborted();
			if (r.truncated || r.stdout.byteLength > EXPORT_MAX_BYTES) {
				throw new SandboxError(
					`export exceeds the ${EXPORT_MAX_BYTES / (1024 * 1024)} MiB cap — nothing was exported`,
				);
			}
			if (r.timedOut || r.exitCode !== 0) {
				throw new SandboxError(
					`could not read ${path} from the sandbox (exit ${r.exitCode ?? "timeout"})`,
				);
			}
			store.touch(conv, Date.now());
			return { data: r.stdout, ...(ready.note !== undefined ? { note: ready.note } : {}) };
		},

		async setNetwork(conv, enabled) {
			await beginOp(conv);
			const out = await lane(conv, async () => {
				store.touch(conv, Date.now());
				const ready = await ensureLocked(conv);
				await applyNetwork(ready.container, enabled, conv);
				store.setNetwork(conv, enabled);
				store.touch(conv, Date.now());
				log.info("sandbox network", {
					conversation: conv,
					container: ready.container,
					enabled,
				});
				return ready;
			});
			return { ...(out.note !== undefined ? { note: out.note } : {}) };
		},

		async reset(conv, image) {
			await beginOp(conv);
			return await lane(conv, async () => {
				store.touch(conv, Date.now());
				const name = nameFor(conv);
				const target = image ?? cfg().image;
				// The image gate runs before the rm: a bad ref must fail
				// with the old container still standing, not after its
				// filesystem is already gone.
				await requireImage(target, conv);
				const ins = await podman.inspect(name, conv);
				if (ins.state !== "missing") {
					requireOurs(name, ins);
					await podman.rm(name, conv);
					bumpGeneration(conv);
				}
				await createContainer(name, target, false, conv);
				const now = Date.now();
				store.put({
					conversationId: conv,
					container: name,
					image: target,
					network: false,
					createdAt: now,
					lastUsedAt: now,
				});
				log.info("sandbox reset", { conversation: conv, container: name, image: target });
				return {
					note: "sandbox reset — a fresh container replaced the old one; its previous contents are gone",
				};
			});
		},
	};
}
