// Stamps the built sw.js with the offline shell's precache manifest —
// every dist file's /app/ URL plus a content hash that names the cache.
// Called by the vite plugin in vite.config.ts (closeBundle, build only);
// an unbuilt sw.js keeps `SHELL = null` and caches nothing.
//
// The marker must occur exactly once — zero means the worker source
// drifted, twice means it would stamp half of them. Both fail the build
// loud, never silently ship a shell-less worker.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { durableWriteFile } from "../src/durable.ts";

const MARKER = "const SHELL = null; // replaced at build: { build, files }";

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (entry.isFile()) out.push(path);
	}
	return out;
}

export function injectPrecache(distDir: string): { build: string; files: string[] } {
	const relpaths = walk(distDir)
		.map((path) => relative(distDir, path).split(sep).join("/"))
		.filter((rel) => rel !== "sw.js" && !rel.endsWith(".map") && !rel.startsWith(".vite/"))
		.sort();

	const hash = createHash("sha256");
	for (const rel of relpaths) {
		hash.update(rel);
		hash.update("\0");
		hash.update(readFileSync(join(distDir, rel)));
		hash.update("\0");
	}
	const build = hash.digest("hex").slice(0, 16);
	const files = relpaths.map((rel) => `/app/${rel}`);

	const swPath = join(distDir, "sw.js");
	const source = readFileSync(swPath, "utf8");
	const occurrences = source.split(MARKER).length - 1;
	if (occurrences !== 1)
		throw new Error(`sw.js precache marker found ${occurrences} times, expected exactly 1`);
	const stamped = source.replace(
		MARKER,
		`const SHELL = ${JSON.stringify({ build, files })};`,
	);
	// durableWriteFile keeps the existing file's mode.
	durableWriteFile(swPath, stamped);
	return { build, files };
}
