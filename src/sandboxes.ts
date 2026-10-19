// One rootless-podman container per conversation; the row is intent,
// podman is truth, every call reconciles.
// Reaping is a sweep at the start of every sandbox call — no ticker,
// no boot/shutdown hook: a goblin restart must never kill an
// experiment mid-flight. Network is fail-closed: an off state that
// can't be confirmed by inspect removes the container rather than
// use it.

import { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "./log.ts";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite.ts";
import { sandboxConfigSchema, type SandboxConfig } from "./config.ts";
import type { ContainerInspect, Podman } from "./podman.ts";
import type { BoundedProc, BoundedProcBytes } from "./proc.ts";
import { makeContainerLifecycle } from "./sandbox-lifecycle.ts";

// Actionable failures (missing image, bad path, a fail-closed
// removal) — the tool maps these to {error} results.
export class SandboxError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
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
	/** Every tracked row — the disable check's "what's still standing". */
	list(): SandboxRow[];
	put(row: SandboxRow): void;
	setNetwork(conversationId: string, enabled: boolean): void;
	touch(conversationId: string, atMs: number): void;
	delete(conversationId: string): void;
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
	db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
	db.exec(`CREATE TABLE IF NOT EXISTS sandboxes (
		conversation_id TEXT PRIMARY KEY,
		container TEXT NOT NULL,
		image TEXT NOT NULL,
		network INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER NOT NULL
	)`);
	const qGet = db.query("SELECT * FROM sandboxes WHERE conversation_id = ?");
	const qAll = db.query("SELECT * FROM sandboxes");
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
		list: () => qAll.all().map(toRow),
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

// The idle sweep only rides sandbox calls — no boot sweep (a restart
// must never kill experiments). So a disable surfaces the stranded
// rows and the manual rm line; the operator decides what the
// containers are.
export function warnIfStranded(store: SandboxStore): void {
	const rows = store.list();
	if (rows.length === 0) return;
	log.warn(
		`sandbox disabled with ${rows.length} tracked container(s) still standing — ` +
			`no sweep will fire while the block is absent. Remove them: ` +
			`podman rm -f ${rows.map((r) => r.container).join(" ")}`,
		{ containers: rows.map((r) => r.container) },
	);
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
	/** Live read — absent = schema defaults. */
	config(): SandboxConfig | undefined;
	/** Test seams — prod leaves both at their defaults. */
	containerPrefix?: string;
	networkName?: string;
	/** A live subagent run lease (queued/running/needs_input) or null —
	 *  read inside lifecycle ops: reset refuses while held, the reaper
	 *  skips. */
	runLease?(conversationId: string): { id: number; status: string } | null;
	/** Destructive lifecycle events a worker run must learn about —
	 *  recreate (prior state gone) and restart-after-killed-exec.
	 *  Synchronous; the composition persists it onto the run row. */
	onLifecycle?(conversationId: string, note: string): void;
}

export interface SandboxExecOutcome {
	result: BoundedProc;
	/** Set when this call created/started/recreated/adopted the sandbox,
	 *  or restarted it after a killed exec. */
	note?: string;
}

/** Optional last param on the lifecycle ops: the caller's abort signal.
 *  Checked before the call, after the sweep and lane waits, after each
 *  preflight read, and immediately before a mutation is dispatched —
 *  a cancelled call never starts a rm/create/connect/cp afterwards.
 *  A mutation already dispatched still reconciles to the row's intent:
 *  an abort never leaves a half-reset or unverified network state. */
export interface SandboxOpOpts {
	abortSignal?: AbortSignal;
}

export interface Sandboxes {
	exec(
		conversationId: string,
		command: string,
		opts: { timeoutMs: number; maxOutput: number; abortSignal?: AbortSignal },
	): Promise<SandboxExecOutcome>;
	/** exec without the /bin/sh -c wrapper — same
	 *  ensure/reconcile/restart path. */
	execArgv(
		conversationId: string,
		argv: string[],
		opts: { timeoutMs: number; maxOutput: number; abortSignal?: AbortSignal },
	): Promise<SandboxExecOutcome>;
	execBytesArgv(
		conversationId: string,
		argv: string[],
		opts: { timeoutMs: number; maxOutput: number; abortSignal?: AbortSignal },
	): Promise<{ result: BoundedProcBytes; note?: string }>;
	cpIn(
		conversationId: string,
		hostPath: string,
		containerPath: string,
		opts?: SandboxOpOpts,
	): Promise<{ note?: string }>;
	/** The file's bytes, or SandboxError (not a regular file, over the
	 *  cap, unreadable). Nothing is written anywhere — the caller owns
	 *  the destination. */
	catFile(
		conversationId: string,
		path: string,
		opts?: SandboxOpOpts,
	): Promise<{ data: Uint8Array; note?: string }>;
	setNetwork(
		conversationId: string,
		enabled: boolean,
		opts?: SandboxOpOpts,
	): Promise<{ note?: string }>;
	reset(conversationId: string, image?: string, opts?: SandboxOpOpts): Promise<{ note?: string }>;
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

	const lifecycle = makeContainerLifecycle({
		podman,
		networkName,
		cfg,
		bumpGeneration,
	});
	const { requireOurs, applyNetwork, prepareContainer, requireImage, createContainer } = lifecycle;

	async function ensureLocked(
		conv: string,
		signal?: AbortSignal,
	): Promise<{ container: string; note?: string }> {
		signal?.throwIfAborted();
		const name = nameFor(conv);
		const now = Date.now();
		const row = store.get(conv);
		const ins = await podman.inspect(name, conv);
		signal?.throwIfAborted();
		if (ins.state !== "missing") {
			requireOurs(name, ins);
			if (row === null) {
				// Labelled but rowless: adopt — inspect tells us its
				// image and actual network.
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
				// adopted container that happens to be attached must say
				// so, or the model runs code believing it is isolated.
				const net = adopted.network ? "; its network is ON" : "";
				if (ins.state === "stopped") {
					signal?.throwIfAborted();
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
				// Filesystem intact; network re-applied from the row's
				// intent, not whatever inspect saw — background
				// processes are gone.
				signal?.throwIfAborted();
				await podman.start(name, conv);
				// Startup already dispatched: finish the safety reconciliation even on cancellation.
				await applyNetwork(name, row.network, conv);
				store.touch(conv, now);
				const note =
					"sandbox was stopped (e.g. host reboot) — restarted it; files and network state restored, but any background processes have died";
				deps.onLifecycle?.(conv, note);
				log.info("sandbox restarted", { conversation: conv, container: name });
				return {
					container: name,
					note,
				};
			}
			// Running: the row's network intent wins over a drifted actual
			// (a crash between connect and row update fails closed).
			await applyNetwork(name, row.network, conv, signal);
			store.touch(conv, now);
			return { container: name };
		}
		if (row !== null) {
			// Recreate from the row's image and intended network — the
			// prior filesystem is gone.
			await createContainer(name, row.image, row.network, conv, undefined, signal);
			store.touch(conv, now);
			const note = "sandbox container was gone — recreated fresh; its previous contents are lost";
			deps.onLifecycle?.(conv, note);
			log.info("sandbox recreated", { conversation: conv, container: name });
			return {
				container: name,
				note,
			};
		}
		const image = cfg().image;
		await createContainer(name, image, false, conv, undefined, signal);
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

	// podman exec does not propagate the client kill — a killed exec
	// leaves work running; the restart reaps it (filesystem survives,
	// network re-applied from the row).
	const restartEpochs = new Map<string, number>();
	const restartEpochOf = (conv: string): number => restartEpochs.get(conv) ?? 0;
	async function restartAfterKillLocked(name: string, conv: string, note: string): Promise<void> {
		await podman.restart(name, conv);
		restartEpochs.set(conv, restartEpochOf(conv) + 1);
		const row = store.get(conv);
		await applyNetwork(name, row?.network ?? false, conv);
		deps.onLifecycle?.(conv, note);
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
			// The idle/lease verdict is re-read inside the target's lane
			// immediately before removal — a touch or fresh lease
			// landing between listing and rm must win the race.
			await lane(row.conversationId, async () => {
				const fresh = store.get(row.conversationId);
				if (fresh === null || fresh.lastUsedAt >= cutoff) return;
				if (deps.runLease?.(row.conversationId) != null) return;
				try {
					// The rm runs under the row's owner — the boundary
					// line must name who it was for.
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

	// Refresh under the owner lane BEFORE joining the global sweep. A
	// foreign sweep may have selected this row already; its lane recheck
	// must see the returning owner's touch, not remove it while we wait.
	async function beginOp(conv: string, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		await lane(conv, async () => {
			signal?.throwIfAborted();
			store.touch(conv, Date.now());
		});
		signal?.throwIfAborted();
		await sweepOnce(conv);
		signal?.throwIfAborted();
	}

	// A run lease announces itself on every non-destructive result.
	function leaseNote(conv: string): string | undefined {
		const lease = deps.runLease?.(conv);
		return lease === null || lease === undefined
			? undefined
			: `run #${lease.id} holds this sandbox`;
	}
	function mergeNote(a: string | undefined, b: string | undefined): string | undefined {
		if (a === undefined) return b;
		if (b === undefined) return a;
		return `${a}; ${b}`;
	}

	// ensure inside the lane, dispatch outside it; restart when the
	// client was killed — deadline, abort, or cap (the note names
	// which).
	async function execCommon<
		T extends { timedOut: boolean; killed: boolean; outputCapped?: boolean },
	>(
		conv: string,
		opts: { timeoutMs: number; maxOutput: number; abortSignal?: AbortSignal },
		dispatch: (container: string) => Promise<T>,
	): Promise<{ result: T; note?: string }> {
		await beginOp(conv, opts.abortSignal);
		const ready = await lane(conv, async () => {
			opts.abortSignal?.throwIfAborted();
			store.touch(conv, Date.now());
			const ensured = await ensureLocked(conv, opts.abortSignal);
			return { ...ensured, generation: generationOf(conv) };
		});
		opts.abortSignal?.throwIfAborted();
		const epoch = restartEpochOf(conv);
		const r = await dispatch(ready.container);
		let note = ready.note;
		// The process result owns kill provenance: a late abort after a
		// normal exit must not restart a container running sibling work.
		if (r.killed) {
			const why =
				r.outputCapped === true
					? "ran past its output cap"
					: r.timedOut
						? "outlived its deadline"
						: opts.abortSignal?.aborted === true
							? "was aborted"
							: "was stopped before it finished";
			const killed = `the command ${why} — the sandbox was restarted to stop anything still running; files were kept`;
			const outcome = await lane(conv, async () => {
				if (ready.generation !== generationOf(conv)) return "replaced";
				if (epoch !== restartEpochOf(conv)) return "sibling";
				await restartAfterKillLocked(ready.container, conv, killed);
				return "restarted";
			});
			const recovery =
				outcome === "replaced"
					? `the command ${why} — the sandbox container was replaced meanwhile, so anything still running died with it; its files are gone`
					: outcome === "sibling"
						? `the command ${why} — a sibling command already restarted the sandbox to stop anything still running; files were kept`
						: killed;
			log.info("sandbox exec recovery", {
				conversation: conv,
				container: ready.container,
				outcome,
				reason: why,
			});
			note = mergeNote(note, recovery);
		}
		note = mergeNote(note, leaseNote(conv));
		store.touch(conv, Date.now());
		return { result: r, ...(note !== undefined ? { note } : {}) };
	}

	return {
		exec: (conv, command, opts) =>
			execCommon(conv, opts, (container) =>
				podman.exec(container, ["/bin/sh", "-c", command], opts, conv),
			),

		execArgv: (conv, argv, opts) =>
			execCommon(conv, opts, (container) => podman.exec(container, argv, opts, conv)),

		execBytesArgv: (conv, argv, opts) =>
			execCommon(conv, opts, (container) => podman.execBytes(container, argv, opts, conv)),

		async cpIn(conv, hostPath, containerPath, opts) {
			opts?.abortSignal?.throwIfAborted();
			await beginOp(conv, opts?.abortSignal);
			opts?.abortSignal?.throwIfAborted();
			const ready = await lane(conv, () => {
				store.touch(conv, Date.now());
				return ensureLocked(conv, opts?.abortSignal);
			});
			opts?.abortSignal?.throwIfAborted();
			await podman.cp(ready.container, hostPath, containerPath, conv);
			store.touch(conv, Date.now());
			const note = mergeNote(ready.note, leaseNote(conv));
			return { ...(note !== undefined ? { note } : {}) };
		},

		async catFile(conv, path, opts) {
			opts?.abortSignal?.throwIfAborted();
			await beginOp(conv, opts?.abortSignal);
			opts?.abortSignal?.throwIfAborted();
			const ready = await lane(conv, () => {
				store.touch(conv, Date.now());
				return ensureLocked(conv, opts?.abortSignal);
			});
			opts?.abortSignal?.throwIfAborted();
			// -f follows a leaf symlink but the export contract is
			// regular files only — reject links, dirs and devices alike.
			const probe = await podman.exec(
				ready.container,
				["/bin/sh", "-c", 'test -f "$1" && ! test -L "$1"', "sb-check", path],
				{
					timeoutMs: PROBE_TIMEOUT_MS,
					maxOutput: PROBE_MAX_OUTPUT,
					...(opts?.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
				},
				conv,
			);
			opts?.abortSignal?.throwIfAborted();
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
			const note = mergeNote(ready.note, leaseNote(conv));
			return { data: r.stdout, ...(note !== undefined ? { note } : {}) };
		},

		async setNetwork(conv, enabled, opts) {
			opts?.abortSignal?.throwIfAborted();
			await beginOp(conv, opts?.abortSignal);
			opts?.abortSignal?.throwIfAborted();
			const out = await lane(conv, async () => {
				store.touch(conv, Date.now());
				const ready = await ensureLocked(conv, opts?.abortSignal);
				opts?.abortSignal?.throwIfAborted();
				await applyNetwork(ready.container, enabled, conv, opts?.abortSignal);
				// The toggle already dispatched and verified — the row
				// update is its reconciliation, never abort between them.
				store.setNetwork(conv, enabled);
				store.touch(conv, Date.now());
				log.info("sandbox network", {
					conversation: conv,
					container: ready.container,
					enabled,
				});
				return ready;
			});
			const note = mergeNote(out.note, leaseNote(conv));
			return { ...(note !== undefined ? { note } : {}) };
		},

		async reset(conv, image, opts) {
			opts?.abortSignal?.throwIfAborted();
			await beginOp(conv, opts?.abortSignal);
			opts?.abortSignal?.throwIfAborted();
			return await lane(conv, async () => {
				store.touch(conv, Date.now());
				opts?.abortSignal?.throwIfAborted();
				// Inside the lane so a racing act can't resurrect a stale
				// row — a live run would lose its state under reset.
				const lease = deps.runLease?.(conv);
				if (lease != null) {
					throw new SandboxError(
						`sandbox reset refused — run #${lease.id} (${lease.status}) holds this sandbox; stop it first`,
					);
				}
				const name = nameFor(conv);
				const target = image ?? cfg().image;
				// The image gate runs before the rm: a bad ref must fail
				// with the old container still standing, not after its
				// filesystem is already gone.
				await requireImage(target, conv);
				const ins = await podman.inspect(name, conv);
				opts?.abortSignal?.throwIfAborted();
				if (ins.state !== "missing") requireOurs(name, ins);
				// Preflight the replacement BEFORE removing the incumbent —
				// an unavailable image or network must never destroy the
				// existing sandbox. A cancelled preflight throws here and the
				// incumbent survives.
				const prepared = await prepareContainer(target, conv, opts?.abortSignal);
				opts?.abortSignal?.throwIfAborted();
				const currentLease = deps.runLease?.(conv);
				if (currentLease != null) {
					throw new SandboxError(
						`sandbox reset refused — run #${currentLease.id} (${currentLease.status}) holds this sandbox; stop it first`,
					);
				}
				if (ins.state !== "missing") {
					await podman.rm(name, conv);
					bumpGeneration(conv);
				}
				// rm already landed — the recreate runs without the signal:
				// a cancelled call must still leave a coherent container and
				// row rather than a half-reset.
				await createContainer(name, target, false, conv, prepared);
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
