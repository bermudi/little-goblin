// The note tool — the agent's only way into the notes surface
// (design/projects.md → Notes). Mounted on every operator
// conversation (guests are filtered out at assembly); project
// conversations default their scope to the project, unbound ones to
// loose notes. Every refusal a model can act on — a stale rev, a bad
// range, a missing note — comes back as tool output, never a thrown
// turn.

import { tool } from "ai";
import { z } from "zod";
import {
	NoteConflictError,
	NoteInputError,
	type Note,
	NoteRangeError,
	noteFence,
	type NoteStore,
} from "../../notes.ts";
import type { ProjectStore } from "../../projects.ts";

export interface NoteToolDeps {
	notes: NoteStore;
	projects: Pick<ProjectStore, "get">;
	// The calling conversation — recorded on versions so a restore
	// names who wrote over the state.
	conversation: string;
	// The conversation's project binding — scope "here" and create's
	// default home.
	projectId: string | null;
}

const listSchema = z.object({
	action: z.literal("list"),
	query: z.string().optional(),
	scope: z.enum(["here", "all"]).optional(),
});
const readSchema = z.object({ action: z.literal("read"), id: z.string().min(1) });
const createSchema = z.object({
	action: z.literal("create"),
	title: z.string().min(1).max(200),
	body: z.string().optional(),
	where: z.enum(["here", "loose"]).optional(),
});
const appendSchema = z.object({
	action: z.literal("append"),
	id: z.string().min(1),
	text: z.string().min(1),
});
const replaceSchema = z.object({
	action: z.literal("replace"),
	id: z.string().min(1),
	body: z.string(),
	title: z.string().min(1).max(200).optional(),
	// A whole-body write is destructive — it must name the rev it read.
	rev: z.number().int().positive(),
});
const rangeSchema = z.object({
	action: z.literal("replace_range"),
	id: z.string().min(1),
	edits: z
		.array(
			z.object({
				start: z.number().int().min(0),
				end: z.number().int().min(0),
				expected: z.string(),
				text: z.string(),
			}),
		)
		.min(1),
});
const actionSchema = z.discriminatedUnion("action", [
	listSchema,
	readSchema,
	createSchema,
	appendSchema,
	replaceSchema,
	rangeSchema,
]);

// The flat wire shape (program.ts's ruling): providers can't drive a
// root-level oneOf, so the input schema carries every field optional
// and the discriminated union owns the exact contract inside execute.
export const noteInputSchema = z
	.object({
		action: z.enum(["list", "read", "create", "append", "replace", "replace_range"]),
		query: z.string().optional(),
		scope: z.enum(["here", "all"]).optional(),
		id: z.string().optional(),
		title: z.string().optional(),
		body: z.string().optional(),
		where: z.enum(["here", "loose"]).optional(),
		text: z.string().optional(),
		rev: z.number().int().positive().optional(),
		edits: rangeSchema.shape.edits.optional(),
	})
	.superRefine((value, ctx) => {
		const result = actionSchema.safeParse(value);
		if (!result.success)
			for (const issue of result.error.issues) {
				ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
			}
	});

// The model-actionable errors — each returns text it can retry
// against (the live rev, the refusal reason). Storage failures still
// propagate out of the turn.
function actionable(err: unknown): { error: string; rev?: number } | null {
	if (err instanceof NoteConflictError) {
		return {
			error: `the note is at rev ${err.note.rev} — re-read it and retry`,
			rev: err.note.rev,
		};
	}
	if (err instanceof NoteRangeError) {
		return { error: err.message, rev: err.rev };
	}
	if (err instanceof NoteInputError) {
		return { error: err.message };
	}
	return null;
}

function noteView(n: Note, projects: Pick<ProjectStore, "get">): Record<string, unknown> {
	return {
		id: n.id,
		title: n.title,
		rev: n.rev,
		project: n.projectId === null ? null : (projects.get(n.projectId)?.name ?? n.projectId),
		updated: n.updatedAt,
	};
}

export const noteTool = (deps: NoteToolDeps) =>
	tool({
		description:
			"Notes are the operator's own writing — persistent pages they can watch you edit. Use read before editing. Prefer append or replace_range over replace: replace_range edits by UTF-16 character offsets into the body exactly as read returned it, each guarded by the text currently there; a mismatch means the note changed — read it again. replace requires the rev read returned. `where`/scope \"here\" means this conversation's project (loose notes when unbound).",
		inputSchema: noteInputSchema,
		execute: async (raw) => {
			// A malformed call must come back as tool output the model can
			// fix — a thrown parse error would escape the actionable path.
			const parsed = actionSchema.safeParse(raw);
			if (!parsed.success) {
				const issue = parsed.error.issues[0];
				const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
				return {
					error: `invalid arguments — ${where}${issue?.message ?? "does not match any action"}`,
				};
			}
			const input = parsed.data;
			try {
				switch (input.action) {
					case "list": {
						const project =
							input.scope === "all" ? "all" : (deps.projectId ?? "loose");
						const notes = deps.notes.list({
							project,
							...(input.query !== undefined ? { q: input.query } : {}),
						});
						return {
							scope: project,
							notes: notes.map((s) => ({
								id: s.id,
								title: s.title,
								rev: s.rev,
								project:
									s.projectId === null
										? null
										: (deps.projects.get(s.projectId)?.name ?? s.projectId),
								updated: s.updatedAt,
								preview: s.preview,
							})),
						};
					}
					case "read": {
						const note = deps.notes.get(input.id);
						if (note === null) return { error: `no such note: ${input.id}` };
						return { note: noteView(note, deps.projects), content: noteFence(note) };
					}
					case "create": {
						const projectId = input.where === "loose" ? null : deps.projectId;
						const note = deps.notes.create({
							title: input.title,
							...(input.body !== undefined ? { body: input.body } : {}),
							projectId,
						});
						return { note: noteView(note, deps.projects), created: true };
					}
					case "append": {
						const note = deps.notes.append(input.id, input.text, "agent", deps.conversation);
						return { note: noteView(note, deps.projects) };
					}
					case "replace": {
						const note = deps.notes.write(
							input.id,
							{
								body: input.body,
								...(input.title !== undefined ? { title: input.title } : {}),
							},
							"agent",
							{
								conversation: deps.conversation,
								...(input.rev !== undefined ? { expectedRev: input.rev } : {}),
							},
						);
						return { note: noteView(note, deps.projects) };
					}
					case "replace_range": {
						const note = deps.notes.replaceRanges(input.id, input.edits, deps.conversation);
						return { note: noteView(note, deps.projects) };
					}
				}
			} catch (err) {
				const handled = actionable(err);
				if (handled !== null) return handled;
				throw err;
			}
		},
	});
