// Serving the app channel's built client (app/dist) under /app/.
// Files resolve per request so a rebuild lands without a restart; a
// missing build answers 500 with a log line — never a silent empty page.
// The page itself is public like the mini app's; every byte of real
// state rides behind /api/app/* bearer auth.

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import { log } from "../log.ts";

const APP_DIST = join(import.meta.dir, "..", "..", "app", "dist");

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

function contentType(file: string): string {
	const dot = file.lastIndexOf(".");
	return CONTENT_TYPES[file.slice(dot)] ?? "application/octet-stream";
}

// rel is the path under /app/ — "index.html" for the root. Returns null
// for traversal attempts and anything that escapes the dist dir.
function resolveDistFile(rel: string, dist: string): string | null {
	const clean = normalize(rel).replace(/^([/\\])+/, "");
	if (clean === "" || clean.split(/[/\\]/).includes("..")) return null;
	const file = resolve(dist, clean);
	if (!file.startsWith(dist + sep)) return null;
	return file;
}

export async function serveAppDist(rel: string, dist = APP_DIST): Promise<Response> {
	// A missing build is a loud 500 — the operator needs to know the
	// channel's client isn't built, not stare at a blank page.
	if (!existsSync(dist)) {
		log.error("app client build missing — run bun run app:build", undefined, { dir: dist });
		return Response.json(
			{ error: "app client not built — run bun run app:build" },
			{ status: 500 },
		);
	}
	const file = resolveDistFile(rel === "" ? "index.html" : rel, dist);
	if (file === null) {
		return Response.json({ error: "not found" }, { status: 404 });
	}
	let stat;
	try {
		stat = statSync(file);
	} catch {
		return Response.json({ error: "not found" }, { status: 404 });
	}
	if (!stat.isFile()) {
		return Response.json({ error: "not found" }, { status: 404 });
	}
	try {
		const body = await readFile(file);
		// index.html is served no-store like the mini app's page — a cached
		// shell referencing stale hashed assets is a silent break. The
		// hashed assets themselves are immutable.
		const cache = file.endsWith("index.html")
			? "no-store"
			: file.includes(`${sep}assets${sep}`)
				? "public, max-age=31536000, immutable"
				: "no-cache";
		return new Response(body, {
			headers: { "content-type": contentType(file), "cache-control": cache },
		});
	} catch (err) {
		log.error("app asset read failed", err, { file });
		return Response.json({ error: "read failed" }, { status: 500 });
	}
}
