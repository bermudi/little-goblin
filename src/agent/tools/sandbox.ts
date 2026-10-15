// The sandbox tool (design/sandbox.md): a disposable rootless-podman
// container per conversation — bash's discipline (bounded run,
// tail-truncated output, flat-schema per-action union) inside a wall
// the host never crosses: no mounts, no env, no daemon access. Files
// move only through import (workspace → container, realpath-contained)
// and export (container → workspace, byte stream through `cat`, never
// a host path the container could aim).

import { tool } from "ai";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { readImport, resolveExport, writeExportBytes } from "../../box-files.ts";
import { imageRefSchema } from "../../config.ts";
import { PodmanError } from "../../podman.ts";
import { SandboxError, type Sandboxes } from "../../sandboxes.ts";
import { truncateTail } from "./truncate.ts";

const MAX_OUTPUT = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

export interface SandboxToolDeps {
	/** The conversation this tool call runs in — its one sandbox. */
	conversation: string;
	workspace: string;
	sandboxes: Sandboxes;
}

const execSchema = z.object({
	action: z.literal("exec"),
	command: z.string().min(1),
	timeout_ms: z.number().int().positive().optional(),
});
const importSchema = z.object({
	action: z.literal("import"),
	from: z.string().min(1),
	to: z.string().min(1),
});
const exportSchema = z.object({
	action: z.literal("export"),
	from: z.string().min(1),
	to: z.string().min(1).optional(),
});
const networkSchema = z.object({
	action: z.literal("network"),
	enabled: z.boolean(),
});
const resetSchema = z.object({
	action: z.literal("reset"),
	image: imageRefSchema.optional(),
});

// The strict per-action contract, enforced inside execute — the wire
// schema stays flat (design/tools.md; a root discriminatedUnion
// serializes to oneOf some providers can't generate arguments for).
const actionSchema = z.discriminatedUnion("action", [
	execSchema,
	importSchema,
	exportSchema,
	networkSchema,
	resetSchema,
]);

export const sandboxInputSchema = z
	.object({
		action: z.enum(["exec", "import", "export", "network", "reset"]),
		command: execSchema.shape.command.optional(),
		timeout_ms: execSchema.shape.timeout_ms,
		from: importSchema.shape.from.optional(),
		to: importSchema.shape.to.optional(),
		enabled: networkSchema.shape.enabled.optional(),
		image: resetSchema.shape.image,
	})
	.superRefine((value, ctx) => {
		const result = actionSchema.safeParse(value);
		if (!result.success)
			for (const issue of result.error.issues) {
				ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
			}
	});

export const sandboxTool = (deps: SandboxToolDeps) =>
	tool({
		description:
			"Run things in a disposable Linux sandbox — one container per conversation, kept until reset or idle. This is NOT the host: nothing here touches the operator's machine, files, or services, and no host filesystem is shared — files cross only via import/export. You are root inside. The default image is alpine (apk add to install). Network is OFF until enabled; when on, the sandbox reaches the internet AND the operator's LAN/tailnet — the pattern for untrusted code is: enable → download → disable → run it. exec runs /bin/sh -c; state (installed packages, files under /work and everywhere) persists between calls until reset or the idle reap.",
		inputSchema: sandboxInputSchema,
		execute: async (raw, { abortSignal }) => {
			const input = actionSchema.parse(raw);
			// Every action is a mutation or an engine read past this point —
			// a dead call never starts one.
			abortSignal?.throwIfAborted();
			const conv = deps.conversation;
			try {
				switch (input.action) {
					case "exec": {
						const { result, note } = await deps.sandboxes.exec(conv, input.command, {
							timeoutMs: Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
							maxOutput: MAX_OUTPUT,
							...(abortSignal ? { abortSignal } : {}),
						});
						const combined = result.stdout + result.stderr;
						const tail = truncateTail(combined, MAX_OUTPUT);
						const truncated = result.truncated || tail.truncated;
						return {
							exit_code: result.timedOut ? null : result.exitCode,
							timed_out: result.timedOut || undefined,
							truncated: truncated || undefined,
							output: tail.content,
							...(note !== undefined ? { note } : {}),
						};
					}
					case "import": {
						const stage = await mkdtemp(join(tmpdir(), "goblin-sbx-imp-"));
						try {
							abortSignal?.throwIfAborted();
							const source = readImport(deps.workspace, input.from);
							if ("error" in source) return { error: `import ${source.error}` };
							const staged = join(stage, basename(source.path));
							await writeFile(staged, source.data);
							const { note } = await deps.sandboxes.cpIn(conv, staged, input.to, {
								...(abortSignal ? { abortSignal } : {}),
							});
							return { imported: input.to, ...(note !== undefined ? { note } : {}) };
						} finally {
							await rm(stage, { recursive: true, force: true });
						}
					}
					case "export": {
						const rel = input.to ?? join("sandbox-out", basename(input.from));
						// box-files owns the containment checks; unlike its export
						// helpers, the sandbox writes the exact destination,
						// overwriting in place rather than numbering. The early
						// resolve refuses bad destinations before paying the
						// container read.
						const early = resolveExport(deps.workspace, rel);
						if ("error" in early) return { error: early.error };
						const { data, note } = await deps.sandboxes.catFile(conv, input.from, {
							...(abortSignal ? { abortSignal } : {}),
						});
						// The wait above is a cancellation gap: recheck before
						// the host write so a call cancelled mid-read (or a nested
						// export the script VM killed) never overwrites a
						// workspace file.
						abortSignal?.throwIfAborted();
						// The resolved path is stale after the read — the write
						// re-derives containment and pins the parent dir FD so a
						// swapped ancestor can't redirect it.
						const written = writeExportBytes(deps.workspace, rel, data);
						if ("error" in written) return { error: written.error };
						return {
							exported: rel,
							bytes: data.byteLength,
							...(note !== undefined ? { note } : {}),
						};
					}
					case "network": {
						const { note } = await deps.sandboxes.setNetwork(conv, input.enabled, {
							...(abortSignal ? { abortSignal } : {}),
						});
						return {
							enabled: input.enabled,
							...(input.enabled
								? {
										warning:
											"network on — the sandbox can now reach the internet AND the operator's LAN/tailnet; disable it before running downloaded code",
									}
								: {}),
							...(note !== undefined ? { note } : {}),
						};
					}
					case "reset": {
						const { note } = await deps.sandboxes.reset(conv, input.image, {
							...(abortSignal ? { abortSignal } : {}),
						});
						return { reset: true, ...(note !== undefined ? { note } : {}) };
					}
				}
			} catch (err) {
				if (err instanceof SandboxError || err instanceof PodmanError) {
					return { error: err.message };
				}
				// Ordinary destination/path mistakes — a file where a
				// directory was expected, a directory where a file was
				// expected — are refusals the model can fix, not step-fatal.
				// Resource/device errors (ENOSPC, EIO) stay loud.
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR" || code === "ENOTEMPTY") {
					return { error: (err as Error).message };
				}
				throw err;
			}
		},
	});
