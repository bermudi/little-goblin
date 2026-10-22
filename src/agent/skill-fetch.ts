// Temp-skill fetch pipeline (ruling 2026-10-21, design/skills.md →
// Skill invocation): a GitHub skill URL becomes a validated, whole-dir
// copy under state/skillcache/<digest-of-tarball>/ — never a catalog
// entry, never a proposal. Cache, not state: deletable without
// ceremony. The System One injection verdict is scored by the caller
// (the route owns the gate client) and stamped into the descriptor via
// stampVerdict, so the injected preamble quotes what the operator
// confirmed on the preview card.

import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { log } from "../log.ts";
import { durableWriteBytes, durableWriteFile } from "../durable.ts";
import { parseSkill, readHead } from "./skills.ts";
import type { CachedSkillDescriptor } from "../skill-part.ts";
import { paths } from "../config.ts";

// The extraction writes only the subtree; the walk bounds what survives.
export const BODY_MAX_BYTES = 256 * 1024;
export const DIR_MAX_BYTES = 10 * 1024 * 1024;
export const FILES_MAX = 500;
// The tarball is the whole repo — a one-file subtree still downloads
// all of it — so the download cap must clear real repos, not subtrees.
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

// GitHub URL forms (verified against anthropics/skills):
//   github.com/{o}/{r}/tree/{ref}/{dir}             directory
//   github.com/{o}/{r}/blob/{ref}/{path}            file — its parent dir wins
//   github.com/{o}/{r}[/tree/{ref}]                 repo-root skill
//   raw.githubusercontent.com/{o}/{r}/{ref}/{path}  file — parent dir wins
// A slash-bearing ref is ambiguous with the dir path in these URL
// shapes (GitHub disambiguates server-side); we take the first segment
// as the ref, and the tarball 404 names the refusal.
export interface GithubSkillSource {
	owner: string;
	repo: string;
	ref: string;
	/** Directory inside the repo; "" is the repo root. */
	dir: string;
}

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function cleanSegments(path: string): string[] | null {
	const parts = path.split("/").filter((p) => p !== "" && p !== ".");
	if (parts.some((p) => p === ".." || !SEGMENT_RE.test(p))) return null;
	return parts;
}

export function normalizeGithubSkillUrl(raw: string): GithubSkillSource | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	const head = url.pathname.split("#")[0]!.split("?")[0]!;
	const segments = cleanSegments(head);
	if (segments === null || segments.length < 2) return null;
	const [owner, repo] = segments as [string, string];
	const rest = segments.slice(2);

	if (url.host === "github.com") {
		if (rest.length === 0) return { owner, repo, ref: "HEAD", dir: "" };
		const [kind, ref, ...dirParts] = rest;
		if (kind !== "tree" && kind !== "blob") return null;
		if (ref === undefined || !SEGMENT_RE.test(ref)) return null;
		// blob names a file: the skill dir is its parent. tree names the
		// dir itself — but a SKILL.md leaf under tree takes the parent
		// too (GitHub redirects it; operators paste what the browser
		// showed them).
		let dirRest = dirParts;
		if (kind === "blob" || dirParts.at(-1)?.toLowerCase() === "skill.md") {
			if (dirParts.length === 0) return null;
			dirRest = dirParts.slice(0, -1);
		}
		if (dirRest.some((p) => !SEGMENT_RE.test(p))) return null;
		return { owner, repo, ref, dir: dirRest.join("/") };
	}
	if (url.host === "raw.githubusercontent.com") {
		const [ref, ...pathParts] = rest;
		if (ref === undefined || !SEGMENT_RE.test(ref)) return null;
		if (pathParts.length === 0) return null;
		const dirParts = pathParts.slice(0, -1);
		if (dirParts.some((p) => !SEGMENT_RE.test(p))) return null;
		return { owner, repo, ref, dir: dirParts.join("/") };
	}
	return null;
}

export interface FetchedSkill {
	descriptor: CachedSkillDescriptor;
	/** Absolute path of the cached SKILL.md — the part pins this. */
	path: string;
	/** Absolute path of the cached skill dir — the injected preamble names it. */
	dir: string;
	bodyBytes: number;
	fileCount: number;
	dirBytes: number;
	/** Content digest of the tarball — the cache key. */
	digest: string;
	cached: boolean;
}

