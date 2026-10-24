import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { z } from "zod";
import {
	paths,
	ensureDir,
	desktopsConfigSchema,
	imageRefSchema,
	type DesktopsConfig,
} from "./config.ts";
import { durableWriteBytes } from "./durable.ts";
import { log } from "./log.ts";
import type { ContainerInspect, Podman } from "./podman.ts";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite.ts";

// Mapped to {error} tool results — model/operator-actionable failures.
export class DesktopError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DesktopError";
	}
}

export class DesktopLeaseError extends DesktopError {}

export type LeaseHolder =
	| { kind: "run"; id: string }
	| { kind: "conversation"; id: string }
	| { kind: "operator" };

// cua-driver 0.34.1's input tools minus the ones bypassing goblin's
// gates: launch_app/kill_app route around the launch whitelist and
// refusal logging, browser_* drives an unwired CDP channel, raw
// mouse_*/move_cursor/parallel_mouse_drag are covered by click/drag.
export type CuaTool =
	| "click"
	| "double_click"
	| "right_click"
	| "press_key"
	| "hotkey"
	| "type_text"
	| "scroll"
	| "drag"
	| "set_value"
	| "bring_to_front"
	| "invoke_menu"
	| "set_window_frame";

// Must stay literal against the CuaTool union — growing one without
// the other is a type error. act is the enforcement point: a boundary
// cast to CuaTool proves nothing at runtime.
export const CUA_TOOLS: ReadonlySet<string> = new Set<CuaTool>([
	"click",
	"double_click",
	"right_click",
	"press_key",
	"hotkey",
	"type_text",
	"scroll",
	"drag",
	"set_value",
	"bring_to_front",
	"invoke_menu",
	"set_window_frame",
]);

export type DesktopAction =
	| { kind: "launch"; app: "chromium"; url?: string }
	| { kind: "cua"; tool: CuaTool; args: Record<string, unknown> };

const listWindowsSchema = z.object({
	windows: z
		.array(z.object({ pid: z.number(), app_name: z.string(), z_index: z.number() }))
		.optional(),
});

export interface DesktopRow {
	name: string;
	container: string;
	image: string;
	/** The row is intent, podman is truth. */
	network: boolean;
	reserved: boolean;
	leaseKind: "run" | "conversation" | "operator" | null;
	leaseId: string | null;
	leaseExpiresAt: number | null;
	/** The newest minted observation; an action consumes it. */
	lastObsId: string | null;
	lastObsUsed: boolean;
	/** sha256 of the observation frame — PNG bytes for screenshots,
	 *  the cua screenshot (or state JSON) for inspect. */
	lastObsHash: string | null;
	/** The identical-action-on-unchanged-screen refusal state. */
	lastActSig: string | null;
	lastActFrameHash: string | null;
	/** podman State.StartedAt the recorded observation was minted on;
	 *  null = unknown (the next reconcile records it). Optional because
	 *  unknown is a real state for row literals built outside this
	 *  module. */
	bootGen?: string | null;
	shotSeq: number;
	createdAt: number;
	lastUsedAt: number;
}

export interface DesktopStore {
	get(name: string): DesktopRow | null;
	list(): DesktopRow[];
	put(row: DesktopRow): void;
	delete(name: string): void;
	staleBefore(cutoffMs: number, excludeName: string): DesktopRow[];
	close(): void;
}

const rowSchema = z.object({
	name: z.string(),
	container: z.string(),
	image: z.string(),
	network: z.number(),
	reserved: z.number(),
	lease_kind: z.enum(["run", "conversation", "operator"]).nullable(),
	lease_id: z.string().nullable(),
	lease_expires_at: z.number().nullable(),
	last_obs_id: z.string().nullable(),
	last_obs_used: z.number(),
	last_obs_hash: z.string().nullable(),
	last_act_sig: z.string().nullable(),
	last_act_frame_hash: z.string().nullable(),
	boot_gen: z.string().nullable(),
	shot_seq: z.number(),
	created_at: z.number(),
	last_used_at: z.number(),
});

function toRow(row: unknown): DesktopRow {
	const r = rowSchema.parse(row);
	return {
		name: r.name,
		container: r.container,
		image: r.image,
		network: r.network !== 0,
		reserved: r.reserved !== 0,
		leaseKind: r.lease_kind,
		leaseId: r.lease_id,
		leaseExpiresAt: r.lease_expires_at,
		lastObsId: r.last_obs_id,
		lastObsUsed: r.last_obs_used !== 0,
		lastObsHash: r.last_obs_hash,
		lastActSig: r.last_act_sig,
		lastActFrameHash: r.last_act_frame_hash,
		bootGen: r.boot_gen,
		shotSeq: r.shot_seq,
		createdAt: r.created_at,
		lastUsedAt: r.last_used_at,
	};
}

