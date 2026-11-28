import { z } from "zod";
import { defineTool } from "../../tool.ts";
import { NOTE_EDIT_MESSAGE_MAX } from "../../note-edit.ts";
import {
	NOTE_BODY_MAX,
	NoteConflictError,
	NoteInputError,
	type Note,
	NoteRangeError,
	noteFence,
	type NoteStore,
} from "../../notes.ts";
import { LITTLE_GOBLIN_NOTE_OWNER, noteAccess } from "../../note-owner.ts";
import type { ProjectStore } from "../../projects.ts";

export interface NoteToolDeps {
	notes: NoteStore;
	projects: Pick<ProjectStore, "get">;
	conversation: string;
	projectId: string | null;
	editHistory?: boolean;
	ownerScope?: boolean;
}

const listSchema = z.object({
	action: z.literal("list"),
	query: z.string().optional(),
	scope: z.enum(["here", "all"]).optional(),
});
const READ_CHARS = 64_000;
const LIST_LIMIT = 200;

function diffPageBoundary(text: string, offset: number): number {
	if (offset >= text.length) return text.length;
	const previous = text.charCodeAt(offset - 1);
	const next = text.charCodeAt(offset);
	const splitPair = previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
	return splitPair ? offset - 1 : offset;
}

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

const legacyActions = ["list", "read", "create", "append", "replace", "replace_range"] as const;
const legacyInput = z.object({
	action: z.enum(legacyActions),
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
});

const editMessageShape = {
	what: z.string().trim().min(1).max(NOTE_EDIT_MESSAGE_MAX),
	reason: z.string().trim().min(1).max(NOTE_EDIT_MESSAGE_MAX),
};
const editHistorySchema = z.discriminatedUnion("action", [
	listSchema,
	readSchema,
	createSchema.extend(editMessageShape),
	appendSchema.extend(editMessageShape),
	replaceSchema.extend(editMessageShape),
	rangeSchema.extend(editMessageShape),
	z.object({
		action: z.literal("history"),
		id: readSchema.shape.id,
		before: replaceSchema.shape.rev.optional(),
	}),
	z.object({
		action: z.literal("diff"),
		id: readSchema.shape.id,
		rev: replaceSchema.shape.rev,
		offset: readSchema.shape.offset,
	}),
]);

function validateAction(schema: typeof actionSchema | typeof editHistorySchema) {
	return (value: unknown, ctx: z.RefinementCtx) => {
		const result = schema.safeParse(value);
		if (!result.success)
			for (const issue of result.error.issues) {
				ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
			}
	};
}

export const noteInputSchema = legacyInput.superRefine(validateAction(actionSchema));
const noteHistoryInputSchema = legacyInput
	.extend({
		action: z.enum([...legacyActions, "history", "diff"]),
		before: replaceSchema.shape.rev.optional().describe("List edits with revisions below this value"),
		what: editMessageShape.what.optional().describe("Required on edits. Summarize what changed"),
		reason: editMessageShape.reason.optional().describe("Required on edits. Explain why"),
	})
	.superRefine(validateAction(editHistorySchema));

export const NOTE_HISTORY_SOURCE = "note-edit-history";
export const NOTE_HISTORY_DESCRIPTION = " For every write, provide `what` changed and the `reason` for it. Use history with id to see authors and messages; use its before cursor for earlier edits. Use diff with id and rev to read changed text, paging with nextOffset.";
export const NOTE_OWNER_SCOPE_SOURCE = "note-owner-scope";

export function noteOwnerScope(snapshot: { sources: string[] } | null): boolean {
	return snapshot === null || snapshot.sources.includes(NOTE_OWNER_SCOPE_SOURCE);
}

export function noteHistoryAvailable(snapshot: { sources: string[] } | null, kind?: string): boolean {
	return snapshot === null ||
		snapshot.sources.includes(NOTE_HISTORY_SOURCE) ||
		kind === "codex" || kind === "claude-code";
}

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

function ownerFields(
	n: Pick<Note, "projectId" | "botId">,
	deps: NoteToolDeps,
	chatBot: string,
): Record<string, unknown> {
	const owner = deps.notes.ownerName(n);
	return {
		project: n.projectId === null ? null : (deps.projects.get(n.projectId)?.name ?? n.projectId),
		...(owner === null ? {} : { owner }),
		...(noteAccess(n, chatBot) === "read" ? { readOnly: true } : {}),
	};
}

function noteView(n: Note, deps: NoteToolDeps, chatBot: string): Record<string, unknown> {
	return { id: n.id, title: n.title, rev: n.rev, ...ownerFields(n, deps, chatBot), updated: n.updatedAt };
}