export interface SkillFetchDeps {
	fetchImpl?: typeof fetch;
	/** Overrides state/skillcache — tests only. */
	cacheRoot?: string;
	now?: () => Date;
}

export class SkillFetchError extends Error {
	constructor(
		message: string,
		readonly status: "unreachable" | "unsupported" | "invalid" | "oversized",
	) {
		super(message);
	}
}

function canonicalSourceUrl(s: GithubSkillSource): string {
	return `https://github.com/${s.owner}/${s.repo}/tree/${s.ref}${s.dir === "" ? "" : `/${s.dir}`}`;
}

export async function fetchSkill(
	rawUrl: string,
	deps: SkillFetchDeps = {},
): Promise<FetchedSkill> {
	const started = Date.now();
	const source = normalizeGithubSkillUrl(rawUrl);
	if (source === null) {
		throw new SkillFetchError(
			"not a recognized GitHub skill URL (tree, blob, raw, or repo root)",
			"unsupported",
		);
	}
	const cacheRoot = deps.cacheRoot ?? paths.skillcache();
	const fetchImpl = deps.fetchImpl ?? fetch;
	const now = deps.now ?? (() => new Date());
	mkdirSync(cacheRoot, { recursive: true });

	const digest = await downloadDigest(source, fetchImpl);
	const finalDir = join(cacheRoot, digest);
	if (statSyncOrNull(finalDir)?.isDirectory() === true) {
		const descriptor = readDescriptor(finalDir);
		if (descriptor !== null) {
			const dir = join(finalDir, descriptor.name);
			const walked = rewalk(dir);
			log.info("skill fetched", {
				url: rawUrl,
				digest,
				name: descriptor.name,
				bodyBytes: walked.bodyBytes,
				cached: true,
				ms: Date.now() - started,
			});
			return { descriptor, path: join(dir, "SKILL.md"), dir, cached: true, ...walked, digest };
		}
		// A published dir without a descriptor is a crash leftover — fall
		// through and re-extract; the rename below lands ENOTEMPTY and
		// keeps the incumbent.
	}

	const extracted = await extract(source, digest, cacheRoot, fetchImpl, now);
	const dir = join(finalDir, extracted.name);
	try {
		renameSync(extracted.stagingDir, finalDir);
	} catch (err) {
		if (
			(err as NodeJS.ErrnoException).code !== "ENOTEMPTY" &&
			(err as NodeJS.ErrnoException).code !== "EEXIST"
		)
			throw err;
		// Lost a publish race with the same tarball — the incumbent wins.
		cachedCleanup(extracted.stagingDir);
	}
	const publishedDescriptor = readDescriptor(finalDir) ?? extracted.descriptor;
	log.info("skill fetched", {
		url: rawUrl,
		digest,
		name: extracted.name,
		bodyBytes: extracted.bodyBytes,
		dirBytes: extracted.dirBytes,
		files: extracted.fileCount,
		cached: publishedDescriptor !== extracted.descriptor,
		ms: Date.now() - started,
	});
	return {
		descriptor: publishedDescriptor,
		path: join(dir, "SKILL.md"),
		dir,
		bodyBytes: extracted.bodyBytes,
		fileCount: extracted.fileCount,
		dirBytes: extracted.dirBytes,
		digest,
		cached: publishedDescriptor !== extracted.descriptor,
	};
}

// Stamp the preview's System One verdict onto the cached copy. The
// descriptor is the only place the verdict lives — the part carries
// just {url, path}, and injection reads what the operator saw.
export function stampVerdict(
	cacheRoot: string,
	digest: string,
	verdict: CachedSkillDescriptor["verdict"],
): CachedSkillDescriptor | null {
	const dir = join(cacheRoot, digest);
	const existing = readDescriptor(dir);
	if (existing === null) return null;
	const stamped: CachedSkillDescriptor = { ...existing, verdict };
	durableWriteFile(join(dir, "skill.json"), JSON.stringify(stamped, null, "\t"));
	return stamped;
}

