// Desktop pool — the desktops table plus the lifecycle owner
// (design/subagents.md → Desktops: a managed pool). A desktop is a
// named, long-lived `goblin-desk-*` container running the
// goblin-desktop session (Xvfb + XFCE + cua-driver); anyone may
// observe it, exactly one lease holder may drive it. The row is
// intent, podman is truth, and every call reconciles the two —
// running → use, stopped → start + network re-applied, missing →
// recreate (prior state gone), labelled-but-rowless → adopt.
//
// Observation binding is the core invariant: every observation mints a
// fresh id, and act refuses anything not bound to the newest, unused
// observation — an input action can never target a frame the model
// hasn't seen. Repeating an identical action against an unchanged
// screen is refused too.
//
// Reaping rides the start of every call — unleased, unreserved
// desktops idle past idleHours lose their container then their row;
// the stale listing is synchronous (the caller's desktop exempt),
// the removals run on a detached single-flight chain, so another
// desktop's reap is never on a call's critical path. No ticker, no
// boot hook. Network is fail-closed: an off state that can't be
// confirmed by inspect removes the container rather than use it.

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

// Model/operator-actionable failures (held leases, stale observations,
// missing image) — the tool maps these to {error} results.
export class DesktopError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DesktopError";
	}
}

export type LeaseHolder =
	| { kind: "run"; id: string }
	| { kind: "conversation"; id: string }
	| { kind: "operator" };

// The action surface is cua-driver 0.34.1's input tools minus the
// ones that bypass goblin's own gates: launch_app/kill_app would
// route around the goblin-launch whitelist and refusal logging, the
// browser_* set drives a CDP channel we don't wire, and the raw
// mouse_* / move_cursor / parallel_mouse_drag primitives are covered
// by click/drag. Observation tools (list_windows, get_window_state,
// get_desktop_state, zoom, verify_state) ride inspect/screenshot.
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

// The dispatch allowlist — the union above as a runtime set, so act
// fails loud on a non-member tool instead of forwarding it to
// cua-driver. Kept literal against the union: growing one without the
// other is a type error. Callers gate with this too, but act is the
// enforcement point — the type cast at the boundary proves nothing.
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

