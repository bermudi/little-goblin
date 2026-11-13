import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseHTML } from "linkedom";
import { failure, ProbeError, readBounded, result, type HealthResult } from "./shared.ts";

function contained(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function checkAppAssets(checkout: string): HealthResult {
	const start = performance.now();
	const scope = `installed-checkout:${resolve(checkout)}`;
	try {
		const root = resolve(checkout, "app/dist");
		const realRoot = realpathSync(root);
		if (!contained(realpathSync(resolve(checkout)), realRoot)) throw new ProbeError("path-escape");
		const index = join(root, "index.html");
		if (!contained(realRoot, realpathSync(index))) throw new ProbeError("path-escape");
		const html = readBounded(index).text;
		const { document } = parseHTML(html);
		const refs = [
			...document.querySelectorAll(
				"script[src],img[src],source[src],video[src],audio[src],link[href]",
			),
		]
			.filter(
				(tag) =>
					tag.localName !== "link" ||
					/(?:^|\s)(?:stylesheet|modulepreload|preload|icon|manifest)(?:\s|$)/i.test(
						tag.getAttribute("rel") ?? "",
					),
			)
			.map((tag) => tag.getAttribute(tag.localName === "link" ? "href" : "src"));
		if (refs.length > 128) throw new ProbeError("too-many-asset-references");
		let files = 0;
		for (const value of refs) {
			if (!value || value.startsWith("#") || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) continue;
			// URL.pathname stays percent-encoded in the HTTP server, just as in the browser.
			if (value.includes("\0") || value.includes("\\"))
				throw new ProbeError("invalid-asset-reference");
			let path: string;
			try {
				path = new URL(value, "https://doctor.invalid/app/").pathname;
			} catch {
				throw new ProbeError("invalid-asset-reference");
			}
			if (!path.startsWith("/app/")) throw new ProbeError("path-escape");
			const name = path.slice(5);
			const asset = resolve(root, name);
			if (!contained(root, asset) || !contained(realRoot, realpathSync(asset)))
				throw new ProbeError("path-escape");
			// Only presence/readability is needed, not buffering bundle contents.
			const fd = openSync(asset, constants.O_RDONLY | constants.O_NONBLOCK);
			try {
				if (!fstatSync(fd).isFile()) throw new ProbeError("not-regular-file");
				readSync(fd, Buffer.alloc(1), 0, 1, 0);
			} finally {
				closeSync(fd);
			}
			files++;
		}
		if (files === 0 || !/<(?:html|!doctype)\b/i.test(html))
			throw new ProbeError("invalid-asset-index");
		return result(
			"app.assets",
			scope,
			"pass",
			`Index and ${files} referenced local files readable; runtime serving unverified`,
			start,
		);
	} catch (error) {
		return failure("app.assets", scope, error, start, "Read app/dist assets");
	}
}
