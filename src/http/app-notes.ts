import { z } from "zod";
import { log } from "../log.ts";
import {
	NOTE_BODY_MAX,
	type Note,
	NoteConflictError,
	NoteInputError,
	NoteRangeError,
	type NoteStore,
} from "../notes.ts";
import { type AppChannelDeps, jsonBodyRefusal, NO_STORE } from "./app-shared.ts";
import type {
	AppNote,
	AppNoteList,
	AppNoteRewriteResponse,
	AppNoteSummary,
	AppNoteVersion,
	AppNoteVersionList,
} from "./app-wire.ts";

const noteCreateBody = z.object({
	title: z.string().trim().min(1).max(200),
	body: z.string().max(NOTE_BODY_MAX).optional(),
	projectId: z.string().min(1).nullish(),
});

const notePatchBody = z
	.object({
		title: z.string().trim().min(1).max(200).optional(),
		body: z.string().optional(),
		projectId: z.string().min(1).nullable().optional(),
		pinned: z.boolean().optional(),
		archived: z.boolean().optional(),
		source: z.enum(["app", "rewrite"]).optional(),
	})
	.strict()
	.refine(
		(p) =>
			p.title !== undefined ||
			p.body !== undefined ||
			p.projectId !== undefined ||
			p.pinned !== undefined ||
			p.archived !== undefined,
		{ message: "nothing to write" },
	);

const noteAppendBody = z.object({ text: z.string().min(1).max(NOTE_BODY_MAX) });

const NOTE_LIST_LIMIT = 1000;

const noteRewriteBody = z
	.object({
		selection: z
			.string()
			.min(1)
			.max(50_000)
			.refine((s) => s.trim() !== "", { message: "selection is empty" }),
		instruction: z.string().trim().min(1).max(2_000),
	})
	.strict();

function appNote(n: Note): AppNote {
	return {
		id: n.id,
		projectId: n.projectId,
		title: n.title,
		body: n.body,
		rev: n.rev,
		stateRev: n.stateRev,
		lastSource: n.lastSource,
		pinnedAt: n.pinnedAt,
		archivedAt: n.archivedAt,
		createdAt: n.createdAt,
		updatedAt: n.updatedAt,
	};
}

function appNoteSummary(s: ReturnType<NoteStore["list"]>[number]): AppNoteSummary {
	return {
		id: s.id,
		projectId: s.projectId,
		title: s.title,
		rev: s.rev,
		stateRev: s.stateRev,
		pinnedAt: s.pinnedAt,
		archivedAt: s.archivedAt,
		updatedAt: s.updatedAt,
		preview: s.preview,
	};
}

function noteResponse(n: Note, status = 200): Response {
	return Response.json(appNote(n), {
		status,
		headers: { ...NO_STORE, etag: `"${n.rev}"` },
	});
}

function noteError(err: unknown): Response | null {
	if (err instanceof NoteConflictError) {
		return Response.json(
			{ error: err.message, note: appNote(err.note) },
			{ status: 409, headers: { ...NO_STORE, etag: `"${err.note.rev}"` } },
		);
	}
	if (err instanceof NoteInputError || err instanceof NoteRangeError) {
		return Response.json({ error: err.message }, { status: 422, headers: NO_STORE });
	}
	return null;
}

function ifMatchRev(req: Request): number | null {
	const header = req.headers.get("if-match");
	if (header === null) return null;
	const m = header.trim().match(/^(?:W\/)?"(\d+)"$/);
	if (m === null) return null;
	const rev = Number.parseInt(m[1]!, 10);
	return Number.isSafeInteger(rev) ? rev : null;
}