export interface DesktopRow {
	name: string;
	container: string;
	image: string;
	/** Intended network state — the row is intent, podman is truth. */
	network: boolean;
	reserved: boolean;
	leaseKind: "run" | "conversation" | "operator" | null;
	leaseId: string | null;
	leaseExpiresAt: number | null;
	/** Observation binding: the newest minted observation id and
	 *  whether an action already consumed it. */
	lastObsId: string | null;
	lastObsUsed: boolean;
	/** sha256 of the observation frame — PNG bytes for screenshots,
	 *  the cua screenshot (or state JSON) for inspect. */
	lastObsHash: string | null;
	/** The last action's signature and the frame it was bound to —
	 *  the identical-action-on-unchanged-screen refusal. */
	lastActSig: string | null;
	lastActFrameHash: string | null;
	/** The container boot (podman State.StartedAt) the recorded
	 *  observation was minted on; null = unknown (fresh, migrated, or
	 *  just-restarted row — the next reconcile records it). Optional
	 *  in the type because unknown is a real state for row literals
	 *  built outside this module. */
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
	/** Rows idle since before cutoffMs, excluding one desktop. */
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
	// Pools opened before the boot generation existed get the column
	// backfilled; NULL reads as unknown generation, so the first
	// reconcile invalidates any recorded observation — fail-closed.
	const cols = new Set(
		db.query<{ name: string }, []>("PRAGMA table_info(desktops)").all().map((c) => c.name),
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
// Root-owned 0755 dir for the cpIn stage — desk can read/traverse it
// but cannot write, rename, or plant links inside.
const IMPORT_STAGE_DIR = "/run/goblin-import";
const SESSION_SOCKET = "/run/desk/cua.sock";
// The fixed desk session env — goblin-launch pins the same set in the
// image; nothing here may be derived from container-writable state.
const SESSION_ENV = {
	HOME: "/home/desk",
	DISPLAY: ":99",
	DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/desk/bus",
	XDG_RUNTIME_DIR: "/home/desk/.runtime",
} as const;
const EXEC_OPTS = { timeoutMs: 60_000, maxOutput: 4 * 1024 * 1024 } as const;
const EXPORT_MAX_BYTES = 100 * 1024 * 1024;
const EXPORT_TIMEOUT_MS = 120_000;

// Chromium refuses background-injected input whenever its renderer
// isn't the focused surface; foreground delivery is also just the
// right semantic for a model driving one visible desktop. AT-SPI
// actions (invoke_menu, set_window_frame, bring_to_front) don't take
// delivery_mode — set_value does, but it's AT-SPI SetValue, not
// injected input, so it's out too.
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

// The design wants every refusal on the log with its reason — the
// model sees the same message back as the tool result.
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

// Launch URLs are model-controlled strings that land on Chromium's
// argv — a bare `--flag` would become a browser switch. Only real
// URLs (no whitespace or control characters) or exactly about:blank.
const LAUNCH_URL_RE = /^(?:https?|file):\/\/[^\s\x00-\x1f\x7f]+$/;
function launchUrlOk(url: string): boolean {
	return url === "about:blank" || LAUNCH_URL_RE.test(url);
}

// Key-order-canonical JSON — the identical-action check must not care
// how the caller ordered its object keys.
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
	/** Live read — absent = the schema defaults. */
	config(): DesktopsConfig | undefined;
	/** Screenshot audit dir — $GOBLIN_HOME/state/desktops in prod. */
	shotsRoot?: string;
	/** Test seams — prod leaves both at their defaults. */
	networkName?: string;
}

interface EnsureResult {
	row: DesktopRow;
	container: string;
	note?: string;
}

export interface Desktops {
	allocate(name: string, opts?: { image?: string }): Promise<{ row: DesktopRow; note?: string }>;
	list(): DesktopRow[];
	get(name: string): DesktopRow | null;
	/** The leased row, plus the reconcile's lifecycle note when the
	 *  ensure adopted/restarted/recreated the container — callers
	 *  surface it, it is never stored on the row. */
	claim(name: string, holder: LeaseHolder): Promise<DesktopRow & { note?: string }>;
	release(name: string, holder: LeaseHolder): Promise<void>;
	handoff(name: string, from: LeaseHolder, to: LeaseHolder): Promise<void>;
	reserve(name: string, reserved: boolean): Promise<void>;
	setNetwork(name: string, enabled: boolean): Promise<void>;
	destroy(name: string, by: LeaseHolder): Promise<void>;
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
	/** hostPath → containerPath staged through podman cp, landed by a
	 *  desk-user copy — the caller owns the source's provenance
	 *  (box-files containment); no lease needed. */
	cpIn(name: string, hostPath: string, containerPath: string): Promise<{ note?: string }>;
	/** A regular file's bytes as `desk` (symlinks/dirs refused), or
	 *  DesktopError. The export twin of cpIn; no lease needed. */
	catFile(name: string, path: string): Promise<{ data: Uint8Array; note?: string }>;
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

	// Reconcile actual network state with intent. Off is fail-closed:
	// any failure to verify it removes the container — an unknown
	// state is not usable. Row out only after rm lands; intended-on
	// failures never trigger this cleanup.
	async function applyNetwork(name: string, want: boolean): Promise<void> {
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
		// The confirming inspect is in its own try so a thrown drop
		// can't be mistaken for an inspect failure and drop twice.
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

	async function createContainer(name: string, image: string, wantNetwork: boolean): Promise<void> {
		if (!(await podman.imageExists(image))) {
			throw refuse(
				name,
				"create",
				`desktop image ${image} is not in the local store; build it from the repo root: podman build -t ${image} deploy/desktop`,
			);
		}
		await podman.networkEnsure(networkName);
		const c = cfg();
		const container = containerNameForDesktop(name);
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
			// Chromium's own sandbox needs CAP_SYS_CHROOT for its zygote
			// — desktops only, operator-approved; sandboxes keep the five.
			extraCaps: ["SYS_CHROOT"],
			labels: { "goblin.desktop": "1", "goblin.desktop.name": name },
		});
		// Created ON the network — a --network none container can never
		// be connected later — then brought to the intended state.
		await applyNetwork(name, wantNetwork);
	}