export function openDesktops(dbPath: string): DesktopStore {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
	db.exec(`CREATE TABLE IF NOT EXISTS desktops (
		name TEXT PRIMARY KEY,
		container TEXT NOT NULL,
		image TEXT NOT NULL,
		network INTEGER NOT NULL,
		reserved INTEGER NOT NULL DEFAULT 0,
		lease_kind TEXT,
		lease_id TEXT,
		lease_expires_at INTEGER,
		last_obs_id TEXT,
		last_obs_used INTEGER NOT NULL DEFAULT 0,
		last_obs_hash TEXT,
		last_act_sig TEXT,
		last_act_frame_hash TEXT,
		boot_gen TEXT,
		shot_seq INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER NOT NULL
	)`);
	// NULL reads as unknown generation — the first reconcile
	// invalidates any recorded observation (fail-closed).
	const cols = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(desktops)")
			.all()
			.map((c) => c.name),
	);
	if (!cols.has("boot_gen")) db.run("ALTER TABLE desktops ADD COLUMN boot_gen TEXT");
	const qGet = db.query("SELECT * FROM desktops WHERE name = ?");
	const qList = db.query("SELECT * FROM desktops ORDER BY name");
	const qPut = db.query(
		`INSERT INTO desktops (name, container, image, network, reserved,
			lease_kind, lease_id, lease_expires_at,
			last_obs_id, last_obs_used, last_obs_hash,
			last_act_sig, last_act_frame_hash, boot_gen, shot_seq,
			created_at, last_used_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(name) DO UPDATE SET
			container = excluded.container, image = excluded.image,
			network = excluded.network, reserved = excluded.reserved,
			lease_kind = excluded.lease_kind, lease_id = excluded.lease_id,
			lease_expires_at = excluded.lease_expires_at,
			last_obs_id = excluded.last_obs_id,
			last_obs_used = excluded.last_obs_used,
			last_obs_hash = excluded.last_obs_hash,
			last_act_sig = excluded.last_act_sig,
			last_act_frame_hash = excluded.last_act_frame_hash,
			boot_gen = excluded.boot_gen,
			shot_seq = excluded.shot_seq,
			created_at = excluded.created_at,
			last_used_at = excluded.last_used_at`,
	);
	const qDelete = db.query("DELETE FROM desktops WHERE name = ?");
	const qStale = db.query("SELECT * FROM desktops WHERE last_used_at < ? AND name != ?");
	return {
		get: (name) => {
			const row = qGet.get(name);
			return row === null ? null : toRow(row);
		},
		list: () => qList.all().map(toRow),
		put: (row) =>
			void qPut.run(
				row.name,
				row.container,
				row.image,
				row.network ? 1 : 0,
				row.reserved ? 1 : 0,
				row.leaseKind,
				row.leaseId,
				row.leaseExpiresAt,
				row.lastObsId,
				row.lastObsUsed ? 1 : 0,
				row.lastObsHash,
				row.lastActSig,
				row.lastActFrameHash,
				row.bootGen ?? null,
				row.shotSeq,
				row.createdAt,
				row.lastUsedAt,
			),
		delete: (name) => void qDelete.run(name),
		staleBefore: (cutoffMs, exclude) => qStale.all(cutoffMs, exclude).map(toRow),
		close: () => db.close(),
	};
}

const DEFAULT_CONFIG = desktopsConfigSchema.parse({});

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const LEASE_TTL_MS = 10 * 60_000;
const DESKTOP_USER = "desk";
// Root-owned 0755 stage dir — desk reads/traverses but cannot write,
// rename, or plant links inside.
const IMPORT_STAGE_DIR = "/run/goblin-import";
const SESSION_SOCKET = "/run/desk/cua.sock";
// Must mirror the env goblin-launch pins in the image — nothing here
// may derive from container-writable state.
const SESSION_ENV = {
	HOME: "/home/desk",
	DISPLAY: ":99",
	DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/desk/bus",
	XDG_RUNTIME_DIR: "/home/desk/.runtime",
} as const;
const EXEC_OPTS = { timeoutMs: 60_000, maxOutput: 4 * 1024 * 1024 } as const;
const EXPORT_MAX_BYTES = 100 * 1024 * 1024;
const EXPORT_TIMEOUT_MS = 120_000;

// Chromium refuses background-injected input when its renderer isn't
// the focused surface. AT-SPI tools (invoke_menu, set_window_frame,
// bring_to_front) take no delivery_mode; set_value is AT-SPI
// SetValue, not injected input.
const FOREGROUND_TOOLS: ReadonlySet<string> = new Set([
	"click",
	"double_click",
	"right_click",
	"press_key",
	"hotkey",
	"type_text",
	"scroll",
	"drag",
]);

export function containerNameForDesktop(name: string): string {
	return `goblin-desk-${name}`;
}

function holderId(holder: LeaseHolder): string | null {
	return holder.kind === "operator" ? null : holder.id;
}

function holderLabel(holder: LeaseHolder): string {
	return holder.kind === "operator" ? "operator" : `${holder.kind} ${holder.id}`;
}

function rowHolderLabel(row: DesktopRow): string {
	return row.leaseKind === "operator" ? "operator" : `${row.leaseKind} ${row.leaseId ?? ""}`;
}

function leaseLive(row: DesktopRow, now: number): boolean {
	return row.leaseKind !== null && row.leaseExpiresAt !== null && row.leaseExpiresAt > now;
}

function leaseHeldBy(row: DesktopRow, holder: LeaseHolder, now: number): boolean {
	return leaseLive(row, now) && row.leaseKind === holder.kind && row.leaseId === holderId(holder);
}

// Every refusal logs with its reason — the same message the model
// gets back as the tool result.
function refuse(
	desktop: string,
	op: string,
	reason: string,
	holder?: LeaseHolder,
	cause?: unknown,
): DesktopError {
	log.warn("desktop refused", {
		desktop,
		op,
		reason,
		...(holder === undefined ? {} : { holder: holderLabel(holder) }),
	});
	return new DesktopError(reason, cause === undefined ? undefined : { cause });
}

// Model-controlled strings land on Chromium's argv — a bare `--flag`
// becomes a browser switch. Real URLs (no whitespace/control chars)
// or exactly about:blank.
const LAUNCH_URL_RE = /^(?:https?|file):\/\/[^\s\x00-\x1f\x7f]+$/;
function launchUrlOk(url: string): boolean {
	return url === "about:blank" || LAUNCH_URL_RE.test(url);
}

