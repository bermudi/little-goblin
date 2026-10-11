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
	 *  the destination. */
	catFile(conversationId: string, path: string): Promise<{ data: Uint8Array; note?: string }>;
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

	function requireOurs(name: string, ins: ContainerInspect): void {
		if (ins.labels["goblin.sandbox"] !== "1") {
			throw new SandboxError(
				`container ${name} exists without the goblin.sandbox label — refusing to touch it`,
			);
		}
	}

	// Reconcile actual network state with intent. Off is fail-closed:
	// if the disconnect fails or inspect can't confirm it, the
	// container is removed rather than used in an unknown state.
	async function applyNetwork(name: string, want: boolean, conv: string): Promise<void> {
		const before = await podman.inspect(name, conv);
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
			await podman.rm(name, conv);
			store.delete(conv);
			throw new SandboxError(
				`sandbox ${name} network disconnect failed (${err instanceof Error ? err.message : String(err)}) — the container was removed`,
			);
		}
		const after = await podman.inspect(name, conv);
		if (after.networks.includes(networkName)) {
			await podman.rm(name, conv);
			store.delete(conv);
			throw new SandboxError(
				`sandbox ${name} would not confirm network off — the container was removed`,
			);
		}
	}

	async function createContainer(
		name: string,
		image: string,
		wantNetwork: boolean,
		conv: string,
	): Promise<void> {
		if (!(await podman.imageExists(image, conv))) {
			throw new SandboxError(
				`image ${image} is not in the local store; ask the operator to run: podman pull ${image}`,
			);
		}
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
		// be connected later — then brought to the intended state.
		await applyNetwork(name, wantNetwork, conv);
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
				if (ins.state === "stopped") {
					await podman.start(name, conv);
					await applyNetwork(name, adopted.network, conv);
					log.info("sandbox adopted and started", { conversation: conv, container: name });
					return {
						container: name,
						note: "adopted an existing sandbox container and restarted it",
					};
				}
				log.info("sandbox adopted", { conversation: conv, container: name });
				return {
					container: name,
					note: "adopted an existing sandbox container for this conversation",
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
			await createContainer(name, row.image, row.network, conv);
			store.touch(conv, now);
			log.info("sandbox recreated", { conversation: conv, container: name });
			return {
				container: name,
				note: "sandbox container was gone — recreated fresh; its previous contents are lost",
			};
		}
		const image = cfg().image;
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
	// process outlives its client), so a timed-out/aborted exec leaves
	// work running. The restart reaps it; the filesystem survives, and
	// network intent is re-applied from the row.
	async function restartAfterKillLocked(name: string, conv: string): Promise<void> {
		await podman.restart(name, conv);
		const row = store.get(conv);
		await applyNetwork(name, row?.network ?? false, conv);
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
			try {
				await podman.rm(row.container, conv);
			} catch (err) {
				// Keep the row — the next call retries the reap.
				log.warn("sandbox reap failed — row kept", err, {
					conversation: row.conversationId,
					container: row.container,
				});
				continue;
			}
			store.delete(row.conversationId);
			log.info("sandbox reaped", {
				conversation: row.conversationId,
				container: row.container,
				idleHours: idle,
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

	return {
		async exec(conv, command, opts) {
			await sweepOnce(conv);
			store.touch(conv, Date.now());
			const ready = await lane(conv, () => ensureLocked(conv));
			const r = await podman.exec(ready.container, ["/bin/sh", "-c", command], opts, conv);
			let note = ready.note;
			if (r.timedOut || opts.abortSignal?.aborted === true) {
				await lane(conv, () => restartAfterKillLocked(ready.container, conv));
				const killed =
					"the command outlived its deadline — the sandbox was restarted to stop anything still running; files were kept";
				note = note === undefined ? killed : `${note}; ${killed}`;
			}
			store.touch(conv, Date.now());
			return { result: r, ...(note !== undefined ? { note } : {}) };
		},

		async cpIn(conv, hostPath, containerPath) {
			await sweepOnce(conv);
			store.touch(conv, Date.now());
			const ready = await lane(conv, () => ensureLocked(conv));
			await podman.cp(ready.container, hostPath, containerPath, conv);
			store.touch(conv, Date.now());
			return { ...(ready.note !== undefined ? { note: ready.note } : {}) };
		},

		async catFile(conv, path) {
			await sweepOnce(conv);
			store.touch(conv, Date.now());
			const ready = await lane(conv, () => ensureLocked(conv));
			const probe = await podman.exec(
				ready.container,
				["/bin/sh", "-c", 'test -f "$1"', "sb-check", path],
				{ timeoutMs: PROBE_TIMEOUT_MS, maxOutput: PROBE_MAX_OUTPUT },
				conv,
			);
			if (probe.exitCode !== 0) {
				throw new SandboxError(`${path} is not a regular file in the sandbox`);
			}
			const r = await podman.execBytes(
				ready.container,
				["cat", "--", path],
				{ timeoutMs: EXPORT_TIMEOUT_MS, maxOutput: EXPORT_MAX_BYTES },
				conv,
			);
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
			await sweepOnce(conv);
			store.touch(conv, Date.now());
			const out = await lane(conv, async () => {
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
			await sweepOnce(conv);
			store.touch(conv, Date.now());
			return await lane(conv, async () => {
				const name = nameFor(conv);
				const target = image ?? cfg().image;
				const ins = await podman.inspect(name, conv);
				if (ins.state !== "missing") {
					requireOurs(name, ins);
					await podman.rm(name, conv);
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
