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

function resolveDistFile(rel: string, dist: string): string | null {
	const clean = normalize(rel).replace(/^([/\\])+/, "");
	if (clean === "" || clean.split(/[/\\]/).includes("..")) return null;
	const file = resolve(dist, clean);
	if (!file.startsWith(dist + sep)) return null;
	return file;
}

export async function serveAppDist(rel: string, dist = APP_DIST): Promise<Response> {
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