export async function handleNotesRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	const path = url.pathname;

	if (path === "/api/app/notes") {
		if (req.method === "GET") {
			const projectParam = url.searchParams.get("project");
			const project =
				projectParam === null || projectParam === "all"
					? "all"
					: projectParam === "loose"
						? "loose"
						: projectParam;
			const q = url.searchParams.get("q");
			const archivedOnly = url.searchParams.get("archived") === "1";
			const rows = deps.notes.list({
				project,
				...(q !== null && q !== "" ? { q } : {}),
				...(archivedOnly ? { archived: true } : {}),
				limit: NOTE_LIST_LIMIT + 1,
			});
			const truncated = rows.length > NOTE_LIST_LIMIT;
			if (truncated) {
				log.warn("app note list truncated", {
					project,
					q: q ?? null,
					archived: archivedOnly,
				});
			}
			const body: AppNoteList = {
				notes: rows.slice(0, NOTE_LIST_LIMIT).map(appNoteSummary),
				truncated,
			};
			return Response.json(body, { headers: NO_STORE });
		}
		if (req.method === "POST") {
			const refusedJson = jsonBodyRefusal(req);
			if (refusedJson !== null) return refusedJson;
			let json: unknown;
			try {
				json = await req.json();
			} catch {
				return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
			}
			const parsed = noteCreateBody.safeParse(json);
			if (!parsed.success) {
				return Response.json(
					{ error: z.prettifyError(parsed.error) },
					{ status: 422, headers: NO_STORE },
				);
			}
			try {
				const note = deps.notes.create(parsed.data);
				return noteResponse(note, 201);
			} catch (err) {
				const res = noteError(err);
				if (res !== null) return res;
				throw err;
			}
		}
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}

	const noteRewriteMatch = path.match(/^\/api\/app\/notes\/([^/]+)\/rewrite$/);
	if (noteRewriteMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		if (deps.rewriteNote === undefined) {
			return Response.json({ error: "rewrite unavailable" }, { status: 503, headers: NO_STORE });
		}
		const refusedJson = jsonBodyRefusal(req);
		if (refusedJson !== null) return refusedJson;
		let json: unknown;
		try {
			json = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
		}
		const parsed = noteRewriteBody.safeParse(json);
		if (!parsed.success) {
			return Response.json(
				{ error: z.prettifyError(parsed.error) },
				{ status: 422, headers: NO_STORE },
			);
		}
		const note = deps.notes.get(noteRewriteMatch[1]!);
		if (note === null) {
			return Response.json({ error: "no such note" }, { status: 404, headers: NO_STORE });
		}
		if (note.archivedAt !== null) {
			return noteError(new NoteInputError("note is archived"))!;
		}
		const replacement = await deps.rewriteNote(note.id, parsed.data, req.signal);
		return Response.json({ replacement } satisfies AppNoteRewriteResponse, {
			headers: NO_STORE,
		});
	}

	const noteRestoreMatch = path.match(/^\/api\/app\/notes\/([^/]+)\/versions\/(\d+)\/restore$/);
	if (noteRestoreMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const expectedRev = ifMatchRev(req);
		if (expectedRev === null) {
			return Response.json(
				{ error: "If-Match required for restore" },
				{ status: 428, headers: NO_STORE },
			);
		}
		try {
			const note = deps.notes.restore(
				noteRestoreMatch[1]!,
				Number.parseInt(noteRestoreMatch[2]!, 10),
				expectedRev,
			);
			return noteResponse(note);
		} catch (err) {
			const res = noteError(err);
			if (res !== null) return res;
			throw err;
		}
	}

	const noteVersionMatch = path.match(/^\/api\/app\/notes\/([^/]+)\/versions\/(\d+)$/);
	if (noteVersionMatch) {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		try {
			const version = deps.notes.getVersion(
				noteVersionMatch[1]!,
				Number.parseInt(noteVersionMatch[2]!, 10),
			);
			if (version === null) {
				return Response.json({ error: "no such version" }, { status: 404, headers: NO_STORE });
			}
			const body: AppNoteVersion = version;
			return Response.json(body, { headers: NO_STORE });
		} catch (err) {
			const res = noteError(err);
			if (res !== null) return res;
			throw err;
		}
	}

	const noteVersionsMatch = path.match(/^\/api\/app\/notes\/([^/]+)\/versions$/);
	if (noteVersionsMatch) {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		try {
			const body: AppNoteVersionList = {
				versions: deps.notes.listVersions(noteVersionsMatch[1]!),
			};
			return Response.json(body, { headers: NO_STORE });
		} catch (err) {
			const res = noteError(err);
			if (res !== null) return res;
			throw err;
		}
	}

	const noteAppendMatch = path.match(/^\/api\/app\/notes\/([^/]+)\/append$/);
	if (noteAppendMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const refusedJson = jsonBodyRefusal(req);
		if (refusedJson !== null) return refusedJson;
		let json: unknown;
		try {
			json = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
		}
		const parsed = noteAppendBody.safeParse(json);
		if (!parsed.success) {
			return Response.json(
				{ error: z.prettifyError(parsed.error) },
				{ status: 422, headers: NO_STORE },
			);
		}
		try {
			const note = deps.notes.append(noteAppendMatch[1]!, parsed.data.text, "append");
			return noteResponse(note);
		} catch (err) {
			const res = noteError(err);
			if (res !== null) return res;
			throw err;
		}
	}

	const noteMatch = path.match(/^\/api\/app\/notes\/([^/]+)$/);
	if (noteMatch) {
		const noteId = noteMatch[1]!;
		if (req.method === "GET") {
			const note = deps.notes.get(noteId);
			if (note === null) {
				return Response.json({ error: "no such note" }, { status: 404, headers: NO_STORE });
			}
			return noteResponse(note);
		}
		if (req.method === "DELETE") {
			try {
				deps.notes.delete(noteId);
				return Response.json({ ok: true }, { headers: NO_STORE });
			} catch (err) {
				const res = noteError(err);
				if (res !== null) return res;
				throw err;
			}
		}
		if (req.method !== "PATCH") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const refusedJson = jsonBodyRefusal(req);
		if (refusedJson !== null) return refusedJson;
		let json: unknown;
		try {
			json = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
		}
		const parsed = notePatchBody.safeParse(json);
		if (!parsed.success) {
			return Response.json(
				{ error: z.prettifyError(parsed.error) },
				{ status: 422, headers: NO_STORE },
			);
		}
		const note = deps.notes.get(noteId);
		if (note === null) {
			return Response.json({ error: "no such note" }, { status: 404, headers: NO_STORE });
		}
		const patch = parsed.data;
		const wantsContent = patch.title !== undefined || patch.body !== undefined;
		let expectedRev: number | undefined;
		if (wantsContent) {
			const rev = ifMatchRev(req);
			if (rev === null) {
				return Response.json(
					{ error: "If-Match required for content writes" },
					{ status: 428, headers: NO_STORE },
				);
			}
			if (rev !== note.rev) {
				return noteError(new NoteConflictError(note))!;
			}
			expectedRev = rev;
			if (note.archivedAt !== null) {
				return noteError(new NoteInputError("note is archived"))!;
			}
		}
		try {
			const updated = deps.notes.patch(noteId, parsed.data, parsed.data.source ?? "app", {
				expectedRev,
			});
			return noteResponse(updated);
		} catch (err) {
			const res = noteError(err);
			if (res !== null) return res;
			throw err;
		}
	}

	return null;
}
