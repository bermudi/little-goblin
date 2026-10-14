// The desktop tool (design/subagents.md → Desktops): the operator-
// facing handle on the managed pool — allocate, observe, lease,
// network, files, destroy. Input control itself belongs to computer
// subagents; this tool can observe any desktop and manage leases for
// its own conversation only — the operator exists solely as a handoff
// destination, so a model can never claim, release, hand off or
// destroy AS another holder, and "cannot take a live lease" is
// enforced in desktops.ts.

import { tool } from "ai";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { exportBytes, readImport } from "../../box-files.ts";
import { imageRefSchema } from "../../config.ts";
import { DesktopError, type DesktopRow, type Desktops, type LeaseHolder } from "../../desktops.ts";
import { PodmanError } from "../../podman.ts";
import { DESKTOP_TOOL_DESCRIPTION } from "../../subagent-prompts.ts";

export interface DesktopToolDeps {
	/** The conversation this call runs in — the default lease holder. */
	conversation: string;
	workspace: string;
	desktops: Desktops;
}

const nameSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "desktop names are [a-z0-9-], 1-31 chars");
// The self holder admits only "conversation" — a model can never act
// as the operator; the operator exists only as a handoff target.
const holderSchema = z.enum(["conversation"]);
const targetHolderSchema = z.enum(["conversation", "operator"]);

const newSchema = z.object({
	action: z.literal("new"),
	name: nameSchema,
	image: imageRefSchema.optional(),
});
const listSchema = z.object({ action: z.literal("list") });
const shotSchema = z.object({ action: z.literal("shot"), name: nameSchema });
const claimSchema = z.object({
	action: z.literal("claim"),
	name: nameSchema,
	holder: holderSchema.optional(),
});
const releaseSchema = z.object({
	action: z.literal("release"),
	name: nameSchema,
	holder: holderSchema.optional(),
});
const handoffSchema = z.object({
	action: z.literal("handoff"),
	name: nameSchema,
	holder: holderSchema.optional(),
	to_holder: targetHolderSchema,
});
const reserveSchema = z.object({
	action: z.literal("reserve"),
	name: nameSchema,
	reserved: z.boolean(),
});
const networkSchema = z.object({
	action: z.literal("network"),
	name: nameSchema,
	enabled: z.boolean(),
});
const importSchema = z.object({
	action: z.literal("import"),
	name: nameSchema,
	from: z.string().min(1),
	to: z.string().min(1),
});
const exportSchema = z.object({
	action: z.literal("export"),
	name: nameSchema,
	from: z.string().min(1),
	to: z.string().min(1).optional(),
});
const destroySchema = z.object({
	action: z.literal("destroy"),
	name: nameSchema,
	holder: holderSchema.optional(),
});

const actionSchema = z.discriminatedUnion("action", [
	newSchema,
	listSchema,
	shotSchema,
	claimSchema,
	releaseSchema,
	handoffSchema,
	reserveSchema,
	networkSchema,
	importSchema,
	exportSchema,
	destroySchema,
]);

export const desktopInputSchema = z
	.object({
		action: z.enum([
			"new",
			"list",
			"shot",
			"claim",
			"release",
			"handoff",
			"reserve",
			"network",
			"import",
			"export",
			"destroy",
		]),
		name: nameSchema.optional(),
		image: newSchema.shape.image,
		enabled: networkSchema.shape.enabled.optional(),
		reserved: reserveSchema.shape.reserved.optional(),
		holder: holderSchema.optional(),
		to_holder: targetHolderSchema.optional(),
		from: importSchema.shape.from.optional(),
		to: importSchema.shape.to.optional(),
	})
	.superRefine((value, ctx) => {
		const result = actionSchema.safeParse(value);
		if (!result.success)
			for (const issue of result.error.issues) {
				ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
			}
	});

function view(row: DesktopRow) {
	return {
		name: row.name,
		image: row.image,
		network: row.network,
		reserved: row.reserved,
		lease:
			row.leaseKind === null
				? undefined
				: {
						kind: row.leaseKind,
						id: row.leaseId ?? undefined,
						expires_at:
							row.leaseExpiresAt === null ? undefined : new Date(row.leaseExpiresAt).toISOString(),
					},
	};
}