const descriptorSchema = z.object({
	name: z.string(),
	description: z.string(),
	sourceUrl: z.string(),
	fetchedAt: z.string(),
	verdict: z.object({
		status: z.enum(["clean", "suspicious", "malicious", "unavailable"]),
		injection: z.number().nullable(),
		severity: z.number().nullable(),
	}),
});

export function readDescriptor(dir: string): CachedSkillDescriptor | null {
	try {
		const raw: unknown = JSON.parse(readFileSync(join(dir, "skill.json"), "utf8"));
		const parsed = descriptorSchema.safeParse(raw);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

async function downloadDigest(
	source: GithubSkillSource,
	fetchImpl: typeof fetch,
): Promise<string> {
	const tarballUrl = `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${source.ref}`;
	let response: Response;
	try {
		response = await fetchImpl(tarballUrl, { redirect: "follow" });
	} catch (err) {
		throw new SkillFetchError(`tarball fetch failed: ${stringify(err)}`, "unreachable");
	}
	if (!response.ok) {
		throw new SkillFetchError(
			`tarball fetch returned ${response.status} for ${source.owner}/${source.repo}@${source.ref}` +
				(source.ref.includes("/")
					? " (slash-bearing refs are ambiguous in tree/blob URLs — paste the raw.githubusercontent form)"
					: ""),
			response.status === 404 ? "invalid" : "unreachable",
		);
	}
	return createHash("sha256").update(await sizeCapped(response, DOWNLOAD_MAX_BYTES)).digest("hex");
}

async function extract(
	source: GithubSkillSource,
	digest: string,
	cacheRoot: string,
	fetchImpl: typeof fetch,
	now: () => Date,
): Promise<{ stagingDir: string; descriptor: CachedSkillDescriptor } & Walked & { name: string }> {
	const tarballUrl = `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${source.ref}`;
	const stagingRoot = mkdtempSync(join(cacheRoot, ".fetch-"));
	try {
		const response = await fetchImpl(tarballUrl, { redirect: "follow" });
		if (!response.ok) {
			throw new SkillFetchError(`tarball fetch returned ${response.status}`, "unreachable");
		}
		const ballPath = join(stagingRoot, "ball.tgz");
		durableWriteBytes(ballPath, await sizeCapped(response, DOWNLOAD_MAX_BYTES));

		// Extract only the subtree — the tarball carries the whole repo.
		// A named directory member extracts recursively; no wildcards.
		const extractDir = join(stagingRoot, "x");
		mkdirSync(extractDir);
		const member = source.dir === "" ? `${source.repo}-${source.ref}` : `${source.repo}-${source.ref}/${source.dir}`;
		const tar = Bun.spawn(
			["tar", "-xzf", ballPath, "-C", extractDir, "--no-same-owner", "--no-same-permissions", member],
			{ stdout: "ignore", stderr: "pipe" },
		);
		const stderr = await new Response(tar.stderr).text();
		const code = await tar.exited;
		if (code !== 0) {
			throw new SkillFetchError(
				`skill directory ${source.dir === "" ? "(repo root)" : source.dir} not found in ${source.owner}/${source.repo}@${source.ref}` +
					(code === 2 && stderr.trim() ? ` (tar: ${stderr.trim().slice(0, 200)})` : ""),
				"invalid",
			);
		}

		const subtree = realpathSync(join(extractDir, `${source.repo}-${source.ref}`, source.dir === "" ? "." : source.dir));
		const realRoot = realpathSync(extractDir);
		if (!subtree.startsWith(realRoot + "/")) {
			throw new SkillFetchError("extracted skill dir escaped the extraction root", "invalid");
		}
		const walked = walkSubtree(subtree);

		const skillMd = join(subtree, "SKILL.md");
		const parsed = parseSkill(readHead(skillMd));
		if ("err" in parsed) {
			throw new SkillFetchError(`invalid SKILL.md frontmatter: ${parsed.err}`, "invalid");
		}
		// Spec rule: the name matches the directory — for a repo-root
		// skill, the repo itself is that directory.
		const expectedName = source.dir === "" ? source.repo : basename(source.dir);
		if (parsed.fm.name !== expectedName) {
			throw new SkillFetchError(
				`skill name "${parsed.fm.name}" does not match directory "${expectedName}"`,
				"invalid",
			);
		}
		const bodyBytes = statSync(skillMd).size;
		if (bodyBytes > BODY_MAX_BYTES) {
			throw new SkillFetchError(
				`SKILL.md is ${bodyBytes} bytes — over the ${BODY_MAX_BYTES} temp-skill cap`,
				"oversized",
			);
		}

		// Publish layout: <staging>/<name>/** + <staging>/skill.json.
		const stagingDir = join(stagingRoot, "publish");
		renameSync(subtree, stagingDir);
		rmSync(extractDir, { recursive: true, force: true });
		const descriptor: CachedSkillDescriptor = {
			name: parsed.fm.name,
			description: parsed.fm.description,
			sourceUrl: canonicalSourceUrl(source),
			fetchedAt: now().toISOString(),
			// The route scores and stamps after validation; until then the
			// verdict is unavailable and the view refuses injection.
			verdict: { status: "unavailable", injection: null, severity: null },
		};
		durableWriteFile(join(stagingRoot, "skill.json"), JSON.stringify(descriptor, null, "\t"));
		return { stagingDir, descriptor, name: parsed.fm.name, ...walked };
	} catch (err) {
		rmSync(stagingRoot, { recursive: true, force: true });
		if (err instanceof SkillFetchError) {
			log.warn("skill fetch rejected", { url: tarballUrl, reason: err.message });
		}
		throw err;
	}
}

interface Walked {
	bodyBytes: number;
	fileCount: number;
	dirBytes: number;
}

// Re-read a published dir for the cached=true path — same bounds, so a
// tampered-with cache fails loudly instead of injecting oversize bytes.
function rewalk(dir: string): Walked {
	const walked = walkSubtree(realpathSync(dir));
	if (walked.bodyBytes > BODY_MAX_BYTES || walked.fileCount > FILES_MAX || walked.dirBytes > DIR_MAX_BYTES) {
		throw new SkillFetchError("cached skill no longer within caps", "oversized");
	}
	return walked;
}

// Regular files and real directories only — a symlink (or worse) inside
// a fetched skill is refused, matching the catalog's links-are-
// second-class rule; the staging move must not carry links anywhere.
function walkSubtree(root: string): Walked {
	let bodyBytes = 0;
	let fileCount = 0;
	let dirBytes = 0;
	const visit = (path: string): void => {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink()) {
			throw new SkillFetchError(`symlink inside fetched skill: ${basename(path)}`, "invalid");
		}
		if (stats.isDirectory()) {
			for (const entry of readdirSync(path)) visit(join(path, entry));
			return;
		}
		if (!stats.isFile()) {
			throw new SkillFetchError(`non-regular file inside fetched skill: ${basename(path)}`, "invalid");
		}
		fileCount++;
		dirBytes += stats.size;
		if (fileCount > FILES_MAX) {
			throw new SkillFetchError(`skill has over ${FILES_MAX} files`, "oversized");
		}
		if (dirBytes > DIR_MAX_BYTES) {
			throw new SkillFetchError(`skill dir is over ${DIR_MAX_BYTES} bytes`, "oversized");
		}
		if (basename(path) === "SKILL.md") bodyBytes = stats.size;
	};
	visit(root);
	if (bodyBytes === 0) throw new SkillFetchError("no SKILL.md in the skill directory", "invalid");
	return { bodyBytes, fileCount, dirBytes };
}

async function sizeCapped(response: Response, cap: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of response.body ?? []) {
		const bytes = chunk as Uint8Array;
		total += bytes.length;
		if (total > cap) {
			await response.body?.cancel();
			throw new SkillFetchError(`download exceeds the ${cap}-byte cap`, "oversized");
		}
		chunks.push(bytes);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

function statSyncOrNull(path: string): ReturnType<typeof statSync> | null {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

function cachedCleanup(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true });
	} catch (err) {
		log.warn("skill fetch staging cleanup failed", { path, error: stringify(err) });
	}
}

function stringify(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
