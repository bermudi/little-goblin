// Attachments, identity files and the log tail — the http face of
// ../stateview.ts (the skills listing lives with the skills policy
// routes in operator-skills.ts).

import { z } from "zod";
import { paths } from "../config.ts";
import {
	AttachmentTooLargeError,
	identityFiles,
	listAttachments,
	readAttachmentBytes,
	tailLog,
} from "../stateview.ts";
import type { OperatorRequest } from "./operator-deps.ts";
import { fail, json, methodNotAllowed, NO_STORE, SEGMENT_SCHEMA } from "./operator-http.ts";

const ATTACHMENT_SERVE_CAP = 32 * 1024 * 1024;

export async function stateviewRoute(r: OperatorRequest): Promise<Response | null> {
	const { req, tail, url } = r;

	if (tail === "attachments") {
		if (req.method !== "GET") return methodNotAllowed();
		const body = listAttachments(paths.attachments());
		return json(body);
	}

	if (tail === "attachments/file") {
		if (req.method !== "GET") return methodNotAllowed();
		const name = SEGMENT_SCHEMA.safeParse(url.searchParams.get("name") ?? "");
		if (!name.success || name.data.startsWith(".")) return fail("bad name", 400);
		let served: ReturnType<typeof readAttachmentBytes>;
		try {
			served = readAttachmentBytes(paths.attachments(), name.data, ATTACHMENT_SERVE_CAP);
		} catch (e) {
			if (e instanceof AttachmentTooLargeError) {
				return fail("attachment too large", 413);
			}
			throw e;
		}
		if (served === null) return fail("not found", 404);
		const inline = /^(image|audio|video)\//.test(served.contentType);
		return new Response(served.bytes, {
			headers: {
				...NO_STORE,
				"content-type": served.contentType,
				"x-content-type-options": "nosniff",
				"content-security-policy": "sandbox",
				...(inline ? {} : { "content-disposition": "attachment" }),
			},
		});
	}

	if (tail === "identity") {
		if (req.method !== "GET") return methodNotAllowed();
		const body = identityFiles(paths.workspace());
		return json(body);
	}

	if (tail === "log") {
		if (req.method !== "GET") return methodNotAllowed();
		const limitRaw = url.searchParams.get("limit");
		const limit =
			limitRaw === null
				? { success: true as const, data: 200 }
				: z.coerce.number().int().min(1).max(1000).safeParse(limitRaw);
		if (!limit.success) return fail("bad limit", 400);
		const levelRaw = url.searchParams.get("level");
		const level =
			levelRaw === null || levelRaw === ""
				? { success: true as const, data: null }
				: z.enum(["debug", "info", "warn", "error"]).safeParse(levelRaw);
		if (!level.success) return fail("bad level", 400);
		const qRaw = url.searchParams.get("q");
		const q =
			qRaw === null || qRaw === ""
				? { success: true as const, data: null }
				: z.string().max(300).safeParse(qRaw);
		if (!q.success) return fail("bad q", 400);
		const body = tailLog(paths.logFile(), {
			limit: limit.data,
			level: level.data,
			q: q.data,
		});
		return json(body);
	}

	return null;
}
