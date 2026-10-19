import { tool } from "ai";
import { z } from "zod";
import {
	NOTE_BODY_MAX,
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
	conversation: string;
	projectId: string | null;
}

const listSchema = z.object({
	action: z.literal("list"),
	query: z.string().optional(),
	scope: z.enum(["here", "all"]).optional(),
});
const READ_CHARS = 64_000;
const LIST_LIMIT = 200;
const readSchema = z.object({
	action: z.literal("read"),
	id: z.string().min(1),
	offset: z.number().int().min(0).optional(),
});
const createSchema = z.object({
	action: z.literal("create"),
	title: z.string().min(1).max(200),
	body: z.string().max(NOTE_BODY_MAX).optional(),
	where: z.enum(["here", "loose"]).optional(),
});
const appendSchema = z.object({
	action: z.literal("append"),
	id: z.string().min(1),
	text: z.string().min(1).max(NOTE_BODY_MAX),
});
const replaceSchema = z.object({
	action: z.literal("replace"),
	id: z.string().min(1),
	body: z.string().max(NOTE_BODY_MAX),
	title: z.string().min(1).max(200).optional(),
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
				expected: z.string().max(NOTE_BODY_MAX),
				text: z.string().max(NOTE_BODY_MAX),
			}),
		)
		.min(1)
		.max(500),
});
const actionSchema = z.discriminatedUnion("action", [
	listSchema,
	readSchema,
	createSchema,
	appendSchema,
	replaceSchema,
	rangeSchema,
]);

export const noteInputSchema = z
	.object({
		action: z.enum(["list", "read", "create", "append", "replace", "replace_range"]),
		query: z.string().optional(),
		scope: z.enum(["here", "all"]).optional(),
		id: z.string().optional(),
		offset: z.number().int().min(0).optional(),
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
			"Notes are the operator's own writing — persistent pages they can watch you edit. Use read before editing. Prefer append or replace_range over replace: replace_range edits by UTF-16 character offsets into the body exactly as read returned it, each guarded by the text currently there; a mismatch means the note changed — read it again. replace requires the rev read returned. read returns up to 64000 chars of body — page longer notes with offset; replace_range offsets always count into the full body. Bodies cap at 1,000,000 chars — writes past it refuse. Archived notes are read-only. `where`/scope \"here\" means this conversation's project (loose notes when unbound).",
		inputSchema: noteInputSchema,
		execute: async (raw) => {
			const parsed = actionSchema.safeParse(raw);
			if (!parsed.success) {
				const issue = parsed.error.issues[0];
				const where =
					issue !== undefined && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
				return {
					error: `invalid arguments — ${where}${issue?.message ?? "does not match any action"}`,
				};
			}
			const input = parsed.data;
			try {
				switch (input.action) {
					case "list": {
						const project = input.scope === "all" ? "all" : (deps.projectId ?? "loose");
						const rows = deps.notes.list({
							project,
							...(input.query !== undefined ? { q: input.query } : {}),
							limit: LIST_LIMIT + 1,
						});
						const notes = rows.slice(0, LIST_LIMIT);
						return {
							scope: project,
							...(rows.length > LIST_LIMIT ? { truncated: true } : {}),
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
						const offset = input.offset ?? 0;
						if (offset > note.body.length) {
							return {
								error: `offset ${offset} is beyond end of note (${note.body.length} chars)`,
							};
						}
						const window = note.body.slice(offset, offset + READ_CHARS);
						const end = offset + window.length;
						const footer =
							`\n[Showing chars ${offset}–${end} of ${note.body.length}.` +
							(end < note.body.length ? ` Read again with offset=${end} to continue.` : "") +
							` replace_range start/end are absolute character offsets into the full body — a character at position p in this window sits at offset ${offset} + p.]`;
						return {
							note: noteView(note, deps.projects),
							content: noteFence({ ...note, body: window }) + footer,
						};
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
