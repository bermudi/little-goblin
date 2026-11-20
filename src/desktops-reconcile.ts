import type { DesktopsConfig } from "./config-schema.ts";
import { log } from "./log.ts";
import type { ContainerInspect, Podman } from "./podman.ts";
import type { DesktopRow, DesktopStore, LeaseHolder } from "./desktops-store.ts";

// Container reconciliation moved from makeDesktops (#461). Parent-owned
// mutable state is read through live accessors on ctx.
export interface ReconcilerCtx {
	podman: Podman;
	store: DesktopStore;
	networkName: string;
	cfg(): DesktopsConfig;
	/** The parent owns this Set and never reassigns it. */
	pendingAllocs: Set<string>;
	containerNameForDesktop(name: string): string;
	refuse(
		desktop: string,
		op: string,
		reason: string,
		holder?: LeaseHolder,
		cause?: unknown,
	): Error;
	DesktopError: new (message: string) => Error;
}

export interface EnsureResult {
	row: DesktopRow;
	container: string;
	note?: string;
}

export function makeReconciler(ctx: ReconcilerCtx): {
	requireOurs(name: string, ins: ContainerInspect): void;
	freshRow(name: string, ins: { image: string; network: boolean; startedAt?: string }): DesktopRow;
	applyNetwork(name: string, want: boolean, signal?: AbortSignal): Promise<void>;
	createContainer(
		name: string,
		image: string,
		wantNetwork: boolean,
		signal?: AbortSignal,
	): Promise<void>;
	ensureLocked(name: string, signal?: AbortSignal): Promise<EnsureResult>;
} {
	const { podman, store, networkName } = ctx;
	const containerNameForDesktop = ctx.containerNameForDesktop;

	function requireOurs(name: string, ins: ContainerInspect): void {
		if (ins.labels["goblin.desktop"] !== "1" || ins.labels["goblin.desktop.name"] !== name) {
			throw ctx.refuse(
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
	// container — an unknown state is not usable. The row stays, as a
	// sandbox's does (#292): intent off and the dead frame are written
	// BEFORE rm, so a failed rm or a later call never re-applies a
	// stale "on", and the next call recreates offline from the row.
	// Intended-on failures never trigger this cleanup.
	// Abort is honored only before the toggle dispatches — once begun,
	// the verifying inspect (and fail-closed drop) runs to completion.
	async function applyNetwork(name: string, want: boolean, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const container = containerNameForDesktop(name);
		const drop = async (why: string, cause?: unknown): Promise<never> => {
			const row = store.get(name);
			if (row !== null) {
				row.network = false;
				row.lastObsId = null;
				row.lastObsUsed = false;
				row.lastObsHash = null;
				row.lastActSig = null;
				row.lastActFrameHash = null;
				store.put(row);
			}
			log.warn("desktop network unconfirmed — removing container, row kept", cause, {
				desktop: name,
				container,
				why,
				row: row !== null,
			});
			try {
				await podman.rm(container);
			} catch (rmErr) {
				throw ctx.refuse(
					name,
					"network",
					`desktop ${name} ${why} — the container could not be removed either (${rmErr instanceof Error ? rmErr.message : String(rmErr)})`,
					undefined,
					rmErr,
				);
			}
			throw ctx.refuse(
				name,
				"network",
				`desktop ${name} ${why} — the container was removed; the next call recreates it with the network off`,
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
				throw new ctx.DesktopError(`desktop ${name} would not confirm network connect`);
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
			throw ctx.refuse(
				name,
				"create",
				`desktop image ${image} is not in the local store; build it from the repo root: podman build -t ${image} deploy/desktop`,
			);
		}
		signal?.throwIfAborted();
		await podman.networkEnsure(networkName);
		const c = ctx.cfg();
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
				const max = ctx.cfg().max;
				const held = new Set(store.list().map((r) => r.name));
				for (const pending of ctx.pendingAllocs) held.add(pending);
				if (!held.has(name) && held.size >= max) {
					throw ctx.refuse(
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
		throw ctx.refuse(name, "ensure", `no desktop named ${name} — allocate it first`);
	}

	return { requireOurs, freshRow, applyNetwork, createContainer, ensureLocked };
}
