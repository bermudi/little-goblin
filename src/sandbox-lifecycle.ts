// Podman-side create/network/drop layer makeSandboxes reconciles
// through — this module owns every truth-side mutation. Network is
// fail-closed (an unconfirmable off removes the container); creation
// bumps the conversation's generation so a killed exec's queued
// restart can never reap a newer container's work.

import { log } from "./log.ts";
import type { ContainerInspect, Podman } from "./podman.ts";
import { SandboxError } from "./sandboxes.ts";
import type { SandboxConfig } from "./config.ts";

export interface ContainerLifecycleDeps {
	podman: Podman;
	networkName: string;
	/** Live config — re-read per call, never snapshotted. */
	cfg: () => SandboxConfig;
	/** rm/create invalidates any in-flight generation check. */
	bumpGeneration: (conv: string) => void;
}

export interface ContainerLifecycle {
	requireOurs(name: string, ins: ContainerInspect): void;
	applyNetwork(name: string, want: boolean, conv: string, signal?: AbortSignal): Promise<void>;
	prepareContainer(image: string, conv: string, signal?: AbortSignal): Promise<SandboxConfig>;
	requireImage(image: string, conv: string): Promise<void>;
	createContainer(
		name: string,
		image: string,
		wantNetwork: boolean,
		conv: string,
		prepared?: SandboxConfig,
		signal?: AbortSignal,
	): Promise<void>;
}

export function makeContainerLifecycle(deps: ContainerLifecycleDeps): ContainerLifecycle {
	const { podman, networkName, cfg, bumpGeneration } = deps;

	function requireOurs(name: string, ins: ContainerInspect): void {
		if (ins.labels["goblin.sandbox"] !== "1") {
			throw new SandboxError(
				`container ${name} exists without the goblin.sandbox label — refusing to touch it`,
			);
		}
	}

	// Off is fail-closed: any failure to verify it removes the
	// container — an unknown state is not usable. Keep the row for its
	// image and intent; intended-on failures never trigger this
	// cleanup. An abort is honored only before the connect/disconnect
	// dispatch — once the toggle has begun, the verifying inspect (and
	// fail-closed drop) runs to completion so the caller never gets an
	// unverified state.
	async function applyNetwork(
		name: string,
		want: boolean,
		conv: string,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		const drop = async (why: string, cause?: unknown): Promise<never> => {
			try {
				await podman.rm(name, conv);
			} catch (rmErr) {
				throw new SandboxError(
					`sandbox ${name} ${why} — the container could not be removed either (${rmErr instanceof Error ? rmErr.message : String(rmErr)})`,
					{ cause: rmErr },
				);
			}
			bumpGeneration(conv);
			log.warn("sandbox removed — network off could not be confirmed", {
				conversation: conv,
				container: name,
				reason: why,
			});
			throw new SandboxError(`sandbox ${name} ${why} — the container was removed`, {
				...(cause === undefined ? {} : { cause }),
			});
		};
		let has: boolean;
		try {
			const before = await podman.inspect(name, conv);
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
			await drop(
				`network disconnect failed (${err instanceof Error ? err.message : String(err)})`,
				err,
			);
		}
		// The confirming inspect is in its own try so a thrown drop
		// can't be mistaken for an inspect failure and drop twice.
		let stillOn = false;
		try {
			const after = await podman.inspect(name, conv);
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

	// Everything a create needs that must be verified BEFORE reset can
	// destroy the incumbent: image in the local store, isolated
	// network, live config. Callers that already ran it pass the
	// result through so post-destruction code never re-checks.
	async function prepareContainer(
		image: string,
		conv: string,
		signal?: AbortSignal,
	): Promise<SandboxConfig> {
		signal?.throwIfAborted();
		if (!(await podman.imageExists(image, conv))) {
			throw new SandboxError(
				`image ${image} is not in the local store; ask the operator to run: podman pull ${image}`,
			);
		}
		signal?.throwIfAborted();
		await podman.networkEnsure(networkName, conv);
		return cfg();
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
		prepared?: SandboxConfig,
		signal?: AbortSignal,
	): Promise<void> {
		const c = prepared ?? (await prepareContainer(image, conv, signal));
		signal?.throwIfAborted();
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
		bumpGeneration(conv);
		// Creation already dispatched: finish reconciliation even if cancelled.
		// A failed bring-to-state must never leave a rowless connected box
		// that the next call could adopt as intentionally networked.
		try {
			await applyNetwork(name, wantNetwork, conv);
		} catch (err) {
			const ins = await podman.inspect(name, conv).catch((inspectErr: unknown) => {
				log.warn("sandbox cleanup inspect failed — attempting removal", inspectErr, {
					conversation: conv,
					container: name,
				});
				return null;
			});
			if (ins?.state !== "missing") {
				await podman.rm(name, conv);
				bumpGeneration(conv);
			}
			throw err;
		}
	}

	return { requireOurs, applyNetwork, prepareContainer, requireImage, createContainer };
}