	// The reconcile, inside the desktop's lane.
	async function ensureLocked(name: string): Promise<EnsureResult> {
		const container = containerNameForDesktop(name);
		const now = Date.now();
		const row = store.get(name);
		const ins = await podman.inspect(container);
		if (ins.state !== "missing") {
			requireOurs(name, ins);
			if (row === null) {
				// A labelled container with no row: adopt — the inspect
				// tells us its image, network state and boot generation.
				const adopted = freshRow(name, {
					image: ins.image,
					network: ins.networks.includes(networkName),
					startedAt: ins.startedAt,
				});
				store.put(adopted);
				if (ins.state === "stopped") {
					await podman.start(container);
					// A start is a new boot — the generation we just
					// recorded is void until the next running reconcile.
					adopted.bootGen = null;
					await applyNetwork(name, adopted.network);
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
				// E.g. a host reboot — filesystem intact, network re-applied
				// from the row (the intent), not from whatever inspect saw.
				// The restart kills whatever the newest observation showed,
				// so that frame is dead: persist the invalidation BEFORE
				// start — a failed start must not leave a dead obs id live
				// (design/subagents.md, observation binding). Lease,
				// reserved pin, shot sequence and files survive.
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
				// A start is a new boot — the recorded generation is void
				// until the next running reconcile reads the new StartedAt.
				row.bootGen = null;
				await podman.start(container);
				await applyNetwork(name, row.network);
				row.lastUsedAt = now;
				store.put(row);
				log.info("desktop restarted", { desktop: name, container });
				return {
					row,
					container,
					note: "desktop was stopped — restarted it; files and network state restored, but the previous frame is gone — take a fresh screenshot before acting",
				};
			}
			// Running: the row's network intent wins over a drifted actual
			// (a crash between connect and row update fails closed).
			// Boot reconciliation: an out-of-band restart leaves
			// Running=true and the container in place, so the recorded
			// StartedAt is the only witness that the newest frame died
			// with the previous boot — invalidate it before any input can
			// bind (observation binding). mintObservation rides the
			// generation recorded here, in the same lane call.
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
			await applyNetwork(name, row.network);
			row.lastUsedAt = now;
			store.put(row);
			return { row, container };
		}
		if (row !== null) {
			// Missing with a row: recreate fresh. The lease and
			// observation state are gone with the container; the reserved
			// pin survives — and so does the shot sequence, which names
			// the audit frames and obs ids minted before the loss.
			await createContainer(name, row.image, row.network);
			const kept = freshRow(name, { image: row.image, network: row.network });
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

	// Audit frames are bounded: the newest SHOTS_RETENTION files per
	// desktop survive (by mtime), older ones are pruned here — the one
	// path every call rides — so an active desktop is bounded at call
	// time and a reaped one at removal. Destroy intentionally freezes
	// the trail for post-mortem (ruling in design/subagents.md).
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
			// Best-effort per file — a failed unlink must not fail the
			// desktop call riding this prune, only say so on the log.
			try {
				rmSync(join(dir, file));
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
				log.warn("desktop shot prune failed", err, { desktop: name, file });
			}
		}
		log.info("desktop shots pruned", { desktop: name, removed: over, kept: SHOTS_RETENTION });
	}

	// The reap verdict, inside the victim's lane: the listing was a
	// stale snapshot, so idle/reservation/lease is re-read here — a
	// claim, observation, or pin landing between the listing and the
	// rm must win the race. Same label guard as destroy and adoption:
	// never touch a container goblin's labels don't claim.
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

	// Reaps run on one dedicated chain, off the callers' critical
	// path: the listing is synchronous in the caller's own call (its
	// desktop exempt), the lane joins and rm happen here — reaping
	// desktop B never blocks acting on desktop A. Candidates coalesce
	// into one set, so reaps stay single-flight.
	const reapQueue = new Map<string, number>();
	let reapTail: Promise<void> = Promise.resolve();
	let reapQueued = false;
	function enqueueReap(name: string, cutoff: number): void {
		reapQueue.set(name, cutoff);
		if (reapQueued) return;
		reapQueued = true;
		const run = reapTail.then(async () => {
			// Cleared at run start: arrivals during the run schedule
			// the follow-up instead of being dropped.
			reapQueued = false;
			while (reapQueue.size > 0) {
				const batch = [...reapQueue];
				reapQueue.clear();
				for (const [victim, cutoff] of batch) {
					try {
						await lane(victim, () => reapLocked(victim, cutoff));
					} catch (err) {
						// Keep the row — the next call retries the reap.
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

	// Called at the top of every entry point: bound the caller's audit
	// frames, list stale rows (caller exempt) and hand them to the
	// reaper chain. Synchronous — nothing here can block the call
	// behind another desktop's lane.
	function sweepOnce(name: string): void {
		pruneShots(name);
		const idle = cfg().idleHours;
		if (idle === 0) return;
		const cutoff = Date.now() - idle * 3_600_000;
		for (const row of store.staleBefore(cutoff, name)) enqueueReap(row.name, cutoff);
	}

	// Lifecycle ops are single-flight per desktop; claim/obs/act
	// read-modify-write the row inside the same lane.
	const lanes = new Map<string, Promise<void>>();

	// Capacity counts rows ∪ pending reservations — the check-and-add
	// in allocate is synchronous, so two allocations on different
	// lanes can't both slip past max.
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

	// A cua-driver call as the session user: the socket is desk-owned
	// and the daemon's element tokens are session-scoped — every call
	// carries the desktop name as its session.
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
			// Some driver failures report on stdout (stderr empty) — take
			// whichever channel carries the diagnostic, capped.
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
	// destroy/re-allocate (createdAt and shotSeq both reset). The
	// caller mints it — screenshot needs it for the audit basename —
	// but the row publish happens only here. bootGen was reconciled
	// against the live container earlier in this lane call, so a
	// frame is never minted onto an unrecorded generation.
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
			sweepOnce(name);
			if (!NAME_RE.test(name)) {
				throw refuse(
					name,
					"allocate",
					`invalid desktop name ${JSON.stringify(name)} — must match ${NAME_RE.source}`,
				);
			}
			if (opts?.image !== undefined && !imageRefSchema.safeParse(opts.image).success) {
				throw refuse(
					name,
					"allocate",
					`invalid desktop image ${JSON.stringify(opts.image)} — not a valid image ref`,
				);
			}
			// Check-and-add is synchronous — a second allocate can't
			// interleave between them.
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
			sweepOnce(name);
			return await lane(name, async () => {
				const ready = await ensureLocked(name);
				const row = ready.row;
				const now = Date.now();
				if (leaseLive(row, now) && !leaseHeldBy(row, holder, now)) {
					throw refuse(
						name,
						"claim",
						`desktop ${name} is controlled by ${rowHolderLabel(row)} until ${new Date(row.leaseExpiresAt!).toISOString()} — release or wait for expiry`,
						holder,
					);
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

		// release/handoff/reserve sweep then ride the same lane as
		// claim/act — both halves keep call order: a row read outside
		// the lane loses updates to an in-flight act, and skipping the
		// sweep would let these cut in line ahead of it.
		async release(name, holder) {
			sweepOnce(name);
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
			sweepOnce(name);
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
			sweepOnce(name);
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

		async setNetwork(name, enabled) {
			sweepOnce(name);
			await lane(name, async () => {
				const ready = await ensureLocked(name);
				await applyNetwork(name, enabled);
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

		async destroy(name, by) {
			sweepOnce(name);
			await lane(name, async () => {
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
			sweepOnce(name);
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
				// Best-effort temp cleanup — a leftover file in /run/desk
				// is harmless, an unobserved rejection is not.
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
				// A capped or drain-cut readback can still exit 0 with
				// nonempty bytes — a partial frame must never reach the
				// audit file or mint an observation id.
				if (read.truncated || read.outputCapped === true) {
					throw new DesktopError(
						`screenshot readback from desktop ${name} was truncated/capped — the frame is incomplete`,
					);
				}
				if (read.timedOut || read.exitCode !== 0 || read.stdout.byteLength === 0) {
					throw new DesktopError(`could not read the screenshot back from desktop ${name}`);
				}
				const bytes = read.stdout;
				// The uuid in the basename keeps a same-ms
				// destroy/re-allocate generation from clobbering the
				// previous one's frames. The durable write precedes the
				// obs-id publish.
				const dir = join(shotsRoot, name, "shots");
				ensureDir(dir);
				const uuid = randomUUID();
				const path = join(dir, `${ready.row.createdAt}-${ready.row.shotSeq + 1}-${uuid}.png`);
				durableWriteBytes(path, bytes);
				const obsId = mintObservation(ready.row, sha256Hex(bytes), uuid);
				return {
					id: obsId,
					path,
					bytes,
					...(ready.note !== undefined ? { note: ready.note } : {}),
				};
			});
		},

		async inspect(name, opts) {
			sweepOnce(name);
			return await lane(name, async () => {
				const ready = await ensureLocked(name);
				let pid = opts?.pid;
				if (pid === undefined) {
					const windows = (await cuaCall(ready.container, "list_windows", {}, name)) as {
						windows?: Array<{ pid: number; app_name: string; z_index: number }>;
					};
					const list = windows.windows ?? [];
					// The point of inspect is the app the operator is looking
					// at — skip the desktop chrome (panel, desktop), take the
					// topmost real window.
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
				return {
					id: obsId,
					state,
					...(ready.note !== undefined ? { note: ready.note } : {}),
				};
			});
		},

		async act(name, holder, obsId, action) {
			sweepOnce(name);
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
				// Observation binding: act only on the newest, unconsumed
				// observation (design/subagents.md — Eliza's mechanism).
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
					// Enforcement lives here, at the dispatch, not only in
					// callers — the type-level CuaTool cast proves nothing
					// at runtime. Runs before consumption: a refused tool
					// must not burn the observation it rode in on.
					throw refuse(
						name,
						"act",
						`act tool ${JSON.stringify(action.tool)} is not an allowed input operation on ${name}`,
						holder,
					);
				}
				// Consume the observation and renew the lease BEFORE
				// dispatch: input is never replay-safe, so a failed or
				// timed-out call still burns the frame it was bound to.
				row.leaseExpiresAt = now + LEASE_TTL_MS;
				row.lastObsUsed = true;
				row.lastActSig = sig;
				row.lastActFrameHash = row.lastObsHash;
				row.lastUsedAt = now;
				store.put(row);
				let result: unknown;
				try {
					if (action.kind === "launch") {
						// The launcher runs as desk with the fixed session
						// env, exactly like cuaCall — root would only reach
						// it through the in-image setpriv backstop.
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

		async cpIn(name, hostPath, containerPath) {
			sweepOnce(name);
			return await lane(name, async () => {
				const ready = await ensureLocked(name);
				// File destinations only — `podman cp` onto an existing
				// directory copies INTO it, and a recursive chown of that
				// directory would rewrite unrelated desktop ownership.
				if (!containerPath.startsWith("/") || containerPath.endsWith("/")) {
					throw new DesktopError(
						`desktop import needs an absolute file path, got ${JSON.stringify(containerPath)}`,
					);
				}
				const parent = posix.dirname(containerPath);
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
				// An existing destination must be a regular, non-symlink
				// file — refuse before the copy touches anything else.
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
				// podman cp writes as container root, so it only stages the
				// bytes at a goblin-chosen path in a dir desk can't write;
				// desk itself performs the destination write — a root-owned
				// target fails loudly instead of silently succeeding under
				// a chown. The dir is made per-call: adopted or recreated
				// containers never got a create-time hook.
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
				const stage = `${IMPORT_STAGE_DIR}/imp-${Date.now()}-${randomUUID().slice(0, 8)}`;
				try {
					await podman.cp(ready.container, hostPath, stage);
					// podman cp preserves the host mode — a 600 file would be
					// unreadable to the desk-side copy below.
					const mode = await podman.exec(ready.container, ["chmod", "0644", "--", stage], {
						...EXEC_OPTS,
						workdir: "/run/desk",
					});
					if (mode.timedOut || mode.exitCode !== 0) {
						throw new DesktopError(
							`could not stage an import on desktop ${name}: ${mode.stderr.slice(0, 200)}`,
						);
					}
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
					// cp follows a dest symlink — the pre-check refused one,
					// but a swap in between still lands bytes off-target;
					// re-verify the leaf desk produced.
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
					// Best-effort stage cleanup — a leftover in the root-owned
					// dir is harmless and must never mask the real error.
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

		async catFile(name, path) {
			sweepOnce(name);
			return await lane(name, async () => {
				const ready = await ensureLocked(name);
				// Same export contract as sandboxes.catFile: regular
				// files only — -f alone follows a leaf symlink.
				const probe = await podman.exec(
					ready.container,
					["/bin/sh", "-c", 'test -f "$1" && ! test -L "$1"', "desk-check", path],
					{ ...EXEC_OPTS, user: DESKTOP_USER, workdir: "/run/desk" },
				);
				if (probe.timedOut || probe.exitCode !== 0) {
					throw new DesktopError(`${path} is not a regular file on desktop ${name}`);
				}
				const r = await podman.execBytes(ready.container, ["cat", "--", path], {
					timeoutMs: EXPORT_TIMEOUT_MS,
					maxOutput: EXPORT_MAX_BYTES,
					user: DESKTOP_USER,
					workdir: "/run/desk",
				});
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
				return {
					data: r.stdout,
					...(ready.note !== undefined ? { note: ready.note } : {}),
				};
			});
		},
	};
}
