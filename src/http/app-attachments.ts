import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { readBodyBytesCapped } from "./check.ts";
import {
	isStoredAttachmentPath,
	persistAttachment,
	type AttachmentRef,
} from "../agent/attachments.ts";
import { paths } from "../config.ts";
import { log } from "../log.ts";
import type { AppAttachmentResponse } from "./app-wire.ts";

import { NO_STORE } from "./app-shared.ts";

import type { AppChannelDeps } from "./app-channel.ts";

// Multipart uploads buffer — cap before formData reads the body, so a
// hostile content-length never reaches memory. 32 MiB covers phone-grade
// photos/video clips; larger belongs to a real upload channel anyway.
const UPLOAD_CAP = 32 * 1024 * 1024;

export async function handleAppAttachmentsRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	const path = url.pathname;
	if (path === "/api/app/attachments") {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		// Bound the wire BEFORE parsing: formData() buffers the whole
		// body in memory, and a chunked upload carries no Content-Length
		// at all — the header check alone would let an unbounded stream
		// OOM the process (one process, the bot dies with it). Copy the
		// stream into a capped buffer (check.ts's shared reader), then
		// parse the form from the bounded copy.
		const bytes = await readBodyBytesCapped(req, UPLOAD_CAP);
		if (bytes === null) {
			return Response.json({ error: "attachment too large" }, { status: 413, headers: NO_STORE });
		}
		// Drop the stale content-length so the rebuilt request's body and
		// header agree; the bounded bytes are the truth now.
		const headers = new Headers(req.headers);
		headers.delete("content-length");
		let form: Awaited<ReturnType<Request["formData"]>>;
		try {
			form = await new Request(req.url, { method: "POST", headers, body: bytes }).formData();
		} catch {
			return Response.json(
				{ error: "expected multipart form" },
				{ status: 400, headers: NO_STORE },
			);
		}
		const file = form.get("file");
		if (typeof file !== "object" || file === null || file.size === 0) {
			return Response.json({ error: "no file in upload" }, { status: 400, headers: NO_STORE });
		}
		if (file.size > UPLOAD_CAP) {
			return Response.json({ error: "attachment too large" }, { status: 413, headers: NO_STORE });
		}
		// Same durable pipeline as telegram media — the saved path is what
		// history's data-attachment part will reference.
		const saved = await persistAttachment(
			`app-${randomUUID()}`,
			file.name || "upload",
			"app",
			async (temp) => {
				await Bun.write(temp, file);
			},
		);
		const ref: AttachmentRef = {
			path: saved.path,
			mediaType: file.type || "application/octet-stream",
			filename: file.name || "upload",
			size: saved.size,
		};
		log.info("app attachment uploaded", {
			filename: ref.filename,
			mediaType: ref.mediaType,
			size: ref.size,
		});
		const body: AppAttachmentResponse = { ref };
		return Response.json(body, { status: 201, headers: NO_STORE });
	}

	// GET /api/app/attachments/<name> — read-back for stored files (image
	// previews in the transcript, click-through to the full file). The
	// segment must be a plain basename inside workspace/attachments/ —
	// isStoredAttachmentPath is the same confinement check intake runs
	// on client-supplied refs. Dotfiles are upload temps; never serve.
	if (path.startsWith("/api/app/attachments/")) {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		let name: string;
		try {
			name = decodeURIComponent(path.slice("/api/app/attachments/".length));
		} catch {
			return Response.json({ error: "bad name" }, { status: 400, headers: NO_STORE });
		}
		const file = join(paths.attachments(), name);
		if (
			name === "" ||
			name.startsWith(".") ||
			basename(name) !== name ||
			!isStoredAttachmentPath(file)
		) {
			return Response.json({ error: "bad name" }, { status: 400, headers: NO_STORE });
		}
		const blob = Bun.file(file);
		if (!(await blob.exists())) {
			return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
		}
		// Saved names carry a uuid stem — the bytes behind a name never
		// change, so the response is immutable-cacheable (private: it's
		// bearer-gated operator content). Uploads are arbitrary bytes —
		// nosniff plus a sandboxed document context keeps them inert, and
		// anything the client doesn't embed inline (non-media types)
		// downloads rather than rendering same-origin.
		const type = blob.type === "" ? "application/octet-stream" : blob.type;
		return new Response(blob, {
			headers: {
				"content-type": type,
				"cache-control": "private, max-age=31536000, immutable",
				"x-content-type-options": "nosniff",
				"content-security-policy": "sandbox",
				...(/^(image|audio|video)\//.test(type) ? {} : { "content-disposition": "attachment" }),
			},
		});
	}

	return null;
}