export const desktopTool = (deps: DesktopToolDeps) => {
	// Holder identity is derived, never taken: the self is always THIS
	// conversation — no ids cross the wire, and no schema path produces
	// {kind:"operator"} for the acting side. Handoff targets resolve
	// separately; "operator" is a destination, never a self.
	const selfHolder = (): LeaseHolder => ({ kind: "conversation", id: deps.conversation });
	const targetHolderOf = (h: "conversation" | "operator"): LeaseHolder =>
		h === "operator" ? { kind: "operator" } : selfHolder();
	return tool({
		description: DESKTOP_TOOL_DESCRIPTION,
		inputSchema: desktopInputSchema,
		execute: async (raw, { abortSignal }) => {
			const parsed = actionSchema.safeParse(raw);
			if (!parsed.success) {
				return {
					error: `invalid desktop call: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
				};
			}
			const input = parsed.data;
			try {
				switch (input.action) {
					case "new": {
						const { row, note } = await deps.desktops.allocate(
							input.name,
							input.image === undefined ? {} : { image: input.image },
						);
						return { desktop: view(row), ...(note !== undefined ? { note } : {}) };
					}
					case "list":
						return { desktops: deps.desktops.list().map(view) };
					case "shot": {
						// The audited path, not the pixels — send_file carries
						// it to the operator; computer runs get the image inline.
						const shot = await deps.desktops.screenshot(input.name);
						return {
							observation_id: shot.id,
							path: shot.path,
							...(shot.note !== undefined ? { note: shot.note } : {}),
						};
					}
					case "claim": {
						const row = await deps.desktops.claim(input.name, selfHolder());
						return {
							desktop: view(row),
							// A recreated/adopted/restarted box loses its
							// previous files and leases — the claim note is
							// the caller's only evidence of that.
							...(row.note !== undefined ? { note: row.note } : {}),
						};
					}
					case "release": {
						await deps.desktops.release(input.name, selfHolder());
						return { released: input.name };
					}
					case "handoff": {
						await deps.desktops.handoff(input.name, selfHolder(), targetHolderOf(input.to_holder));
						return { handed_off: input.name, to: input.to_holder };
					}
					case "reserve": {
						await deps.desktops.reserve(input.name, input.reserved);
						return { name: input.name, reserved: input.reserved };
					}
					case "network": {
						await deps.desktops.setNetwork(input.name, input.enabled);
						return {
							name: input.name,
							enabled: input.enabled,
							...(input.enabled
								? {
										warning:
											"network on — the desktop can now reach the internet AND the operator's LAN/tailnet",
									}
								: {}),
						};
					}
					case "import": {
						// cpIn takes a host path — stage a copy so the workspace
						// file itself is never the argument a caller controls.
						const stage = await mkdtemp(join(tmpdir(), "goblin-desk-imp-"));
						try {
							abortSignal?.throwIfAborted();
							const resolved = readImport(deps.workspace, input.from);
							if ("error" in resolved) return { error: `import ${resolved.error}` };
							const staged = join(stage, basename(resolved.path));
							await writeFile(staged, resolved.data);
							abortSignal?.throwIfAborted();
							const { note } = await deps.desktops.cpIn(input.name, staged, input.to);
							return {
								imported: input.to,
								bytes: resolved.data.byteLength,
								...(note !== undefined ? { note } : {}),
							};
						} finally {
							await rm(stage, { recursive: true, force: true });
						}
					}
					case "export": {
						const rel = input.to ?? join("desktop-out", basename(input.from));
						if (isAbsolute(rel)) {
							return {
								error: `export destination must be workspace-relative, got absolute: ${rel}`,
							};
						}
						const { data, note } = await deps.desktops.catFile(input.name, input.from);
						// The wait above is a cancellation gap: recheck before
						// the host write so a call cancelled mid-read never
						// overwrites a workspace file.
						abortSignal?.throwIfAborted();
						const out = exportBytes(deps.workspace, dirname(rel), basename(rel), data);
						if ("error" in out) return { error: `export ${out.error}` };
						return {
							exported: out.rel,
							bytes: data.byteLength,
							...(note !== undefined ? { note } : {}),
						};
					}
					case "destroy": {
						await deps.desktops.destroy(
							input.name,
							selfHolder(),
							abortSignal === undefined ? undefined : { abortSignal },
						);
						return { destroyed: input.name };
					}
				}
			} catch (err) {
				if (err instanceof DesktopError || err instanceof PodmanError) {
					return { error: err.message };
				}
				throw err;
			}
		},
	});
};
