import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { exportNamedBytes, readImport } from "../box-files.ts";
import { DesktopError, type Desktops } from "../desktops.ts";
import { PodmanError } from "../podman.ts";
import { SandboxError, type Sandboxes } from "../sandboxes.ts";
import type { SubagentRun, SubagentRuns } from "../subagent-runs.ts";
import { SubagentError } from "./errors.ts";

interface TransferArgs {
	deps: { transferRoot: string; desktops: Desktops; sandboxes: Sandboxes };
	runs: SubagentRuns;
	throwIfHalted(rowId: number): void;
	isClosing(): boolean;
	isHarnessClosed(): boolean;
}

export function buildTransfer(args: TransferArgs) {
	const { deps, runs, throwIfHalted } = args;
	// ---------- files in/out ----------

	async function importFiles(row: SubagentRun): Promise<string[]> {
		const requested = row.files;
		if (requested.length === 0) return [];
		const dirTag = `run-${row.id}`;
		const stageDir = join(deps.transferRoot, dirTag);
		mkdirSync(stageDir, { recursive: true });
		const inbox: string[] = [];
		const errors: string[] = [];
		try {
			for (const [i, f] of requested.entries()) {
				throwIfHalted(row.id);
				const resolved = readImport(row.workspace, f);
				if ("error" in resolved) {
					errors.push(`${f}: ${resolved.error}`);
					continue;
				}
				const base = `${String(i + 1).padStart(2, "0")}-${basename(resolved.path)}`;
				const staged = join(stageDir, base);
				writeFileSync(staged, resolved.data);
				throwIfHalted(row.id);
				const dest =
					row.kind === "computer"
						? `/home/desk/inbox/subagents/${row.id}/${base}`
						: `/inbox/subagents/${row.id}/${base}`;
				if (row.kind === "computer") {
					await deps.desktops.cpIn(row.desktop!, staged, dest);
				} else {
					const mk = await deps.sandboxes.execArgv(
						row.conversationId,
						["mkdir", "-p", "--", posix.dirname(dest)],
						{ timeoutMs: 30_000, maxOutput: 64 * 1024 },
					);
					if (mk.result.timedOut || mk.result.truncated || mk.result.exitCode !== 0) {
						throw new SubagentError(
							`inbox directory could not be created: ${mk.result.stderr.trim().slice(0, 200)}`,
						);
					}
					throwIfHalted(row.id);
					await deps.sandboxes.cpIn(row.conversationId, staged, dest);
				}
				throwIfHalted(row.id);
				inbox.push(dest);
			}
		} finally {
			rmSync(stageDir, { recursive: true, force: true });
		}
		if (errors.length > 0) {
			throw new SubagentError(`import refused: ${errors.join("; ")}`);
		}
		return inbox;
	}

	// Deterministic numbered basenames under the run's own dir, progress
	// persisted per source so a restart reuses landed artifacts instead
	// of recopying box files that may have changed.
	async function exportOutcomeFiles(
		row: SubagentRun,
		files: string[],
	): Promise<{ exported: string[]; errors: string[] }> {
		const relDir = join("subagents", String(row.id));
		for (const [i, f] of files.entries()) {
			// A stop mid-export lands between files — landed artifacts
			// stay recorded, the rest are simply not copied.
			const latest = runs.get(row.id);
			if (
				args.isClosing() ||
				args.isHarnessClosed() ||
				latest === null ||
				latest.stopRequested ||
				latest.status === "stopped"
			) {
				break;
			}
			if (row.exportProgress[f] !== undefined) continue;
			const source = f;
			if (!f.startsWith("/")) {
				row = runs.recordExport(row.id, source, {
					error: `${f}: export paths must be absolute box paths`,
				});
				continue;
			}
			let outcome: { rel: string } | { error: string };
			try {
				const data =
					row.kind === "computer"
						? (await deps.desktops.catFile(row.desktop!, f)).data
						: (await deps.sandboxes.catFile(row.conversationId, f)).data;
				const name = `${String(i + 1).padStart(2, "0")}-${basename(f)}`;
				const out = exportNamedBytes(row.workspace, relDir, name, data);
				outcome = "error" in out ? { error: `${f}: ${out.error}` } : { rel: out.rel };
			} catch (err) {
				// Only the export boundary's own typed refusals are
				// model-visible outcomes — an unexpected host/storage
				// error is a failed settle, not a fabricated refusal: it
				// propagates so the run stays owned and monitor recovery
				// retries the durable export later.
				if (
					err instanceof DesktopError ||
					err instanceof SandboxError ||
					err instanceof PodmanError
				) {
					outcome = { error: `${f}: ${err.message}` };
				} else {
					throw err;
				}
			}
			row = runs.recordExport(row.id, source, outcome);
		}
		const exported: string[] = [];
		const errors: string[] = [];
		for (const f of files) {
			const p = row.exportProgress[f];
			if (p === undefined) continue;
			if ("rel" in p) exported.push(p.rel);
			else errors.push(p.error);
		}
		return { exported, errors };
	}

	return { importFiles, exportOutcomeFiles };
}
