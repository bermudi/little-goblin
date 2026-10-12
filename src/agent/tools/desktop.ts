// The desktop tool (design/subagents.md → Desktops): the operator-
// facing handle on the managed pool — allocate, observe, lease,
// network, files, destroy. Input control itself belongs to computer
// subagents; this tool can observe any desktop and manage leases for
// its own conversation or the operator, but holder ids are built here
// from the bound conversation — a model can never claim as another
// holder, and "cannot take a live lease" is enforced in desktops.ts.

import { tool } from "ai";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { exportBytes, resolveImport } from "../../box-files.ts";
import { imageRefSchema } from "../../config.ts";
import {
	DesktopError,
	type DesktopRow,
	type Desktops,
	type LeaseHolder,
} from "../../desktops.ts";
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
const holderSchema = z.enum(["conversation", "operator"]);

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
	to_holder: holderSchema,
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
		to_holder: holderSchema.optional(),
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
							row.leaseExpiresAt === null
								? undefined
								: new Date(row.leaseExpiresAt).toISOString(),
					},
	};
}

export const desktopTool = (deps: DesktopToolDeps) => {
	// Holder identity is derived, never taken: "conversation" means THIS
	// conversation's id, "operator" the operator — no ids cross the wire.
	const holderOf = (h: "conversation" | "operator" | undefined): LeaseHolder =>
		h === "operator" ? { kind: "operator" } : { kind: "conversation", id: deps.conversation };
	return tool({
		description: DESKTOP_TOOL_DESCRIPTION,
		inputSchema: desktopInputSchema,
		execute: async (raw) => {
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
						const row = await deps.desktops.claim(input.name, holderOf(input.holder));
						return { desktop: view(row) };
					}
					case "release": {
						await deps.desktops.release(input.name, holderOf(input.holder));
						return { released: input.name };
					}
					case "handoff": {
						await deps.desktops.handoff(
							input.name,
							holderOf(input.holder),
							holderOf(input.to_holder),
						);
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
						const resolved = resolveImport(deps.workspace, input.from);
						if ("error" in resolved) return { error: `import ${resolved.error}` };
						// cpIn takes a host path — stage a copy so the workspace
						// file itself is never the argument a caller controls.
						const stage = await mkdtemp(join(tmpdir(), "goblin-desk-imp-"));
						try {
							const staged = join(stage, basename(resolved.path));
							await copyFile(resolved.path, staged);
							const { note } = await deps.desktops.cpIn(input.name, staged, input.to);
							return {
								imported: input.to,
								bytes: resolved.bytes,
								...(note !== undefined ? { note } : {}),
							};
						} finally {
							await rm(stage, { recursive: true, force: true });
						}
					}
					case "export": {
						const rel = input.to ?? join("desktop-out", basename(input.from));
						const { data, note } = await deps.desktops.catFile(input.name, input.from);
						const out = exportBytes(deps.workspace, rel.includes("/") ? rel.split("/").slice(0, -1).join("/") : "", basename(rel), data);
						if ("error" in out) return { error: `export ${out.error}` };
						return {
							exported: out.rel,
							bytes: data.byteLength,
							...(note !== undefined ? { note } : {}),
						};
					}
					case "destroy": {
						await deps.desktops.destroy(input.name, holderOf(input.holder));
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
