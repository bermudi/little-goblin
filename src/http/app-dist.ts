import { existsSync, statSync, type Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
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

// Text formats only: images and fonts are already compressed, so re-encoding
// them burns CPU for no transfer win.
const COMPRESSIBLE = new Set([
	".html",
	".js",
	".mjs",
	".css",
	".map",
	".json",
	".webmanifest",
	".svg",
	".txt",
]);

type Encoding = "br" | "gzip";

// One compressed body per (file, encoding), valid for one file version. The
// stamp is mtime + size from stat, so a rebuilt file is recompressed on its
// next request and an unchanged one is never read or compressed again.
interface CompressedEntry {
	stamp: string;
	bodies: Partial<Record<Encoding, Uint8Array>>;
}
const compressedCache = new Map<string, CompressedEntry>();

function extOf(file: string): string {
	return file.slice(file.lastIndexOf("."));
}

function contentType(file: string): string {
	return CONTENT_TYPES[extOf(file)] ?? "application/octet-stream";
}

function resolveDistFile(rel: string, dist: string): string | null {
	const clean = normalize(rel).replace(/^([/\\])+/, "");
	if (clean === "" || clean.split(/[/\\]/).includes("..")) return null;
	const file = resolve(dist, clean);
	if (!file.startsWith(dist + sep)) return null;
	return file;
}

/** Whether an Accept-Encoding header allows `coding` with a non-zero q-value. */
export function acceptsEncoding(header: string | null, coding: Encoding): boolean {
	if (header === null) return false;
	for (const part of header.split(",")) {
		const [name, ...params] = part.split(";").map((s) => s.trim().toLowerCase());
		if (name !== coding) continue;
		let q = 1;
		for (const param of params) {
			const match = /^q=([\d.]+)$/.exec(param ?? "");
			if (match !== null) q = Number(match[1]);
		}
		if (q > 0) return true;
	}
	return false;
}

/** Brotli preferred over gzip; null when the client takes neither. */
function negotiate(header: string | null): Encoding | null {
	if (acceptsEncoding(header, "br")) return "br";
	if (acceptsEncoding(header, "gzip")) return "gzip";
	return null;
}

async function compressedBody(file: string, stat: Stats, enc: Encoding): Promise<Uint8Array> {
	const stamp = `${stat.mtimeMs}:${stat.size}`;
	let entry = compressedCache.get(file);
	if (entry === undefined || entry.stamp !== stamp) {
		entry = { stamp, bodies: {} };
		compressedCache.set(file, entry);
	}
	const hit = entry.bodies[enc];
	if (hit !== undefined) return hit;
	const raw = await readFile(file);
	const out =
		enc === "br"
			? brotliCompressSync(raw, {
					params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 },
				})
			: gzipSync(raw, { level: 9 });
	entry.bodies[enc] = out;
	log.info("app asset compressed", { file, encoding: enc, raw: raw.length, sent: out.length });
	return out;
}

/**
 * Serves one file of the built client. `acceptEncoding` is the request's
 * Accept-Encoding header; text assets are brotli- or gzip-compressed when the
 * client accepts it, and always carry `Vary: Accept-Encoding` so a shared
 * cache can't hand a compressed body to a client that can't read it.
 */
export async function serveAppDist(
	rel: string,
	dist = APP_DIST,
	acceptEncoding: string | null = null,
): Promise<Response> {
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
		const compressible = COMPRESSIBLE.has(extOf(file));
		const enc = compressible ? negotiate(acceptEncoding) : null;
		const body =
			enc === null ? await readFile(file) : await compressedBody(file, stat, enc);
		const cache = file.endsWith("index.html")
			? "no-store"
			: file.includes(`${sep}assets${sep}`)
				? "public, max-age=31536000, immutable"
				: "no-cache";
		const headers: Record<string, string> = {
			"content-type": contentType(file),
			"cache-control": cache,
		};
		if (compressible) headers.vary = "accept-encoding";
		if (enc !== null) headers["content-encoding"] = enc;
		return new Response(body, { headers });
	} catch (err) {
		log.error("app asset read failed", err, { file });
		return Response.json({ error: "read failed" }, { status: 500 });
	}
}