function unavailable(id: string): { error: string } {
	return { error: `note ${id} belongs to another bot; this chat can't use it` };
}

export const noteTool = (deps: NoteToolDeps) =>
	defineTool({
		description:
			"Notes are the operator's own writing — persistent pages they can watch you edit. Use read before editing. Prefer append or replace_range over replace: replace_range edits by UTF-16 character offsets into the body exactly as read returned it, each guarded by the text currently there; a mismatch means the note changed — read it again. replace requires the rev read returned. read returns up to 64000 chars of body — page longer notes with offset; replace_range offsets always count into the full body. Bodies cap at 1,000,000 chars — writes past it refuse. Archived notes are read-only." +
			(deps.ownerScope
				? " A new note belongs to this chat's bot. List with scope \"here\" for this bot's notes and Global notes; scope \"all\" includes other owners only if this chat can read them."
				: " `where`/scope \"here\" means this conversation's project (loose notes when unbound).") +
			(deps.editHistory ? NOTE_HISTORY_DESCRIPTION : ""),
		input: deps.editHistory ? noteHistoryInputSchema : noteInputSchema,
		execute: async (raw) => {
			const parsed = (deps.editHistory ? editHistorySchema : actionSchema).safeParse(raw);
			if (!parsed.success) {
				const issue = parsed.error.issues[0];
				const where =
					issue !== undefined && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
				return {
					error: `invalid arguments — ${where}${issue?.message ?? "does not match any action"}`,
				};
			}
			const input = parsed.data;
			const message = "what" in input ? { what: input.what, reason: input.reason } : {};
			const chatBot = deps.notes.chatBot(deps.conversation);
			const blocked = (id: string) => {
				const note = deps.notes.get(id);
				return note !== null && noteAccess(note, chatBot) === "none";
			};
			try {
				switch (input.action) {
					case "list": {
						const project = input.scope === "all" ? "all" : (deps.projectId ?? "loose");
						const rows = deps.notes.list({
							...(chatBot === LITTLE_GOBLIN_NOTE_OWNER ? { project } : { reachableBy: chatBot }),
							includeGlobal: true,
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
								...ownerFields(s, deps, chatBot),
								updated: s.updatedAt,
								preview: s.preview,
							})),
						};
					}
					case "read": {
						const note = deps.notes.get(input.id);
						if (note === null) return { error: `no such note: ${input.id}` };
						if (noteAccess(note, chatBot) === "none") return unavailable(input.id);
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
							note: noteView(note, deps, chatBot),
							content: noteFence({ ...note, body: window }) + footer,
						};
					}
					case "create": {
						const projectId = input.where === "loose" ? null : deps.projectId;
						const note = deps.notes.create(
							{ title: input.title, body: input.body, projectId, conversation: deps.conversation, ...message },
							"agent",
						);
						return { note: noteView(note, deps, chatBot), created: true };
					}
					case "append": {
						const note = deps.notes.append(input.id, input.text, "agent", deps.conversation, message);
						return { note: noteView(note, deps, chatBot) };
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
								...message,
								conversation: deps.conversation,
								expectedRev: input.rev,
							},
						);
						return { note: noteView(note, deps, chatBot) };
					}
					case "replace_range": {
						const note = deps.notes.replaceRanges(input.id, input.edits, deps.conversation, message);
						return { note: noteView(note, deps, chatBot) };
					}
					case "history":
						if (blocked(input.id)) return unavailable(input.id);
						return deps.notes.listEdits(input.id, input.before);
					case "diff": {
						if (blocked(input.id)) return unavailable(input.id);
						const edit = deps.notes.getEdit(input.id, input.rev);
						if (edit === null) return { error: `no recorded edit at rev ${input.rev}` };
						if (edit.body === null) return edit;
						const offset = input.offset ?? 0;
						const length = Math.max(edit.body.before.length, edit.body.after.length);
						if (offset > length) return { error: `offset exceeds diff length (${length} chars)` };
						const end = offset + READ_CHARS / 2;
						const { before, after } = edit.body;
						const beforeOffset = diffPageBoundary(before, offset);
						const afterOffset = diffPageBoundary(after, offset);
						return {
							...edit,
							body: {
								offset: edit.body.offset,
								before: before.slice(beforeOffset, diffPageBoundary(before, end)),
								after: after.slice(afterOffset, diffPageBoundary(after, end)),
							},
							pageOffset: offset,
							beforeOffset,
							afterOffset,
							nextOffset: end < length ? end : null,
						};
					}
				}
			} catch (err) {
				const handled = actionable(err);
				if (handled !== null) return handled;
				throw err;
			}
		},
	});
