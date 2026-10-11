// The sandbox tool (design/sandbox.md): a disposable rootless-podman
// container per conversation — bash's discipline (bounded run,
// tail-truncated output, flat-schema per-action union) inside a wall
// the host never crosses: no mounts, no env, no daemon access. Files
// move only through import (workspace → container, realpath-contained)
// and export (container → workspace, byte stream through `cat`, never
// a host path the container could aim).

import { tool } from "ai";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { imageRefSchema } from "../../config.ts";
import { durableWriteBytes } from "../../durable.ts";
import { PodmanError } from "../../podman.ts";
import { SandboxError, type Sandboxes } from "../../sandboxes.ts";
import { resolvePath, writeThroughTarget } from "./paths.ts";
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
						const resolved = resolvePath(deps.workspace, input.from);
						const wsReal = realpathSync(deps.workspace);
						// A lexical `..` escape is refused before the
						// filesystem is touched — the realpath check below
						// only runs once the path exists, and an absolute
						// `from` is refused the same way.
						const wsLex = resolve(deps.workspace);
						if (resolved !== wsLex && !resolved.startsWith(wsLex + sep)) {
							return {
								error: `import refused: ${input.from} resolves to ${resolved}, outside the workspace — copy it into the workspace first if this is deliberate`,
							};
						}
						let real: string;
						try {
							real = realpathSync(resolved);
						} catch (err) {
							if ((err as NodeJS.ErrnoException).code === "ENOENT") {
								return { error: `import source not found: ${input.from}` };
							}
							throw err;
						}
						if (real !== wsReal && !real.startsWith(wsReal + sep)) {
							return {
								error: `import refused: ${input.from} resolves to ${real}, outside the workspace — copy it into the workspace first if this is deliberate`,
							};
						}
						const { note } = await deps.sandboxes.cpIn(conv, real, input.to);
						return { imported: input.to, ...(note !== undefined ? { note } : {}) };
					}
					case "export": {
						const rel = input.to ?? join("sandbox-out", basename(input.from));
						if (isAbsolute(rel)) {
							return {
								error: `export destination must be a workspace-relative path, got absolute: ${rel}`,
							};
						}
						const wsReal = realpathSync(deps.workspace);
						const dest = resolvePath(wsReal, rel);
						if (!dest.startsWith(wsReal + sep)) {
							return {
								error: `export refused: ${rel} resolves to ${dest}, outside the workspace`,
							};
						}
						// A symlinked directory or leaf could aim the write
						// anywhere — the parent realpath and the write-through
						// target must both stay inside the workspace.
						const parent = dirname(dest);
						// Recursive mkdir follows an intermediate symlink, so
						// before creating anything the containment check runs on
						// the deepest ancestor that EXISTS — otherwise
						// `link -> /outside` plus a missing `a/b` tail would seed
						// empty dirs outside the workspace before refusing.
						let anchor = parent;
						while (anchor !== wsReal && anchor.startsWith(wsReal + sep)) {
							try {
								lstatSync(anchor);
								break;
							} catch (err) {
								if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
								anchor = dirname(anchor);
							}
						}
						const realAnchor = realpathSync(anchor);
						if (realAnchor !== wsReal && !realAnchor.startsWith(wsReal + sep)) {
							return {
								error: `export refused: ${anchor} resolves to ${realAnchor}, outside the workspace`,
							};
						}
						mkdirSync(parent, { recursive: true });
						const realParent = realpathSync(parent);
						if (realParent !== wsReal && !realParent.startsWith(wsReal + sep)) {
							return {
								error: `export refused: ${parent} resolves to ${realParent}, outside the workspace`,
							};
						}
						const through = writeThroughTarget(dest);
						if ("error" in through) return { error: through.error };
						if (!through.target.startsWith(wsReal + sep)) {
							return {
								error: `export refused: ${rel} is a symlink to ${through.target}, outside the workspace`,
							};
						}
						const { data, note } = await deps.sandboxes.catFile(conv, input.from);
						durableWriteBytes(through.target, data);
						return {
							exported: rel,
							bytes: data.byteLength,
							...(note !== undefined ? { note } : {}),
						};
					}
					case "network": {
						const { note } = await deps.sandboxes.setNetwork(conv, input.enabled);
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
						const { note } = await deps.sandboxes.reset(conv, input.image);
						return { reset: true, ...(note !== undefined ? { note } : {}) };
					}
				}
			} catch (err) {
				if (err instanceof SandboxError || err instanceof PodmanError) {
					return { error: err.message };
				}
				throw err;
			}
		},
	});