// Key-order-canonical — the identical-action check ignores caller
// key order.
function stableJson(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
	if (v !== null && typeof v === "object") {
		const o = v as Record<string, unknown>;
		return `{${Object.keys(o)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(v);
}

function sha256Hex(data: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

export interface DesktopsDeps {
	podman: Podman;
	store: DesktopStore;
	/** Read live; absent = the schema defaults. */
	config(): DesktopsConfig | undefined;
	shotsRoot?: string;
	networkName?: string;
}

interface EnsureResult {
	row: DesktopRow;
	container: string;
	note?: string;
}

/** Once a mutation dispatches it finishes reconciling — cancellation
 *  never leaves an unverified network or restart behind. */
export interface DesktopOpOpts {
	abortSignal?: AbortSignal;
}

export interface Desktops {
	allocate(name: string, opts?: { image?: string }): Promise<{ row: DesktopRow; note?: string }>;
	list(): DesktopRow[];
	get(name: string): DesktopRow | null;
	/** The reconcile's lifecycle note rides the return, never the row. */
	claim(name: string, holder: LeaseHolder): Promise<DesktopRow & { note?: string }>;
	release(name: string, holder: LeaseHolder): Promise<void>;
	handoff(name: string, from: LeaseHolder, to: LeaseHolder): Promise<void>;
	reserve(name: string, reserved: boolean): Promise<void>;
	setNetwork(name: string, enabled: boolean, opts?: DesktopOpOpts): Promise<void>;
	destroy(name: string, by: LeaseHolder, opts?: DesktopOpOpts): Promise<void>;
	screenshot(name: string): Promise<{ id: string; path: string; bytes: Uint8Array; note?: string }>;
	inspect(
		name: string,
		opts?: { pid?: number; windowId?: number },
	): Promise<{ id: string; state: unknown; note?: string }>;
	act(
		name: string,
		holder: LeaseHolder,
		obsId: string,
		action: DesktopAction,
	): Promise<{ result: unknown; note?: string }>;
	/** The caller owns the source's provenance; no lease needed. */
	cpIn(
		name: string,
		hostPath: string,
		containerPath: string,
		opts?: DesktopOpOpts,
	): Promise<{ note?: string }>;
	/** No lease needed. */
	catFile(
		name: string,
		path: string,
		opts?: DesktopOpOpts,
	): Promise<{ data: Uint8Array; note?: string }>;
}

export function makeDesktops(deps: DesktopsDeps): Desktops {
	const podman = deps.podman;
	const store = deps.store;
	const networkName = deps.networkName ?? "goblin-desktop";
	const shotsRoot = deps.shotsRoot ?? join(paths.state(), "desktops");
	const cfg = (): DesktopsConfig => deps.config() ?? DEFAULT_CONFIG;

	function requireOurs(name: string, ins: ContainerInspect): void {
		if (ins.labels["goblin.desktop"] !== "1" || ins.labels["goblin.desktop.name"] !== name) {
			throw refuse(
				name,
				"ensure",
				`container ${containerNameForDesktop(name)} is not a goblin desktop named ${name} — refusing to touch it`,
			);
		}
	}

	function freshRow(
		name: string,
		ins: { image: string; network: boolean; startedAt?: string },
	): DesktopRow {
		const now = Date.now();
		return {
			name,
			container: containerNameForDesktop(name),
			image: ins.image,
			network: ins.network,
			reserved: false,
			leaseKind: null,
			leaseId: null,
			leaseExpiresAt: null,
			lastObsId: null,
			lastObsUsed: false,
			lastObsHash: null,
			lastActSig: null,
			lastActFrameHash: null,
			bootGen: ins.startedAt ?? null,
			shotSeq: 0,
			createdAt: now,
			lastUsedAt: now,
		};
	}

	// Off is fail-closed: any failure to verify it removes the
	// container — an unknown state is not usable. Row out only after
	// rm lands; intended-on failures never trigger this cleanup.
	// Abort is honored only before the toggle dispatches — once begun,
	// the verifying inspect (and fail-closed drop) runs to completion.
	async function applyNetwork(name: string, want: boolean, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const container = containerNameForDesktop(name);
		const drop = async (why: string, cause?: unknown): Promise<never> => {
			try {
				await podman.rm(container);
			} catch (rmErr) {
				throw refuse(
					name,
					"network",
					`desktop ${name} ${why} — the container could not be removed either (${rmErr instanceof Error ? rmErr.message : String(rmErr)})`,
					undefined,
					rmErr,
				);
			}
			store.delete(name);
			throw refuse(
				name,
				"network",
				`desktop ${name} ${why} — the container was removed`,
				undefined,
				cause,
			);
		};
		let has: boolean;
		try {
			const before = await podman.inspect(container);
			has = before.networks.includes(networkName);
		} catch (err) {
			if (!want) {
				await drop(
					`network state could not be inspected (${err instanceof Error ? err.message : String(err)})`,
					err,
				);
			}
			throw err;
		}
		if (has === want) return;
		signal?.throwIfAborted();
		if (want) {
			await podman.networkConnect(networkName, container);
			const after = await podman.inspect(container);
			if (!after.networks.includes(networkName)) {
				throw new DesktopError(`desktop ${name} would not confirm network connect`);
			}
			return;
		}
		try {
			await podman.networkDisconnect(networkName, container);
		} catch (err) {
			await drop(
				`network disconnect failed (${err instanceof Error ? err.message : String(err)})`,
				err,
			);
		}
		// Its own try — a thrown drop must not be mistaken for an
		// inspect failure and drop twice.
		let stillOn = false;
		try {
			const after = await podman.inspect(container);
			stillOn = after.networks.includes(networkName);
		} catch (err) {
			await drop(
				`network state after disconnect could not be inspected (${err instanceof Error ? err.message : String(err)})`,
				err,
			);
		}
		if (stillOn) {
			await drop("would not confirm network off");
		}
	}

	async function createContainer(
		name: string,
		image: string,
		wantNetwork: boolean,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		if (!(await podman.imageExists(image))) {
			throw refuse(
				name,
				"create",
				`desktop image ${image} is not in the local store; build it from the repo root: podman build -t ${image} deploy/desktop`,
			);
		}
		signal?.throwIfAborted();
		await podman.networkEnsure(networkName);
		const c = cfg();
		const container = containerNameForDesktop(name);
		signal?.throwIfAborted();
		await podman.create({
			name: container,
			image,
			network: networkName,
			memory: c.memory,
			cpus: c.cpus,
			pids: c.pids,
			command: ["/usr/local/bin/goblin-desktop-session"],
			hostname: "desktop",
			shmSize: "1g",
			// CAP_SYS_CHROOT for Chromium's own sandbox zygote —
			// desktops only, operator-approved.
			extraCaps: ["SYS_CHROOT"],
			labels: { "goblin.desktop": "1", "goblin.desktop.name": name },
		});
		// Created ON the network — a --network none container can't be
		// connected later. `run` already landed, so the reconcile
		// finishes unconditionally: an abort would strand a networked,
		// rowless container.
		await applyNetwork(name, wantNetwork);
	}

	async function ensureLocked(name: string, signal?: AbortSignal): Promise<EnsureResult> {
		signal?.throwIfAborted();
		const container = containerNameForDesktop(name);
		const now = Date.now();
		const row = store.get(name);
		const ins = await podman.inspect(container);
		signal?.throwIfAborted();
		if (ins.state !== "missing") {
			requireOurs(name, ins);
			if (row === null) {
				// Labelled but rowless: adopt. Counts against the pool
				// cap like allocate — a lost database must not re-grow
				// the pool past max.
				const max = cfg().max;
				const held = new Set(store.list().map((r) => r.name));
				for (const pending of pendingAllocs) held.add(pending);
				if (!held.has(name) && held.size >= max) {
					throw refuse(
						name,
						"adopt",
						`desktop pool is full (max ${max}) — refusing to adopt the existing container; destroy a desktop first`,
					);
				}
				const adopted = freshRow(name, {
					image: ins.image,
					network: ins.networks.includes(networkName),
					startedAt: ins.startedAt,
				});
				store.put(adopted);
				if (ins.state === "stopped") {
					signal?.throwIfAborted();
					await podman.start(container);
					// Start dispatched — the reconcile finishes even on
					// cancellation.
					await applyNetwork(name, adopted.network);
					adopted.bootGen = (await podman.inspect(container)).startedAt;
					adopted.lastUsedAt = now;
					store.put(adopted);
					log.info("desktop adopted and started", { desktop: name, container });
					return {
						row: adopted,
						container,
						note: "adopted an existing desktop container and restarted it",
					};
				}
				adopted.lastUsedAt = now;
				store.put(adopted);
				log.info("desktop adopted", { desktop: name, container });
				return {
					row: adopted,
					container,
					note: "adopted an existing desktop container",
				};
			}
			if (ins.state === "stopped") {
				// The restart kills whatever the newest observation
				// showed — persist the invalidation BEFORE start: a
				// failed start must not leave a dead obs id live.
				// Network re-applies from the row's intent, not inspect.
				if (row.lastObsId !== null) {
					row.lastObsId = null;
					row.lastObsUsed = false;
					row.lastObsHash = null;
					row.lastActSig = null;
					row.lastActFrameHash = null;
					store.put(row);
					log.info("desktop observation invalidated — restart pending", {
						desktop: name,
						container,
					});
				}
				row.bootGen = null;
				signal?.throwIfAborted();
				await podman.start(container);
				// Start dispatched — the reconcile finishes even on
				// cancellation.
				await applyNetwork(name, row.network);
				row.bootGen = (await podman.inspect(container)).startedAt;
				row.lastUsedAt = now;
				store.put(row);
				log.info("desktop restarted", { desktop: name, container });
				return {
					row,
					container,
					note: "desktop was stopped — restarted it; files and network state restored, but the previous frame is gone — take a fresh screenshot before acting",
				};
			}
			// The row's network intent wins over a drifted actual (a
			// crash between connect and row update fails closed). An
			// out-of-band restart leaves Running=true — StartedAt is
			// the only witness that the newest frame died with the
			// previous boot; invalidate before any input binds.
			if (row.bootGen !== ins.startedAt) {
				if (row.lastObsId !== null) {
					row.lastObsId = null;
					row.lastObsUsed = false;
					row.lastObsHash = null;
					row.lastActSig = null;
					row.lastActFrameHash = null;
					log.info("desktop observation invalidated — container rebooted out of band", {
						desktop: name,
						container,
					});
				}
				row.bootGen = ins.startedAt;
				store.put(row);
			}
			await applyNetwork(name, row.network, signal);
			row.lastUsedAt = now;
			store.put(row);
			return { row, container };
		}
		if (row !== null) {
			// Missing with a row: recreate. Lease and obs state die with
			// the container; the reserved pin and shotSeq survive — the
			// sequence keeps pre-loss obs ids and audit names dead.
			await createContainer(name, row.image, row.network, signal);
			const kept = freshRow(name, {
				image: row.image,
				network: row.network,
				startedAt: (await podman.inspect(container)).startedAt,
			});
			kept.reserved = row.reserved;
			kept.createdAt = row.createdAt;
			kept.shotSeq = row.shotSeq;
			store.put(kept);
			log.info("desktop recreated", { desktop: name, container });
			return {
				row: kept,
				container,
				note: "desktop container was gone — recreated fresh; its previous contents and lease are gone",
			};
		}
		throw refuse(name, "ensure", `no desktop named ${name} — allocate it first`);
	}

	// Pruned on the one path every call rides. Destroy intentionally
	// freezes the trail for post-mortem.
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
		if (ins.state !== "missing") requireOurs(name, ins);
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
						await lane(victim, () => reapLocked(victim, cutoff));
					} catch (err) {
						// Keep the row — the next call retries.
						log.warn("desktop reap failed — row kept", err, {
							desktop: victim,
							container: containerNameForDesktop(victim),
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
		if (!NAME_RE.test(name)) {
			throw refuse(
				name,
				op,
				`invalid desktop name ${JSON.stringify(name)} — must match ${NAME_RE.source}`,
			);
		}
		pruneShots(name);
		const idle = cfg().idleHours;
		if (idle === 0) return;
		const cutoff = Date.now() - idle * 3_600_000;
		for (const row of store.staleBefore(cutoff, name)) enqueueReap(row.name, cutoff);
	}

	// Lifecycle ops are single-flight per desktop — row
	// read-modify-writes stay inside the lane.
	const lanes = new Map<string, Promise<void>>();

	// Capacity counts rows ∪ pending reservations; the synchronous
	// check-and-add is what keeps two allocations on different lanes
	// from slipping past max.
	const pendingAllocs = new Set<string>();
	function lane<T>(name: string, fn: () => Promise<T>): Promise<T> {
		const prev = lanes.get(name) ?? Promise.resolve();
		const run = prev.then(fn, fn);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		tail.finally(() => {
			if (lanes.get(name) === tail) lanes.delete(name);
		});
		lanes.set(name, tail);
		return run;
	}

	// cua-driver tokens are session-scoped — every call carries the
	// desktop name as its session.
	async function cuaCall(
		container: string,
		tool: string,
		args: Record<string, unknown>,
		name: string,
	): Promise<unknown> {
		const payload = { ...args, session: name };
		const r = await podman.exec(
			container,
			["cua-driver", "call", tool, JSON.stringify(payload), "--socket", SESSION_SOCKET],
			{ ...EXEC_OPTS, user: DESKTOP_USER, env: SESSION_ENV, workdir: "/run/desk" },
		);
		if (r.timedOut || r.exitCode !== 0) {
			// Driver failures can report on stdout — take whichever
			// channel carries the diagnostic.
			const diag = (r.stderr.trim() || r.stdout.trim()).slice(0, 300);
			throw new DesktopError(
				`cua-driver ${tool} failed on desktop ${name} (${r.timedOut ? "timeout" : `exit ${r.exitCode}`}): ${diag}`,
			);
		}
		try {
			return JSON.parse(r.stdout);
		} catch {
			throw new DesktopError(
				`cua-driver ${tool} returned unparseable output on desktop ${name}: ${r.stdout.slice(0, 300)}`,
			);
		}
	}

	// The uuid keeps an obs id unique across a same-ms
	// destroy/re-allocate (createdAt and shotSeq both reset). bootGen
	// was reconciled earlier in this lane call — never mint a frame
	// onto an unrecorded generation.
	function mintObservation(row: DesktopRow, hash: string, uuid: string): string {
		row.shotSeq += 1;
		row.lastObsId = `${row.name}:${row.shotSeq}:${uuid}`;
		row.lastObsUsed = false;
		row.lastObsHash = hash;
		row.lastUsedAt = Date.now();
		store.put(row);
		return row.lastObsId;
	}

	return {
		async allocate(name, opts) {
			sweepOnce(name, "allocate");
			if (opts?.image !== undefined && !imageRefSchema.safeParse(opts.image).success) {
				throw refuse(
					name,
					"allocate",
					`invalid desktop image ${JSON.stringify(opts.image)} — not a valid image ref`,
				);
			}
			// Synchronous check-and-add — no interleave between has
			// and add.
			if (pendingAllocs.has(name)) {
				throw refuse(name, "allocate", `desktop ${name} is already being allocated`);
			}
			const held = new Set(store.list().map((r) => r.name));
			for (const pending of pendingAllocs) held.add(pending);
			const max = cfg().max;
			if (!held.has(name) && held.size >= max) {
				throw refuse(
					name,
					"allocate",
					`desktop pool is full (max ${max}): ${[...held].sort().join(", ")} — destroy one first`,
				);
			}
			pendingAllocs.add(name);
			try {
				return await lane(name, async () => {
					if (store.get(name) !== null) {
						throw refuse(name, "allocate", `desktop ${name} already exists`);
					}
					const container = containerNameForDesktop(name);
					const ins = await podman.inspect(container);
					if (ins.state !== "missing") {
						requireOurs(name, ins);
						const adopted = freshRow(name, {
							image: ins.image,
							network: ins.networks.includes(networkName),
							startedAt: ins.startedAt,
						});
						store.put(adopted);
						log.info("desktop adopted on allocate", { desktop: name, container });
						return {
							row: adopted,
							note: "adopted an existing desktop container under that name",
						};
					}
					const image = opts?.image ?? cfg().image;
					await createContainer(name, image, false);
					const row = freshRow(name, { image, network: false });
					store.put(row);
					log.info("desktop created", { desktop: name, container, image });
					return { row, note: "created a new desktop (network off)" };
				});
			} finally {
				pendingAllocs.delete(name);
			}
		},

		list() {
			return store.list();
		},

		get(name) {
			return store.get(name);
		},

		async claim(name, holder) {
			sweepOnce(name, "claim");
			return await lane(name, async () => {
				const ready = await ensureLocked(name);
				const row = ready.row;
				const now = Date.now();
				if (leaseLive(row, now) && !leaseHeldBy(row, holder, now)) {
					const refusal = refuse(
						name,
						"claim",
						`desktop ${name} is controlled by ${rowHolderLabel(row)} until ${new Date(row.leaseExpiresAt!).toISOString()} — release or wait for expiry`,
						holder,
					);
					throw new DesktopLeaseError(refusal.message);
				}
				const transition =
					row.leaseKind === null
						? "claim"
						: leaseHeldBy(row, holder, now)
							? "renew"
							: "expired-claim";
				row.leaseKind = holder.kind;
				row.leaseId = holderId(holder);
				row.leaseExpiresAt = now + LEASE_TTL_MS;
				row.lastUsedAt = now;
				store.put(row);
				log.info("desktop lease", {
					desktop: name,
					holder: holderLabel(holder),
					transition,
				});
				return { ...row, ...(ready.note !== undefined ? { note: ready.note } : {}) };
			});
		},

		// Same sweep-then-lane order as claim/act — a row read outside
		// the lane loses updates to an in-flight act; skipping the
		// sweep would cut in line ahead of it.
		async release(name, holder) {
			sweepOnce(name, "release");
			await lane(name, async () => {
				const row = store.get(name);
				if (row === null) {
					throw refuse(name, "release", `no desktop named ${name}`, holder);
				}
				const now = Date.now();
				if (!leaseHeldBy(row, holder, now)) {
					const current = leaseLive(row, now) ? ` — it is held by ${rowHolderLabel(row)}` : "";
					throw refuse(
						name,
						"release",
						`only the holder can release desktop ${name}${current}`,
						holder,
					);
				}
				row.leaseKind = null;
				row.leaseId = null;
				row.leaseExpiresAt = null;
				row.lastUsedAt = now;
				store.put(row);
				log.info("desktop lease released", { desktop: name, holder: holderLabel(holder) });
			});
		},

		async handoff(name, from, to) {
			sweepOnce(name, "handoff");
			await lane(name, async () => {
				const row = store.get(name);
				if (row === null) {
					throw refuse(name, "handoff", `no desktop named ${name}`, from);
				}
				const now = Date.now();
				if (!leaseHeldBy(row, from, now)) {
					throw refuse(
						name,
						"handoff",
						`cannot hand off desktop ${name} — ${holderLabel(from)} does not hold it`,
						from,
					);
				}
				row.leaseKind = to.kind;
				row.leaseId = holderId(to);
				row.leaseExpiresAt = now + LEASE_TTL_MS;
				row.lastUsedAt = now;
				store.put(row);
				log.info("desktop lease handoff", {
					desktop: name,
					from: holderLabel(from),
					to: holderLabel(to),
				});
			});
		},

		async reserve(name, reserved) {
			sweepOnce(name, "reserve");
			await lane(name, async () => {
				const row = store.get(name);
				if (row === null) {
					throw refuse(name, "reserve", `no desktop named ${name}`);
				}
				row.reserved = reserved;
				store.put(row);
				log.info("desktop reserve", { desktop: name, reserved });
			});
		},

		async setNetwork(name, enabled, opts) {
			opts?.abortSignal?.throwIfAborted();
			sweepOnce(name, "network");
			await lane(name, async () => {
				opts?.abortSignal?.throwIfAborted();
				const ready = await ensureLocked(name, opts?.abortSignal);
				opts?.abortSignal?.throwIfAborted();
				await applyNetwork(name, enabled, opts?.abortSignal);
				// Dispatched and verified — the row write is its
				// reconciliation; never abort between them.
				ready.row.network = enabled;
				ready.row.lastUsedAt = Date.now();
				store.put(ready.row);
				log.info("desktop network", {
					desktop: name,
					container: ready.container,
					enabled,
				});
			});
		},

		async destroy(name, by, opts) {
			opts?.abortSignal?.throwIfAborted();
			sweepOnce(name, "destroy");
			await lane(name, async () => {
				opts?.abortSignal?.throwIfAborted();
				const row = store.get(name);
				const now = Date.now();
				if (row !== null && leaseLive(row, now) && !leaseHeldBy(row, by, now)) {
					throw refuse(
						name,
						"destroy",
						`desktop ${name} is controlled by ${rowHolderLabel(row)} — it can release, or its lease expires`,
						by,
					);
				}
				const container = containerNameForDesktop(name);
				const ins = await podman.inspect(container);
				opts?.abortSignal?.throwIfAborted();
				// Both absent = never a desktop — a false success on
				// the destructive verb is worse than a refusal. A
				// row/container skew is what destroy reconciles.
				if (row === null && ins.state === "missing") {
					throw refuse(name, "destroy", `no desktop named ${name}`, by);
				}
				if (ins.state !== "missing") {
					requireOurs(name, ins);
					await podman.rm(container);
				}
				store.delete(name);
				log.info("desktop destroyed", {
					desktop: name,
					container,
					by: holderLabel(by),
				});
			});
		},

		async screenshot(name) {
			sweepOnce(name, "screenshot");
			return await lane(name, async () => {
				const ready = await ensureLocked(name);
				const inContainer = `/run/desk/.shot-${Date.now()}.png`;
				const shot = await podman.exec(ready.container, ["scrot", "-o", inContainer], {
					...EXEC_OPTS,
					user: DESKTOP_USER,
					env: SESSION_ENV,
					workdir: "/run/desk",
				});
				if (shot.timedOut || shot.exitCode !== 0) {
					throw new DesktopError(
						`scrot failed on desktop ${name} (${shot.timedOut ? "timeout" : `exit ${shot.exitCode}`}): ${shot.stderr.slice(0, 300)}`,
					);
				}
				const read = await podman.execBytes(ready.container, ["cat", "--", inContainer], {
					...EXEC_OPTS,
					user: DESKTOP_USER,
					workdir: "/run/desk",
				});
				// Best-effort — a leftover temp in /run/desk is
				// harmless, an unobserved rejection is not.
				const rm = await podman.exec(ready.container, ["rm", "-f", inContainer], {
					...EXEC_OPTS,
					user: DESKTOP_USER,
					workdir: "/run/desk",
				});
				if (rm.timedOut || rm.exitCode !== 0) {
					log.warn("desktop screenshot temp rm failed", {
						desktop: name,
						path: inContainer,
						exit: rm.timedOut ? "timeout" : rm.exitCode,
					});
				}
				// A capped or drain-cut readback still exits 0 with
				// nonempty bytes — a partial frame must never reach
				// the audit file or mint an observation id.
				if (read.truncated || read.outputCapped === true) {
					throw new DesktopError(
						`screenshot readback from desktop ${name} was truncated/capped — the frame is incomplete`,
					);
				}
				if (read.timedOut || read.exitCode !== 0 || read.stdout.byteLength === 0) {
					throw new DesktopError(`could not read the screenshot back from desktop ${name}`);
				}
				const bytes = read.stdout;
				// The uuid in the basename stops a same-ms generation
				// clobbering the previous one's frames; the durable
				// write precedes the obs-id publish.
				const dir = join(shotsRoot, name, "shots");
				ensureDir(dir);
				const uuid = randomUUID();
				const path = join(dir, `${ready.row.createdAt}-${ready.row.shotSeq + 1}-${uuid}.png`);
				durableWriteBytes(path, bytes);
				const obsId = mintObservation(ready.row, sha256Hex(bytes), uuid);
				log.info("desktop screenshot", { desktop: name, observation: obsId, path });
				return {
					id: obsId,
					path,
					bytes,
					...(ready.note !== undefined ? { note: ready.note } : {}),
				};
			});
		},

		async inspect(name, opts) {
			sweepOnce(name, "inspect");
			return await lane(name, async () => {
				const ready = await ensureLocked(name);
				let pid = opts?.pid;
				if (pid === undefined) {
					const parsed = listWindowsSchema.safeParse(
						await cuaCall(ready.container, "list_windows", {}, name),
					);
					if (!parsed.success) {
						throw refuse(
							name,
							"inspect",
							`cua-driver list_windows returned an unexpected shape on desktop ${name}`,
							undefined,
							parsed.error,
						);
					}
					const list = parsed.data.windows ?? [];
					// Skip the desktop chrome — the topmost real window
					// is what the operator is looking at.
					const apps = list.filter((w) => !/^(xfce4-panel|xfdesktop)$/i.test(w.app_name));
					const win =
						apps.length === 0
							? list.sort((a, b) => b.z_index - a.z_index)[0]
							: apps.sort((a, b) => b.z_index - a.z_index)[0];
					if (win === undefined) {
						throw new DesktopError(`desktop ${name} shows no windows to inspect`);
					}
					pid = win.pid;
				}
				const state = await cuaCall(
					ready.container,
					"get_window_state",
					{ pid, ...(opts?.windowId !== undefined ? { window_id: opts.windowId } : {}) },
					name,
				);
				const shot =
					typeof state === "object" && state !== null && "screenshot" in state
						? (state as { screenshot?: unknown }).screenshot
						: undefined;
				const hash = typeof shot === "string" ? sha256Hex(shot) : sha256Hex(stableJson(state));
				const obsId = mintObservation(ready.row, hash, randomUUID());
				log.info("desktop inspect", { desktop: name, observation: obsId, pid });
				return {
					id: obsId,
					state,
					...(ready.note !== undefined ? { note: ready.note } : {}),
				};
			});
		},

		async act(name, holder, obsId, action) {
			sweepOnce(name, "act");
			return await lane(name, async () => {
				const t0 = Date.now();
				const ready = await ensureLocked(name);
				const row = ready.row;
				const now = Date.now();
				if (!leaseHeldBy(row, holder, now)) {
					const held = leaseLive(row, now);
					throw refuse(
						name,
						"act",
						held
							? `desktop ${name} is controlled by ${rowHolderLabel(row)} — ${holderLabel(holder)} cannot act on it`
							: `desktop ${name} has no live lease — ${holderLabel(holder)} must claim it before acting`,
						holder,
					);
				}
				if (obsId !== row.lastObsId || row.lastObsUsed) {
					throw refuse(
						name,
						"act",
						`observation ${obsId} is stale on desktop ${name} — take a fresh screenshot first`,
						holder,
					);
				}
				const sig = stableJson(action);
				if (sig === row.lastActSig && row.lastObsHash === row.lastActFrameHash) {
					throw refuse(
						name,
						"act",
						`identical action against an unchanged screen on ${name} — take a fresh screenshot first`,
						holder,
					);
				}
				if (action.kind === "launch" && action.url !== undefined && !launchUrlOk(action.url)) {
					throw refuse(
						name,
						"act",
						`launch url ${JSON.stringify(action.url)} is not allowed on ${name} — http(s)://, file:// or about:blank only`,
						holder,
					);
				}
				if (action.kind === "cua" && !CUA_TOOLS.has(action.tool)) {
					// Before consumption — a refused tool must not burn
					// the observation it rode in on.
					throw refuse(
						name,
						"act",
						`act tool ${JSON.stringify(action.tool)} is not an allowed input operation on ${name}`,
						holder,
					);
				}
				// Consume the observation and renew the lease BEFORE
				// dispatch — a failed or timed-out call still burns
				// the frame it was bound to.
				row.leaseExpiresAt = now + LEASE_TTL_MS;
				row.lastObsUsed = true;
				row.lastActSig = sig;
				row.lastActFrameHash = row.lastObsHash;
				row.lastUsedAt = now;
				store.put(row);
				let result: unknown;
				try {
					if (action.kind === "launch") {
						// Runs as desk with the fixed session env like
						// cuaCall — root reaches the launcher only via
						// the image's setpriv backstop.
						const r = await podman.exec(
							ready.container,
							["goblin-launch", action.app, ...(action.url === undefined ? [] : [action.url])],
							{ ...EXEC_OPTS, user: DESKTOP_USER, env: SESSION_ENV, workdir: "/run/desk" },
						);
						if (r.timedOut || r.exitCode !== 0) {
							throw new DesktopError(
								`launch ${action.app} failed on desktop ${name}: ${r.stderr.slice(0, 300)}`,
							);
						}
						result = { launched: action.app };
					} else {
						const args: Record<string, unknown> = { ...action.args };
						if (FOREGROUND_TOOLS.has(action.tool) && args.delivery_mode === undefined) {
							args.delivery_mode = "foreground";
						}
						result = await cuaCall(ready.container, action.tool, args, name);
					}
				} catch (err) {
					log.warn("desktop act failed", err, {
						desktop: name,
						holder: holderLabel(holder),
						obs: obsId,
						action: action.kind === "cua" ? `cua:${action.tool}` : `launch:${action.app}`,
						ms: Date.now() - t0,
					});
					throw new DesktopError(
						`${err instanceof Error ? err.message : String(err)} — the action may have partially run on ${name}; take a fresh screenshot before retrying`,
						{ cause: err },
					);
				}
				const effect =
					typeof result === "object" && result !== null && "effect" in result
						? (result as { effect?: unknown }).effect
						: undefined;
				log.info("desktop act", {
					desktop: name,
					holder: holderLabel(holder),
					obs: obsId,
					action: action.kind === "cua" ? `cua:${action.tool}` : `launch:${action.app}`,
					...(effect === undefined ? {} : { effect }),
					ms: Date.now() - t0,
				});
				return {
					result,
					...(ready.note !== undefined ? { note: ready.note } : {}),
				};
			});
		},

		async cpIn(name, hostPath, containerPath, opts) {
			opts?.abortSignal?.throwIfAborted();
			sweepOnce(name, "import");
			return await lane(name, async () => {
				opts?.abortSignal?.throwIfAborted();
				const ready = await ensureLocked(name, opts?.abortSignal);
				// Files only — `podman cp` onto an existing directory
				// copies INTO it, and a recursive chown of that dir
				// would rewrite unrelated desktop ownership.
				if (!containerPath.startsWith("/") || containerPath.endsWith("/")) {
					throw new DesktopError(
						`desktop import needs an absolute file path, got ${JSON.stringify(containerPath)}`,
					);
				}
				const parent = posix.dirname(containerPath);
				opts?.abortSignal?.throwIfAborted();
				const mk = await podman.exec(ready.container, ["mkdir", "-p", "--", parent], {
					...EXEC_OPTS,
					user: DESKTOP_USER,
					workdir: "/run/desk",
				});
				if (mk.timedOut || mk.exitCode !== 0) {
					throw new DesktopError(
						`could not create ${parent} on desktop ${name}: ${mk.stderr.slice(0, 200)}`,
					);
				}
				// An existing destination must be a regular,
				// non-symlink file — refuse before the copy touches
				// anything else.
				const pre = await podman.exec(
					ready.container,
					[
						"/bin/sh",
						"-c",
						'if [ -e "$1" ] || [ -L "$1" ]; then { [ -f "$1" ] && [ ! -L "$1" ]; } || exit 3; fi',
						"pre",
						containerPath,
					],
					{ ...EXEC_OPTS, user: DESKTOP_USER, workdir: "/run/desk" },
				);
				if (pre.timedOut || pre.exitCode !== 0) {
					throw new DesktopError(
						`refusing to import onto non-regular path ${containerPath} on desktop ${name}`,
					);
				}
				opts?.abortSignal?.throwIfAborted();
				// podman cp writes as container root — it only stages
				// bytes at a goblin-chosen path; desk performs the dest
				// write so a root-owned target fails loud instead of
				// silently succeeding under a chown. The stage dir is
				// made per-call: adopted/recreated containers got no
				// create-time hook.
				const mkStage = await podman.exec(
					ready.container,
					["mkdir", "-p", "--", IMPORT_STAGE_DIR],
					{ ...EXEC_OPTS, workdir: "/run/desk" },
				);
				if (mkStage.timedOut || mkStage.exitCode !== 0) {
					throw new DesktopError(
						`could not stage an import on desktop ${name}: ${mkStage.stderr.slice(0, 200)}`,
					);
				}
				opts?.abortSignal?.throwIfAborted();
				const stage = `${IMPORT_STAGE_DIR}/imp-${Date.now()}-${randomUUID().slice(0, 8)}`;
				try {
					await podman.cp(ready.container, hostPath, stage);
					// podman cp preserves the host mode — a 600 file
					// would be unreadable to the desk-side copy.
					const mode = await podman.exec(ready.container, ["chmod", "0644", "--", stage], {
						...EXEC_OPTS,
						workdir: "/run/desk",
					});
					if (mode.timedOut || mode.exitCode !== 0) {
						throw new DesktopError(
							`could not stage an import on desktop ${name}: ${mode.stderr.slice(0, 200)}`,
						);
					}
					// The desk-side copy is the visible write — abort
					// rechecked after the staging awaits so a cancelled
					// import never lands it.
					opts?.abortSignal?.throwIfAborted();
					const put = await podman.exec(ready.container, ["cp", "--", stage, containerPath], {
						...EXEC_OPTS,
						user: DESKTOP_USER,
						workdir: "/run/desk",
					});
					if (put.timedOut || put.exitCode !== 0) {
						throw new DesktopError(
							`could not import to ${containerPath} on desktop ${name}: ${put.stderr.slice(0, 200)}`,
						);
					}
					// cp follows a dest symlink — a swap after the
					// pre-check still lands bytes off-target; re-verify
					// the leaf desk produced.
					const post = await podman.exec(
						ready.container,
						["/bin/sh", "-c", '{ [ -f "$1" ] && [ ! -L "$1" ]; } || exit 3', "post", containerPath],
						{ ...EXEC_OPTS, user: DESKTOP_USER, workdir: "/run/desk" },
					);
					if (post.timedOut || post.exitCode !== 0) {
						throw new DesktopError(
							`imported ${containerPath} on desktop ${name} but the result is not a regular file`,
						);
					}
				} finally {
					// Best-effort — a leftover stage in the root-owned
					// dir is harmless; it must never mask the real error.
					try {
						const rm = await podman.exec(ready.container, ["rm", "-f", "--", stage], {
							...EXEC_OPTS,
							workdir: "/run/desk",
						});
						if (rm.timedOut || rm.exitCode !== 0) {
							log.warn("desktop import stage rm failed", {
								desktop: name,
								path: stage,
								exit: rm.timedOut ? "timeout" : rm.exitCode,
							});
						}
					} catch (err) {
						log.warn("desktop import stage rm failed", err, {
							desktop: name,
							path: stage,
						});
					}
				}
				log.info("desktop import", { desktop: name, to: containerPath });
				return { ...(ready.note !== undefined ? { note: ready.note } : {}) };
			});
		},

		async catFile(name, path, opts) {
			opts?.abortSignal?.throwIfAborted();
			sweepOnce(name, "export");
			return await lane(name, async () => {
				opts?.abortSignal?.throwIfAborted();
				const ready = await ensureLocked(name, opts?.abortSignal);
				opts?.abortSignal?.throwIfAborted();
				// Mirrors sandboxes.catFile: regular files only —
				// test -f alone follows a leaf symlink.
				const probe = await podman.exec(
					ready.container,
					["/bin/sh", "-c", 'test -f "$1" && ! test -L "$1"', "desk-check", path],
					{
						...EXEC_OPTS,
						user: DESKTOP_USER,
						workdir: "/run/desk",
						...(opts?.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
					},
				);
				opts?.abortSignal?.throwIfAborted();
				if (probe.timedOut || probe.exitCode !== 0) {
					throw new DesktopError(`${path} is not a regular file on desktop ${name}`);
				}
				const r = await podman.execBytes(ready.container, ["cat", "--", path], {
					timeoutMs: EXPORT_TIMEOUT_MS,
					maxOutput: EXPORT_MAX_BYTES,
					user: DESKTOP_USER,
					workdir: "/run/desk",
					...(opts?.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
				});
				opts?.abortSignal?.throwIfAborted();
				if (r.truncated || r.stdout.byteLength > EXPORT_MAX_BYTES) {
					throw new DesktopError(
						`export exceeds the ${EXPORT_MAX_BYTES / (1024 * 1024)} MiB cap — nothing was exported`,
					);
				}
				if (r.timedOut || r.exitCode !== 0) {
					throw new DesktopError(
						`could not read ${path} from desktop ${name} (exit ${r.timedOut ? "timeout" : r.exitCode})`,
					);
				}
				log.info("desktop export", {
					desktop: name,
					path,
					bytes: r.stdout.byteLength,
				});
				return {
					data: r.stdout,
					...(ready.note !== undefined ? { note: ready.note } : {}),
				};
			});
		},
	};
}
